import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import {
  initDb,
  hasDb,
  getSetting,
  setSetting,
  tryAdvisoryLock,
  insertLearningEvent,
  getStrategyAccuracy,
  logBotDecision,
  getDueDecisions,
  markDecisionEvaluated,
  getLearningSummary,
  ensureBotAccounts,
  getBotAccounts,
  getBotPositions,
  recordTrade,
  upsertUniverseSymbols,
  universeCount,
  universeSample,
  dbListTables,
  dbDecisionCounts,
  dbRecentDecisions
} from "./db.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const APP_VERSION = "arena-runner-universe-v1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* ---------------- Learning Speed ---------------- */

function normalizeSpeed(v) {
  const x = String(v || "").toLowerCase().trim();
  if (x === "accelerated" || x === "fast" || x === "preview") return "accelerated";
  return "realtime";
}

async function getLearningSpeed() {
  if (!hasDb()) return "realtime";
  const v = await getSetting("learning_speed", "realtime");
  return normalizeSpeed(v);
}

function horizonsForSpeed(speed) {
  if (speed === "accelerated") {
    return {
      shortSec: 5 * 60,
      mediumSec: 30 * 60,
      longSec: 2 * 60 * 60
    };
  }
  return {
    shortSec: 4 * 60 * 60,
    mediumSec: 3 * 24 * 60 * 60,
    longSec: 14 * 24 * 60 * 60
  };
}

/* ---------------- External Data ---------------- */

async function finnhubQuote(symbol) {
  if (!process.env.FINNHUB_API_KEY) throw new Error("FINNHUB_API_KEY missing");
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${process.env.FINNHUB_API_KEY}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(`Finnhub error: ${r.status}`);
  return { price: j.c, changePercent: j.dp, change: j.d };
}

