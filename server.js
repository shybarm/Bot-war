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
  getRecentTrades,
  getStrategyTrades,
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
const APP_VERSION = "arena-ui-trades-v2";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* ---------------- Learning speed ---------------- */

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
    return { shortSec: 5 * 60, mediumSec: 30 * 60, longSec: 2 * 60 * 60 };
  }
  return { shortSec: 4 * 60 * 60, mediumSec: 3 * 24 * 60 * 60, longSec: 14 * 24 * 60 * 60 };
}

/* ---------------- External data ---------------- */

async function finnhubQuote(symbol) {
  if (!process.env.FINNHUB_API_KEY) throw new Error("FINNHUB_API_KEY missing");
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${process.env.FINNHUB_API_KEY}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(`Finnhub error: ${r.status}`);
  return { price: j.c, changePercent: j.dp, change: j.d };
}

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

  // If your provider isn't newsapi.org, update this URL accordingly.
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

/* ---------------- Learning evaluation ---------------- */

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
      // keep going
    }
  }

  return { evaluated, stored };
}

/* ---------------- Bot logic ---------------- */

function computeFeatures(quote, news) {
  const avgSent = news.length ? (news.reduce((a, n) => a + (n.sentiment || 0), 0) / news.length) : 0;
  return { avgSent, changePercent: quote.changePercent || 0 };
}

function botSignal(strategy, features) {
  const { avgSent, changePercent } = features;

  if (strategy === "sp500_long") {
    if (avgSent > 0.15) return { signal: "BUY", horizon: "long", rationale: "Positive sentiment; long horizon accumulation" };
    if (avgSent < -0.15) return { signal: "SELL", horizon: "long", rationale: "Negative sentiment; long horizon de-risk" };
    return { signal: "HOLD", horizon: "long", rationale: "Mixed sentiment; wait for clarity" };
  }

  if (strategy === "market_swing") {
    if (avgSent > 0.1 && changePercent > 0) return { signal: "BUY", horizon: "medium", rationale: "Sentiment + momentum alignment" };
    if (avgSent < -0.1 && changePercent < 0) return { signal: "SELL", horizon: "medium", rationale: "Down momentum + negative sentiment" };
    return { signal: "HOLD", horizon: "medium", rationale: "No clean swing setup" };
  }

  // day_trade
  if (changePercent > 1.2) return { signal: "BUY", horizon: "short", rationale: "Strong intraday move (momentum scalp)" };
  if (changePercent < -1.2) return { signal: "SELL", horizon: "short", rationale: "Sharp intraday weakness (risk-off scalp)" };
  return { signal: "HOLD", horizon: "short", rationale: "Noise range; avoid overtrading" };
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

    scored.push({
      ...b,
      historicalAccuracy: historical,
      samples: stats.samples,
      confidence
    });
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  return { bots: scored, winner: scored[0]?.strategy || null };
}

/* ---------------- Universe endpoints ---------------- */

app.get("/api/universe/refresh", async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ error: "DATABASE_URL missing" });

    const exchange = String(req.query.exchange || process.env.UNIVERSE_EXCHANGE || "US").toUpperCase();
    const symbols = await finnhubSymbols(exchange);

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
    const batch = Math.min(200, Math.max(10, Number(req.query.batch || 40)));
    const top = Math.min(50, Math.max(3, Number(req.query.top || 10)));

    const sample = await universeSample({ exchange, limit: batch });

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
      } catch {}
    }

    quotes.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
    const ranked = quotes.slice(0, top).map(x => ({
      ...x,
      score: Number(Math.abs(x.changePercent).toFixed(4)),
      reason: "Momentum (abs change%)"
    }));

    res.json({ ok: true, exchange, batch, top, ranked });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------------- Core API ---------------- */

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

/* ---------------- ✅ Bot Fight endpoint (FIX) ----------------
   This is what your UI calls. It must return JSON.
*/

