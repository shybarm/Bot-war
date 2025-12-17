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
  dbListTables,
  dbDecisionCounts,
  dbRecentDecisions
} from "./db.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const APP_VERSION = "fight-learning-speed-v1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* ---------------- Helpers ---------------- */

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

// Real-time horizons are correct; accelerated just compresses time so learning is visible quickly.
function horizonsForSpeed(speed) {
  if (speed === "accelerated") {
    return {
      shortSec: 5 * 60,        // 5 minutes
      mediumSec: 30 * 60,      // 30 minutes
      longSec: 2 * 60 * 60     // 2 hours
    };
  }
  return {
    shortSec: 4 * 60 * 60,      // 4 hours
    mediumSec: 3 * 24 * 60 * 60,// 3 days
    longSec: 14 * 24 * 60 * 60  // 14 days
  };
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

  // If your provider isn't newsapi.org, replace this URL accordingly.
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(symbol)}&from=${from}&to=${to}&sortBy=relevancy&apiKey=${process.env.NEWS_API_KEY}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(`NewsAPI error: ${r.status}`);

  return (j.articles || []).slice(0, 10).map(a => ({
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
      // keep going, never crash the server
    }
  }

  return { evaluated, stored };
}

/* ---------------- Bots logic ---------------- */

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

function buyBudgetPct(strategy) {
  // conservative and easy-to-understand capital deployment
  if (strategy === "day_trade") return 0.30;
  if (strategy === "market_swing") return 0.20;
  return 0.15; // sp500_long
}

/* ---------------- API ---------------- */

app.get("/api/version", (req, res) => {
  res.json({ version: APP_VERSION, timestamp: new Date().toISOString() });
});

app.get("/api/health", async (req, res) => {
  const learningSpeed = await getLearningSpeed();
  res.json({
    status: "ok",
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    apis: {
      finnhub: !!process.env.FINNHUB_API_KEY,
      newsApi: !!process.env.NEWS_API_KEY,
      postgres: hasDb()
    },
    learningSpeed
  });
});

app.get("/api/settings", async (req, res) => {
  const learningSpeed = await getLearningSpeed();
  res.json({ learningSpeed });
});

app.post("/api/settings/learning-speed", async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ error: "DATABASE_URL missing (cannot persist settings)" });
    const speed = normalizeSpeed(req.body?.learningSpeed);
    await setSetting("learning_speed", speed);
    res.json({ ok: true, learningSpeed: speed });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
      try {
        // record decisions for delayed evaluation (real learning)
        const secByH = {
          short: horizons.shortSec,
          medium: horizons.mediumSec,
          long: horizons.longSec
        };

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

    res.json({
      symbol,
      learningSpeed,
      horizons,
      logged,
      logError,
      quote,
      features,
      bots: scored.bots,
      winner: scored.winner
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Fight endpoint: bots get $100k, goal $150k
 * They trade ANY ticker symbol you pass in: /api/fight/AAPL or /api/fight/TSLA etc.
 */
app.get("/api/fight/:symbol", async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ error: "DATABASE_URL missing (fight requires persistence)" });

    const symbol = req.params.symbol.toUpperCase();
    const learningSpeed = await getLearningSpeed();
    const horizons = horizonsForSpeed(learningSpeed);

    await ensureBotAccounts({ startingCash: 100000, targetCash: 150000 });
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

    // log decisions for learning
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

    // execute trades (simple capital rules)
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

        // minimum trade size
        if (budget >= 200) {
          await recordTrade({ strategy: b.strategy, symbol, side: "BUY", qty, price: quote.price });
          trades.push({ strategy: b.strategy, side: "BUY", symbol, qty, price: quote.price, budget });
        }
      }

      if (b.signal === "SELL") {
        const positions = await getBotPositions(b.strategy);
        const pos = positions.find(x => x.symbol === symbol);
        if (pos && pos.qty > 0.0000001) {
          await recordTrade({ strategy: b.strategy, symbol, side: "SELL", qty: pos.qty, price: quote.price });
          trades.push({ strategy: b.strategy, side: "SELL", symbol, qty: pos.qty, price: quote.price });
        }
      }
    }

    // compute equity (cash + mark-to-market positions)
    const updatedAccounts = await getBotAccounts();
    const status = [];
    for (const a of updatedAccounts) {
      const positions = await getBotPositions(a.strategy);

      // mark-to-market only for the symbols held (usually small count)
      let positionsValue = 0;
      for (const p of positions) {
        const q = await finnhubQuote(p.symbol);
        positionsValue += (p.qty * q.price);
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

    res.json({
      symbol,
      learningSpeed,
      horizons,
      quote,
      features,
      bots: botsRaw,
      trades,
      status
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/learning/summary/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const data = await getLearningSummary({ symbol, limit: 200 });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/evaluate", async (req, res) => {
  try {
    const limit = Number(req.body?.limit) || 25;
    const result = await evaluateDueDecisions(Math.min(50, Math.max(1, limit)));
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* -------- Debug routes -------- */

app.get("/api/db/tables", async (req, res) => {
  try {
    res.json(await dbListTables());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/db/decision-counts/:symbol", async (req, res) => {
  try {
    res.json(await dbDecisionCounts(req.params.symbol.toUpperCase()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/db/recent-decisions/:symbol", async (req, res) => {
  try {
    res.json(await dbRecentDecisions(req.params.symbol.toUpperCase(), 10));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- Start ---------------- */

async function start() {
  try {
    await initDb();
    if (hasDb()) {
      await ensureBotAccounts({ startingCash: 100000, targetCash: 150000 });
      const s = await getSetting("learning_speed", null);
      if (!s) await setSetting("learning_speed", "realtime");
    }
  } catch (e) {
    console.error("⚠️ init failed:", e.message);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on ${PORT}`);
  });
}

start();