// Finnhub stock symbols (universe list)
async function finnhubSymbols(exchange = "US") {
  if (!process.env.FINNHUB_API_KEY) throw new Error("FINNHUB_API_KEY missing");
  const url = `https://finnhub.io/api/v1/stock/symbol?exchange=${encodeURIComponent(exchange)}&token=${process.env.FINNHUB_API_KEY}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(`Finnhub symbols error: ${r.status}`);
  if (!Array.isArray(j)) throw new Error("Finnhub symbols: unexpected response");
  return j;
}

function sentimentScore(text) {
  const pos = ["surge","growth","profit","beat","strong","record","upgrade","bullish","gain","rise"];
  const neg = ["drop","loss","miss","weak","concern","downgrade","bearish","fall","decline"];
  const t = (text || "").toLowerCase();
  let s = 0;
  pos.forEach(w => { if (t.includes(w)) s += 0.1; });
  neg.forEach(w => { if (t.includes(w)) s -= 0.1; });
  return Math.max(-1, Math.min(1, s));
}

async function newsFor(symbol) {
  if (!process.env.NEWS_API_KEY) throw new Error("NEWS_API_KEY missing");
  const today = new Date();
  const weekAgo = new Date(Date.now() - 7 * 864e5);
  const to = today.toISOString().slice(0, 10);
  const from = weekAgo.toISOString().slice(0, 10);

  // If your provider is not newsapi.org, replace this URL accordingly.
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(symbol)}&from=${from}&to=${to}&sortBy=relevancy&apiKey=${process.env.NEWS_API_KEY}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(`NewsAPI error: ${r.status}`);

  return (j.articles || []).slice(0, 8).map(a => ({
    title: a.title,
    description: a.description,
    url: a.url,
    publishedAt: a.publishedAt,
    source: a.source?.name || "Unknown",
    sentiment: sentimentScore(`${a.title || ""} ${a.description || ""}`)
  }));
}

/* ---------------- Learning Evaluation ---------------- */

async function evaluateDueDecisions(limit = 25) {
  if (!hasDb()) return { evaluated: 0, stored: 0, reason: "no_db" };

  let due = [];
  try {
    due = await getDueDecisions(limit);
  } catch (e) {
    return { evaluated: 0, stored: 0, reason: `db_unavailable: ${e.message}` };
  }

  let evaluated = 0;
  let stored = 0;

  for (const d of due) {
    try {
      const q = await finnhubQuote(d.symbol);
      const updated = await markDecisionEvaluated({ id: d.id, priceAfter: q.price });
      evaluated += 1;

      if (updated && typeof updated.price_after === "number") {
        await insertLearningEvent({
          symbol: updated.symbol,
          strategy: updated.strategy,
          horizon: updated.horizon,
          signal: updated.signal,
          priceAtSignal: updated.price_at_signal,
          priceAfter: updated.price_after
        });
        stored += 1;
      }
    } catch {
      // never crash the service
    }
  }

  return { evaluated, stored };
}

/* ---------------- Bot Logic ---------------- */

function computeFeatures(quote, news) {
  const avgSent = news.length ? (news.reduce((a, n) => a + (n.sentiment || 0), 0) / news.length) : 0;
  return { avgSent, changePercent: quote.changePercent || 0 };
}

function botSignal(strategy, features) {
  const { avgSent, changePercent } = features;

  if (strategy === "sp500_long") {
    if (avgSent > 0.15) return { signal: "BUY", horizon: "long", rationale: "Positive news sentiment; long horizon" };
    if (avgSent < -0.15) return { signal: "SELL", horizon: "long", rationale: "Negative news sentiment; long horizon" };
    return { signal: "HOLD", horizon: "long", rationale: "Mixed sentiment; long horizon" };
  }

  if (strategy === "market_swing") {
    if (avgSent > 0.1 && changePercent > 0) return { signal: "BUY", horizon: "medium", rationale: "Sentiment + momentum aligned" };
    if (avgSent < -0.1 && changePercent < 0) return { signal: "SELL", horizon: "medium", rationale: "Negative sentiment + down move" };
    return { signal: "HOLD", horizon: "medium", rationale: "No clear swing setup" };
  }

  // day_trade
  if (changePercent > 1.2) return { signal: "BUY", horizon: "short", rationale: "Strong intraday move" };
  if (changePercent < -1.2) return { signal: "SELL", horizon: "short", rationale: "Sharp intraday drop" };
  return { signal: "HOLD", horizon: "short", rationale: "Noise range" };
}

function buyBudgetPct(strategy) {
  if (strategy === "day_trade") return 0.30;
  if (strategy === "market_swing") return 0.20;
  return 0.15;
}

async function scoreBots(symbol, bots) {
  const scored = [];

  for (const b of bots) {
    let stats = { samples: 0, accuracy: 0 };
    try {
      stats = await getStrategyAccuracy({ symbol, strategy: b.strategy, horizon: b.horizon, limit: 50 });
    } catch {
      stats = { samples: 0, accuracy: 0 };
    }
    const historical = stats.samples ? stats.accuracy : 50;
    const confidence = Math.round(0.6 * b.baseConfidence + 0.4 * historical);
    scored.push({ ...b, historicalAccuracy: historical, samples: stats.samples, confidence });
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  return { bots: scored, winner: scored[0]?.strategy || null };
}

/* ---------------- Separate Endpoint: Universe Scan ----------------
   This endpoint exists so the UI never has to do “market scanning”.
   It ranks candidates and returns the best symbols to trade next.
*/

function safeInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

app.get("/api/universe/refresh", async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ error: "DATABASE_URL missing" });

    const exchange = String(req.query.exchange || process.env.UNIVERSE_EXCHANGE || "US").toUpperCase();
    const symbols = await finnhubSymbols(exchange);

    // keep only usable symbols
    const filtered = symbols
      .filter(s => s && s.symbol && typeof s.symbol === "string")
      .map(s => ({
        symbol: s.symbol.toUpperCase(),
        description: s.description || null,
        type: s.type || null,
        currency: s.currency || null,
        mic: s.mic || null
      }));

    const result = await upsertUniverseSymbols(exchange, filtered);
    await setSetting("universe_exchange", exchange);
    await setSetting("universe_last_refresh", new Date().toISOString());

    res.json({ ok: true, exchange, fetched: symbols.length, stored: result.upserted });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/universe/status", async (req, res) => {
  try {
    const exchange = String(req.query.exchange || (await getSetting("universe_exchange", "US")) || "US").toUpperCase();
    const count = await universeCount(exchange);
    const last = await getSetting("universe_last_refresh", null);
    res.json({ exchange, ...count, lastRefresh: last });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/universe/scan", async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ error: "DATABASE_URL missing" });

    const exchange = String(req.query.exchange || (await getSetting("universe_exchange", "US")) || "US").toUpperCase();
    const batch = Math.min(200, Math.max(10, safeInt(req.query.batch, 40)));
    const top = Math.min(50, Math.max(3, safeInt(req.query.top, 10)));
    const includeNews = String(req.query.includeNews || "0") === "1";

    const sample = await universeSample({ exchange, limit: batch });

    // Momentum-only scan first (fast)
    const quotes = [];
    for (const s of sample) {
      try {
        const q = await finnhubQuote(s.symbol);
        quotes.push({
          symbol: s.symbol,
          description: s.description || null,
          type: s.type || null,
          price: q.price,
          changePercent: q.changePercent || 0
        });
      } catch {
        // skip broken symbols
      }
    }

    // score by absolute move
    quotes.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
    const ranked = quotes.slice(0, top).map(x => ({
      ...x,
      score: Number(Math.abs(x.changePercent).toFixed(4)),
      reason: "Momentum (abs change%)"
    }));

    // Optional: enrich top few with news sentiment (slow/costly)
    if (includeNews) {
      for (const r of ranked.slice(0, Math.min(5, ranked.length))) {
        try {
          const news = await newsFor(r.symbol);
          const avgSent = news.length ? (news.reduce((a, n) => a + (n.sentiment || 0), 0) / news.length) : 0;
          r.avgSent = Number(avgSent.toFixed(3));
          r.reason = r.reason + " + News sentiment";
        } catch {
          r.avgSent = 0;
        }
      }
    }

    res.json({ ok: true, exchange, batch, top, includeNews, ranked });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------------- Existing endpoints you already use ---------------- */

app.get("/api/version", (req, res) => {
  res.json({ version: APP_VERSION, timestamp: new Date().toISOString() });
});

app.get("/api/health", async (req, res) => {
  const learningSpeed = await getLearningSpeed();
  const exchange = await getSetting("universe_exchange", "US");
  const lastRefresh = await getSetting("universe_last_refresh", null);

  res.json({
    status: "ok",
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    apis: {
      finnhub: !!process.env.FINNHUB_API_KEY,
      newsApi: !!process.env.NEWS_API_KEY,
      postgres: hasDb()
    },
    learningSpeed,
    universe: { exchange, lastRefresh }
  });
});

app.get("/api/settings", async (req, res) => {
  const learningSpeed = await getLearningSpeed();
  res.json({ learningSpeed });
});

app.post("/api/settings/learning-speed", async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ error: "DATABASE_URL missing" });
    const speed = normalizeSpeed(req.body?.learningSpeed);
    await setSetting("learning_speed", speed);
    res.json({ ok: true, learningSpeed: speed });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/news/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const news = await newsFor(symbol);
    res.json({ symbol, news });
  } catch (e) {
    res.status(500).json({ error: e.message, news: [] });
  }
});

app.get("/api/bots/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const learningSpeed = await getLearningSpeed();
    const horizons = horizonsForSpeed(learningSpeed);

    await evaluateDueDecisions(25);

    const [quote, news] = await Promise.all([finnhubQuote(symbol), newsFor(symbol)]);
    const features = computeFeatures(quote, news);

    const strategies = ["sp500_long", "market_swing", "day_trade"];
    const botsRaw = strategies.map((strategy) => {
      const s = botSignal(strategy, features);
      return {
        strategy,
        signal: s.signal,
        horizon: s.horizon,
        rationale: s.rationale,
        baseConfidence: 55 + Math.round(Math.min(20, Math.abs(features.avgSent) * 100))
      };
    });

    let logged = 0;
    let logError = null;

    if (hasDb()) {
      const secByH = { short: horizons.shortSec, medium: horizons.mediumSec, long: horizons.longSec };
      try {
        await Promise.all(
          botsRaw.map((b) =>
            logBotDecision({
              symbol,
              strategy: b.strategy,
              horizon: b.horizon,
              signal: b.signal,
              priceAtSignal: quote.price,
              evalAfterSec: secByH[b.horizon] ?? horizons.mediumSec,
            })
          )
        );
        logged = botsRaw.length;
      } catch (e) {
        logError = e.message;
      }
    }

    const scored = await scoreBots(symbol, botsRaw);
    res.json({ symbol, learningSpeed, horizons, quote, features, logged, logError, ...scored });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- Nonstop Runner ----------------
   It trades continuously. If service restarts, it resumes using DB state.
*/

async function runFightOnceOnSymbol(symbol, note = "runner") {
  if (!hasDb()) return { ok: false, error: "no_db" };

  await ensureBotAccounts({ startingCash: 100000, targetCash: 150000 });

  const learningSpeed = await getLearningSpeed();
  const horizons = horizonsForSpeed(learningSpeed);
  await evaluateDueDecisions(50);

  const [quote, news] = await Promise.all([finnhubQuote(symbol), newsFor(symbol)]);
  const features = computeFeatures(quote, news);

  const strategies = ["sp500_long", "market_swing", "day_trade"];
  const botsRaw = strategies.map((strategy) => {
    const s = botSignal(strategy, features);
    return {
      strategy,
      signal: s.signal,
      horizon: s.horizon,
      rationale: s.rationale,
      baseConfidence: 55 + Math.round(Math.min(20, Math.abs(features.avgSent) * 100))
    };
  });

  // log decisions
  const secByH = { short: horizons.shortSec, medium: horizons.mediumSec, long: horizons.longSec };
  await Promise.all(
    botsRaw.map((b) =>
      logBotDecision({
        symbol,
        strategy: b.strategy,
        horizon: b.horizon,
        signal: b.signal,
        priceAtSignal: quote.price,
        evalAfterSec: secByH[b.horizon] ?? horizons.mediumSec,
      })
    )
  );

  // trades
  const accounts = await getBotAccounts();
  const accountBy = Object.fromEntries(accounts.map(a => [a.strategy, a]));

  const trades = [];

  for (const b of botsRaw) {
    const acc = accountBy[b.strategy];
    if (!acc) continue;

    if (b.signal === "BUY") {
      const pct = buyBudgetPct(b.strategy);
      const budget = Math.max(0, acc.cash * pct);
      const qty = budget / quote.price;

      if (budget >= 200) {
        await recordTrade({ strategy: b.strategy, symbol, side: "BUY", qty, price: quote.price, note });
        trades.push({ strategy: b.strategy, side: "BUY", symbol, qty, price: quote.price });
      }
    }

    if (b.signal === "SELL") {
      const positions = await getBotPositions(b.strategy);
      const pos = positions.find(x => x.symbol === symbol);
      if (pos && pos.qty > 0.0000001) {
        await recordTrade({ strategy: b.strategy, symbol, side: "SELL", qty: pos.qty, price: quote.price, note });
        trades.push({ strategy: b.strategy, side: "SELL", symbol, qty: pos.qty, price: quote.price });
      }
    }
  }

  return { ok: true, symbol, learningSpeed, quote, features, bots: botsRaw, trades };
}

async function runnerTick() {
  try {
    if (!hasDb()) return;

    // pick candidates from universe scan endpoint logic (fast)
    const exchange = String(process.env.UNIVERSE_EXCHANGE || (await getSetting("universe_exchange", "US")) || "US").toUpperCase();
    const batch = Math.min(200, Math.max(10, Number(process.env.RUNNER_SCAN_BATCH || 40)));
    const top = Math.min(10, Math.max(3, Number(process.env.RUNNER_TRADE_TOP || 3)));

    const sample = await universeSample({ exchange, limit: batch });

    const quotes = [];
    for (const s of sample) {
      try {
        const q = await finnhubQuote(s.symbol);
        quotes.push({ symbol: s.symbol, changePercent: q.changePercent || 0 });
      } catch {}
    }

    quotes.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
    const selected = quotes.slice(0, top).map(x => x.symbol);

    for (const sym of selected) {
      await runFightOnceOnSymbol(sym, "runner");
    }

    await setSetting("runner_last_tick", new Date().toISOString());
  } catch (e) {
    // never crash on tick
    console.error("runnerTick error:", e.message);
  }
}

let runnerIntervalHandle = null;

async function startRunnerIfEnabled() {
  const enabled = String(process.env.RUNNER_ENABLED || "true").toLowerCase() === "true";
  if (!enabled) {
    console.log("⏸️ Runner disabled (RUNNER_ENABLED=false)");
    return;
  }
  if (!hasDb()) {
    console.log("⏸️ Runner needs DB (DATABASE_URL missing)");
    return;
  }

  // Ensure only one runner (across replicas) using advisory lock
  const lockId = Number(process.env.RUNNER_LOCK_ID || 424242);
  const lock = await tryAdvisoryLock(lockId);
  if (!lock.locked) {
    console.log("⏸️ Runner not started (another instance holds the lock)");
    return;
  }

  const intervalSec = Math.max(30, Number(process.env.RUNNER_INTERVAL_SEC || 300)); // default 5 min
  console.log(`✅ Runner started. Interval: ${intervalSec}s`);

  // run immediately once, then on interval
  await runnerTick();
  runnerIntervalHandle = setInterval(runnerTick, intervalSec * 1000);
}

/* ---------------- Debug routes ---------------- */

app.get("/api/db/tables", async (req, res) => {
  try { res.json(await dbListTables()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/db/decision-counts/:symbol", async (req, res) => {
  try { res.json(await dbDecisionCounts(req.params.symbol.toUpperCase())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/db/recent-decisions/:symbol", async (req, res) => {
  try { res.json(await dbRecentDecisions(req.params.symbol.toUpperCase(), 10)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/learning/summary/:symbol", async (req, res) => {
  try { res.json(await getLearningSummary({ symbol: req.params.symbol.toUpperCase(), limit: 200 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------- Start ---------------- */

async function start() {
  try {
    await initDb();

    if (hasDb()) {
      await ensureBotAccounts({ startingCash: 100000, targetCash: 150000 });

      const s = await getSetting("learning_speed", null);
      if (!s) await setSetting("learning_speed", "realtime");

      // if universe is empty, you can refresh manually:
      // GET /api/universe/refresh?exchange=US
    }

    await startRunnerIfEnabled();
  } catch (e) {
    console.error("startup error:", e.message);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on ${PORT}`);
  });
}

start();