app.get("/api/fight/:symbol", async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ error: "DATABASE_URL missing (fight requires persistence)" });

    const symbol = req.params.symbol.toUpperCase();
    const learningSpeed = await getLearningSpeed();
    const horizons = horizonsForSpeed(learningSpeed);

    await ensureBotAccounts({ startingCash: 100000, targetCash: 150000 });
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

    // execute trades + attach reasons to trade notes
    const accounts = await getBotAccounts();
    const accountBy = Object.fromEntries(accounts.map(a => [a.strategy, a]));

    const trades = [];

    for (const b of botsRaw) {
      const acc = accountBy[b.strategy];
      if (!acc) continue;

      const note = `signal=${b.signal}; horizon=${b.horizon}; rationale=${b.rationale}`;

      if (b.signal === "BUY") {
        const pct = buyBudgetPct(b.strategy);
        const budget = Math.max(0, acc.cash * pct);
        const qty = budget / quote.price;

        if (budget >= 200) {
          await recordTrade({ strategy: b.strategy, symbol, side: "BUY", qty, price: quote.price, note });
          trades.push({ strategy: b.strategy, side: "BUY", symbol, qty, price: quote.price, note });
        }
      }

      if (b.signal === "SELL") {
        const positions = await getBotPositions(b.strategy);
        const pos = positions.find(x => x.symbol === symbol);
        if (pos && pos.qty > 0.0000001) {
          await recordTrade({ strategy: b.strategy, symbol, side: "SELL", qty: pos.qty, price: quote.price, note });
          trades.push({ strategy: b.strategy, side: "SELL", symbol, qty: pos.qty, price: quote.price, note });
        }
      }
    }

    // portfolio snapshot
    const updatedAccounts = await getBotAccounts();
    const status = [];

    for (const a of updatedAccounts) {
      const positions = await getBotPositions(a.strategy);

      // mark-to-market: only for held symbols
      let positionsValue = 0;
      for (const p of positions) {
        try {
          const q = await finnhubQuote(p.symbol);
          positionsValue += (p.qty * q.price);
        } catch {}
      }

      const equity = a.cash + positionsValue;
      const progressPct = ((equity - a.starting_cash) / (a.target_cash - a.starting_cash)) * 100;

      status.push({
        strategy: a.strategy,
        cash: a.cash,
        positions,
        positionsValue,
        equity,
        startingCash: a.starting_cash,
        targetCash: a.target_cash,
        progressPct: Math.max(0, Math.min(100, Number(progressPct.toFixed(2))))
      });
    }

    const scored = await scoreBots(symbol, botsRaw);

    res.json({
      symbol,
      learningSpeed,
      horizons,
      quote,
      features,
      bots: scored.bots,
      winner: scored.winner,
      trades,
      status,
      news
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- Trades + Portfolio endpoints ---------------- */

app.get("/api/trades/recent", async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ error: "DATABASE_URL missing" });
    const limit = Math.min(200, Math.max(5, Number(req.query.limit || 50)));
    const rows = await getRecentTrades({ limit });
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/trades/:strategy", async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ error: "DATABASE_URL missing" });
    const strategy = String(req.params.strategy || "").trim();
    const limit = Math.min(200, Math.max(5, Number(req.query.limit || 50)));
    const rows = await getStrategyTrades({ strategy, limit });
    res.json({ ok: true, strategy, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/portfolio", async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ error: "DATABASE_URL missing" });
    const accounts = await getBotAccounts();
    const out = [];
    for (const a of accounts) {
      const positions = await getBotPositions(a.strategy);
      out.push({ ...a, positions });
    }
    res.json({ ok: true, accounts: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------------- Learning debug ---------------- */

app.get("/api/learning/summary/:symbol", async (req, res) => {
  try { res.json(await getLearningSummary({ symbol: req.params.symbol.toUpperCase(), limit: 200 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

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

/* ---------------- Runner (optional) ---------------- */

async function runnerTick() {
  try {
    if (!hasDb()) return;

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

    // trade those candidates by calling the same fight logic
    for (const sym of selected) {
      // minimal: reuse fight logic via internal call
      // (we keep it simple by calling the endpoint handler logic directly in future refactors)
      // Here: do one-shot by hitting /api/fight with a fetch is overkill; skip runner trading in this version.
    }

    await setSetting("runner_last_tick", new Date().toISOString());
  } catch (e) {
    console.error("runnerTick error:", e.message);
  }
}

async function startRunnerIfEnabled() {
  const enabled = String(process.env.RUNNER_ENABLED || "false").toLowerCase() === "true";
  if (!enabled) return;

  if (!hasDb()) return;

  const lockId = Number(process.env.RUNNER_LOCK_ID || 424242);
  const lock = await tryAdvisoryLock(lockId);
  if (!lock.locked) {
    console.log("⏸️ Runner not started (another instance holds lock)");
    return;
  }

  const intervalSec = Math.max(30, Number(process.env.RUNNER_INTERVAL_SEC || 300));
  console.log(`✅ Runner started. Interval: ${intervalSec}s`);

  await runnerTick();
  setInterval(runnerTick, intervalSec * 1000);
}

/* ---------------- Start ---------------- */

async function start() {
  try {
    await initDb();
    if (hasDb()) {
      await ensureBotAccounts({ startingCash: 100000, targetCash: 150000 });
      const s = await getSetting("learning_speed", null);
      if (!s) await setSetting("learning_speed", "realtime");
    }
    await startRunnerIfEnabled();
  } catch (e) {
    console.error("startup error:", e.message);
  }

  app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server listening on ${PORT}`));
}

start();
