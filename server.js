import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import {
  initDb,
  hasDb,
  logBotDecision,
  getStrategyAccuracy,
  getLearningSummary,
  dbListTables,
  dbDecisionCounts,
  dbRecentDecisions
} from "./db.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const APP_VERSION = "learning-debug-v3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

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

  if (changePercent > 1.2) return { signal: "BUY", horizon: "short", rationale: "Strong intraday move" };
  if (changePercent < -1.2) return { signal: "SELL", horizon: "short", rationale: "Sharp intraday drop" };
  return { signal: "HOLD", horizon: "short", rationale: "Noise range" };
}

function horizonToEvalAfterSec(h) {
  if (h === "short") return 4 * 60 * 60;
  if (h === "medium") return 3 * 24 * 60 * 60;
  return 14 * 24 * 60 * 60;
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

/* ---------------- API routes ---------------- */

app.get("/api/version", (req, res) => {
  res.json({ version: APP_VERSION, timestamp: new Date().toISOString() });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    apis: {
      finnhub: !!process.env.FINNHUB_API_KEY,
      newsApi: !!process.env.NEWS_API_KEY,
      postgres: hasDb()
    }
  });
});

app.get("/api/bots/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
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
        await Promise.all(
          botsRaw.map((b) =>
            logBotDecision({
              symbol,
              strategy: b.strategy,
              horizon: b.horizon,
              signal: b.signal,
              priceAtSignal: quote.price,
              evalAfterSec: horizonToEvalAfterSec(b.horizon),
            })
          )
        );
        logged = botsRaw.length;
      } catch (e) {
        logError = e.message;
      }
    }

    const scored = await scoreBots(symbol, botsRaw);
    res.json({ symbol, logged, logError, features, ...scored });
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

/* -------- DB DEBUG ROUTES -------- */

app.get("/api/db/tables", async (req, res) => {
  try {
    const x = await dbListTables();
    res.json(x);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/db/decision-counts/:symbol", async (req, res) => {
  try {
    const x = await dbDecisionCounts(req.params.symbol.toUpperCase());
    res.json(x);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/db/recent-decisions/:symbol", async (req, res) => {
  try {
    const x = await dbRecentDecisions(req.params.symbol.toUpperCase(), 10);
    res.json(x);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Insert test
app.get("/api/db/insert-test/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const row = await logBotDecision({
      symbol,
      strategy: "test_strategy",
      horizon: "short",
      signal: "HOLD",
      priceAtSignal: 123.45,
      evalAfterSec: 60
    });
    res.json({ ok: true, inserted: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------------- Start ---------------- */

async function start() {
  try {
    await initDb();
  } catch (e) {
    console.error("⚠️ DB init failed; continuing without DB:", e.message);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on ${PORT}`);
  });
}

start();
