// ===============================
//  AI Trading Arena - Multi Provider Engine
//  Stock failover: Finnhub → TwelveData
//  News failover: NewsData.io → NewsAPI
// ===============================

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
  getStrategyTrades
} from "./db.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const APP_VERSION = "arena-multiprovider-v1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ------------------------------------------------------
// Learning speed system
// ------------------------------------------------------
function normalizeSpeed(v) {
  const x = String(v || "").toLowerCase().trim();
  if (["accelerated", "fast", "preview"].includes(x)) return "accelerated";
  return "realtime";
}

async function getLearningSpeed() {
  if (!hasDb()) return "realtime";
  return normalizeSpeed(await getSetting("learning_speed", "realtime"));
}

function horizonsForSpeed(speed) {
  return speed === "accelerated"
    ? { shortSec: 5 * 60, mediumSec: 30 * 60, longSec: 2 * 60 * 60 }
    : { shortSec: 4 * 60 * 60, mediumSec: 3 * 24 * 60 * 60, longSec: 14 * 24 * 60 * 60 };
}

// ------------------------------------------------------
//  STOCK PROVIDERS
// ------------------------------------------------------

// ---- 1. FINNHUB PRIMARY ----
async function finnhubQuote(symbol) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error("FINNHUB_API_KEY missing");

  const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${key}`;
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));

  if (!r.ok || !j.c) throw new Error("Finnhub error");

  return {
    provider: "finnhub",
    price: j.c,
    changePercent: j.dp || 0,
    change: j.d || 0
  };
}

// ---- 2. TWELVEDATA FALLBACK (/price endpoint) ----
async function twelveDataQuote(symbol) {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new Error("TWELVEDATA_API_KEY missing");

  const url = `https://api.twelvedata.com/price?symbol=${symbol}&apikey=${key}`;
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));

  if (!r.ok || !j.price) throw new Error("TwelveData error");

  return {
    provider: "twelvedata",
    price: Number(j.price),
    changePercent: 0,
    change: 0
  };
}

// ---- UNIFIED STOCK QUOTE FAILOVER ----
async function getStockQuote(symbol) {
  const errors = [];

  // Try Finnhub first
  try {
    return await finnhubQuote(symbol);
  } catch (e) {
    errors.push("Finnhub: " + e.message);
  }

  // Try TwelveData next
  try {
    return await twelveDataQuote(symbol);
  } catch (e) {
    errors.push("TwelveData: " + e.message);
  }

  throw new Error("Both stock providers failed → " + errors.join(" | "));
}

// ------------------------------------------------------
//  NEWS PROVIDERS
// ------------------------------------------------------

// → Sentiment helper
function sentimentScore(text) {
  const pos = ["surge", "growth", "profit", "beat", "strong", "record", "upgrade", "bullish"];
  const neg = ["drop", "loss", "miss", "weak", "concern", "downgrade", "bearish"];

  const t = (text || "").toLowerCase();
  let s = 0;
  pos.forEach(w => { if (t.includes(w)) s += 0.1; });
  neg.forEach(w => { if (t.includes(w)) s -= 0.1; });
  return Math.max(-1, Math.min(1, s));
}

// ---- 1. NEWSDATA.IO PRIMARY ----
async function newsdataNews(symbol) {
  const key = process.env.NEWSDATA_API_KEY;
  if (!key) throw new Error("NEWSDATA_API_KEY missing");

  const url = `https://newsdata.io/api/1/news?apikey=${key}&q=${symbol}&language=en`;
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));

  if (!r.ok || !j.results) throw new Error("NewsData error");

  return j.results.slice(0, 8).map(n => ({
    provider: "newsdata",
    title: n.title,
    description: n.description,
    url: n.link,
    publishedAt: n.pubDate,
    source: n.source_id,
    sentiment: sentimentScore(n.title + " " + n.description)
  }));
}

// ---- 2. NEWSAPI BACKUP ----
async function newsapiNews(symbol) {
  const key = process.env.NEWSAPI_BACKUP_KEY;
  if (!key) throw new Error("NEWSAPI_BACKUP_KEY missing");

  const url = `https://newsapi.org/v2/everything?q=${symbol}&language=en&sortBy=relevancy&apiKey=${key}`;
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));

  if (!r.ok || !j.articles) throw new Error("NewsAPI error");

  return j.articles.slice(0, 8).map(a => ({
    provider: "newsapi",
    title: a.title,
    description: a.description,
    url: a.url,
    publishedAt: a.publishedAt,
    source: a.source?.name,
    sentiment: sentimentScore(a.title + " " + a.description)
  }));
}

// ---- UNIFIED NEWS FAILOVER ----
async function getNewsBundle(symbol) {
  const errors = [];

  try { return await newsdataNews(symbol); }
  catch (e) { errors.push("NewsData: " + e.message); }

  try { return await newsapiNews(symbol); }
  catch (e) { errors.push("NewsAPI: " + e.message); }

  throw new Error("Both news providers failed → " + errors.join(" | "));
}

// ------------------------------------------------------
// Bot System
// ------------------------------------------------------

function computeFeatures(quote, news) {
  const avgSent = news.length ? news.reduce((a, n) => a + n.sentiment, 0) / news.length : 0;
  return {
    avgSent,
    changePercent: quote.changePercent
  };
}

function botSignal(strategy, features) {
  const { avgSent, changePercent } = features;

  if (strategy === "sp500_long") {
    if (avgSent > 0.15) return { signal: "BUY", horizon: "long", rationale: "Positive long-term sentiment" };
    if (avgSent < -0.15) return { signal: "SELL", horizon: "long", rationale: "Negative long-term sentiment" };
    return { signal: "HOLD", horizon: "long", rationale: "Mixed long-term signals" };
  }

  if (strategy === "market_swing") {
    if (avgSent > 0.1 && changePercent > 0) return { signal: "BUY", horizon: "medium", rationale: "Sentiment + momentum" };
    if (avgSent < -0.1 && changePercent < 0) return { signal: "SELL", horizon: "medium", rationale: "Negative momentum" };
    return { signal: "HOLD", horizon: "medium", rationale: "No clean swing setup" };
  }

  if (changePercent > 1.2) return { signal: "BUY", horizon: "short", rationale: "Intraday strength" };
  if (changePercent < -1.2) return { signal: "SELL", horizon: "short", rationale: "Intraday weakness" };
  return { signal: "HOLD", horizon: "short", rationale: "No volatility edge" };
}

function buyBudgetPct(strategy) {
  if (strategy === "day_trade") return 0.30;
  if (strategy === "market_swing") return 0.20;
  return 0.15;
}

// ------------------------------------------------------
// Evaluate old decisions (learning)
// ------------------------------------------------------

async function evaluateDueDecisions(limit = 25) {
  if (!hasDb()) return { evaluated: 0, stored: 0 };

  const due = await getDueDecisions(limit);
  let evaluated = 0;
  let stored = 0;

  for (const d of due) {
    try {
      const q = await getStockQuote(d.symbol);
      const updated = await markDecisionEvaluated({ id: d.id, priceAfter: q.price });
      evaluated++;

      if (updated) {
        await insertLearningEvent({
          symbol: updated.symbol,
          strategy: updated.strategy,
          horizon: updated.horizon,
          signal: updated.signal,
          priceAtSignal: updated.price_at_signal,
          priceAfter: updated.price_after
        });
        stored++;
      }
    } catch {}
  }

  return { evaluated, stored };
}

// ------------------------------------------------------
// API — Bot Fight
// ------------------------------------------------------

app.get("/api/fight/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const speed = await getLearningSpeed();
    const horizons = horizonsForSpeed(speed);

    if (hasDb()) await ensureBotAccounts({ startingCash: 100000, targetCash: 150000 });

    // 1) quote with failover
    const quote = await getStockQuote(symbol);

    // 2) news with failover (non-blocking)
    let news = [];
    let newsError = null;
    try {
      news = await getNewsBundle(symbol);
    } catch (e) {
      newsError = e.message;
      news = [];
    }

    // 3) compute features
    const features = computeFeatures(quote, news);

    const strategies = ["sp500_long", "market_swing", "day_trade"];
    const rawBots = strategies.map(s => {
      const sig = botSignal(s, features);
      return {
        strategy: s,
        signal: sig.signal,
        horizon: sig.horizon,
        rationale: sig.rationale,
        baseConfidence: 60
      };
    });

    // 4) log decisions (learning)
    if (hasDb()) {
      await Promise.all(
        rawBots.map(b =>
          logBotDecision({
            symbol,
            strategy: b.strategy,
            horizon: b.horizon,
            signal: b.signal,
            priceAtSignal: quote.price,
            evalAfterSec: horizons[b.horizon]
          })
        )
      );
    }

    // 5) execute trades
    let trades = [];
    if (hasDb()) {
      const bots = await getBotAccounts();
      const botMap = Object.fromEntries(bots.map(b => [b.strategy, b]));

      for (const b of rawBots) {
        const acc = botMap[b.strategy];
        const note = `signal=${b.signal}; sentiment=${features.avgSent.toFixed(2)}; rationale=${b.rationale}`;

        // BUY
        if (b.signal === "BUY") {
          const budget = acc.cash * buyBudgetPct(b.strategy);
          if (budget > 50) {
            const qty = budget / quote.price;
            await recordTrade({ strategy: b.strategy, symbol, side: "BUY", qty, price: quote.price, note });
            trades.push({ strategy: b.strategy, side: "BUY", symbol, qty, price: quote.price, note });
          }
        }

        // SELL
        if (b.signal === "SELL") {
          const positions = await getBotPositions(b.strategy);
          const pos = positions.find(p => p.symbol === symbol);
          if (pos && pos.qty > 0) {
            await recordTrade({
              strategy: b.strategy,
              symbol,
              side: "SELL",
              qty: pos.qty,
              price: quote.price,
              note
            });
            trades.push({ strategy: b.strategy, side: "SELL", symbol, qty: pos.qty, price: quote.price, note });
          }
        }
      }
    }

    // 6) output for UI
    res.json({
      symbol,
      quote,
      features,
      news,
      newsError,
      trades,
      version: APP_VERSION
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------
// Trades & diagnostics
// ------------------------------------------------------

app.get("/api/trades/recent", async (req, res) => {
  try {
    const rows = await getRecentTrades({ limit: 50 });
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------
// Start server
// ------------------------------------------------------

async function start() {
  try {
    await initDb();
    if (hasDb()) {
      const s = await getSetting("learning_speed", null);
      if (!s) await setSetting("learning_speed", "realtime");
    }
  } catch (e) {
    console.error("Startup error:", e.message);
  }

  app.listen(PORT, "0.0.0.0", () =>
    console.log(`🚀 AI Arena multiprovider server running on ${PORT}`)
  );
}

start();
