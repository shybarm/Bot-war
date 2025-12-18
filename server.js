import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import http from "http";
import { WebSocketServer } from "ws";

import {
  initDb,
  hasDb,
  getBotAccounts,
  getBotPositions,
  recordTrade,
  getRecentTrades,
  insertLearningEvent,
  getHistoricalPatterns,
  calculateAccuracyFromPatterns,
  getLearningImpact
} from "./db.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const APP_VERSION = "arena-warroom-learning-v1";

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

app.get("/", (req, res) => res.sendFile(path.resolve("public", "index.html")));

// -----------------------
// Settings (fix UI errors)
// -----------------------
const VALID_SPEEDS = new Set(["realtime", "accelerated"]);
let learningSpeed = (() => {
  const v = String(process.env.LEARNING_SPEED || "realtime").toLowerCase().trim();
  return VALID_SPEEDS.has(v) ? v : "realtime";
})();

app.get("/api/version", (req, res) => {
  res.json({ version: APP_VERSION, timestamp: new Date().toISOString() });
});

app.get("/api/settings/learning-speed", (req, res) => {
  res.json({
    ok: true,
    mode: learningSpeed,
    label: learningSpeed === "accelerated" ? "Accelerated (fast feedback)" : "Real-time (production)"
  });
});

app.post("/api/settings/learning-speed", (req, res) => {
  const incoming = String(req.body?.mode || "").toLowerCase().trim();
  if (!VALID_SPEEDS.has(incoming)) {
    return res.status(400).json({ ok: false, error: "Invalid mode. Use 'realtime' or 'accelerated'." });
  }
  learningSpeed = incoming;
  res.json({ ok: true, mode: learningSpeed });
});

// -----------------------
// Price failover
// -----------------------
async function finnhubQuote(symbol) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error("FINNHUB_API_KEY missing");
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`);
  const j = await r.json();
  if (!j || typeof j.c !== "number") throw new Error("Finnhub: no price");
  return { provider: "finnhub", price: j.c, changePercent: j.dp ?? 0, change: j.d ?? 0 };
}

async function twelveDataQuote(symbol) {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new Error("TWELVEDATA_API_KEY missing");
  const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${key}`);
  const j = await r.json();
  if (!j || !j.price) throw new Error("TwelveData: no price");
  return { provider: "twelvedata", price: Number(j.price), changePercent: 0, change: 0 };
}

async function getStockQuote(symbol) {
  try { return await finnhubQuote(symbol); }
  catch { return await twelveDataQuote(symbol); }
}

// -----------------------
// News failover
// -----------------------
function sentimentScore(text = "") {
  const pos = ["gain","surge","strong","profit","upgrade","beats","record","growth","bullish"];
  const neg = ["drop","weak","loss","downgrade","fall","miss","lawsuit","bearish","decline"];
  const t = String(text).toLowerCase();
  let s = 0;
  for (const w of pos) if (t.includes(w)) s += 0.1;
  for (const w of neg) if (t.includes(w)) s -= 0.1;
  return Math.max(-1, Math.min(1, s));
}

async function newsdataNews(symbol) {
  const key = process.env.NEWSDATA_API_KEY;
  if (!key) throw new Error("NEWSDATA_API_KEY missing");
  const r = await fetch(`https://newsdata.io/api/1/news?apikey=${key}&q=${encodeURIComponent(symbol)}&language=en`);
  const j = await r.json();
  if (!j || !j.results) throw new Error("NewsData failed");
  return j.results.slice(0, 8).map(n => ({
    title: n.title,
    description: n.description,
    url: n.link,
    publishedAt: n.pubDate,
    provider: "newsdata",
    sentiment: sentimentScore((n.title || "") + " " + (n.description || ""))
  }));
}

async function newsApiNews(symbol) {
  const key = process.env.NEWSAPI_BACKUP_KEY;
  if (!key) throw new Error("NEWSAPI_BACKUP_KEY missing");
  const r = await fetch(`https://newsapi.org/v2/everything?q=${encodeURIComponent(symbol)}&language=en&sortBy=relevancy&apiKey=${key}`);
  const j = await r.json();
  if (!j || !j.articles) throw new Error("NewsAPI failed");
  return j.articles.slice(0, 8).map(a => ({
    title: a.title,
    description: a.description,
    url: a.url,
    publishedAt: a.publishedAt,
    provider: "newsapi",
    sentiment: sentimentScore((a.title || "") + " " + (a.description || ""))
  }));
}

async function getNewsBundle(symbol) {
  try { return await newsdataNews(symbol); }
  catch { return await newsApiNews(symbol); }
}

// -----------------------
// Simple history endpoint (TradingView/mini-chart)
// -----------------------
app.get("/api/history/:symbol", async (req, res) => {
  const symbol = String(req.params.symbol || "").toUpperCase().trim();
  try {
    const q = await getStockQuote(symbol);
    const now = Math.floor(Date.now() / 1000);
    const data = [];
    for (let i = 120; i >= 1; i--) {
      data.push({ time: now - i, value: q.price + Math.sin(i / 6) * 0.6 });
    }
    res.json({ ok: true, symbol, provider: q.provider, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -----------------------
// War Room endpoints
// -----------------------
async function buildPortfolioSnapshot() {
  const bots = await getBotAccounts();
  const positions = {};
  for (const b of bots) positions[b.strategy] = await getBotPositions(b.strategy);
  return { bots, positions };
}

app.get("/api/war/bots", async (req, res) => res.json(await buildPortfolioSnapshot()));
app.get("/api/war/trades", async (req, res) => res.json({ ok: true, rows: await getRecentTrades({ limit: 50 }) }));

// Keep a rolling symbol carousel
const tradedSymbols = [];
const MAX_SYMBOLS = 30;

// -----------------------
// Bot logic (4 bots)
// -----------------------
function computeFeatures(quote, news) {
  const avgSent = news.reduce((a, n) => a + (n.sentiment || 0), 0) / (news.length || 1);
  return { avgSent, changePercent: quote.changePercent ?? 0 };
}

function buyBudgetPct(strategy) {
  if (strategy === "day_trade") return 0.30;
  if (strategy === "market_swing") return 0.20;
  if (strategy === "news_only") return 0.18;
  return 0.15; // sp500_long
}

function botSignal(strategy, f) {
  if (strategy === "news_only") {
    if (f.avgSent > 0.18) return { signal: "BUY", rationale: "News-only: positive coverage cluster" };
    if (f.avgSent < -0.18) return { signal: "SELL", rationale: "News-only: negative coverage cluster" };
    return { signal: "HOLD", rationale: "News-only: neutral/unclear tone" };
  }

  if (strategy === "sp500_long") {
    if (f.avgSent > 0.15) return { signal: "BUY", rationale: "Macro sentiment supportive (long horizon)" };
    if (f.avgSent < -0.15) return { signal: "SELL", rationale: "Macro sentiment negative (risk-off)" };
    return { signal: "HOLD", rationale: "Long horizon: wait for stronger signal" };
  }

  if (strategy === "market_swing") {
    if (f.avgSent > 0.1 && f.changePercent > 0) return { signal: "BUY", rationale: "Swing: sentiment + momentum aligned" };
    if (f.avgSent < -0.1 && f.changePercent < 0) return { signal: "SELL", rationale: "Swing: breakdown risk" };
    return { signal: "HOLD", rationale: "Swing: no clean setup" };
  }

  // day_trade
  if (f.changePercent > 1.2) return { signal: "BUY", rationale: "Intraday: breakout impulse" };
  if (f.changePercent < -1.2) return { signal: "SELL", rationale: "Intraday: breakdown impulse" };
  return { signal: "HOLD", rationale: "Intraday: noise range" };
}

// -----------------------
// Health + learning endpoints (kept)
// -----------------------
app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    apis: {
      finnhub: !!process.env.FINNHUB_API_KEY,
      newsPrimary: !!process.env.NEWSDATA_API_KEY,
      newsBackup: !!process.env.NEWSAPI_BACKUP_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      postgres: hasDb(),
      twelvedata: !!process.env.TWELVEDATA_API_KEY
    },
    version: APP_VERSION,
    learningSpeed
  });
});

app.get("/api/learning/impact/:symbol", async (req, res) => {
  try {
    const symbol = String(req.params.symbol || "").toUpperCase().trim();
    const strategy = req.query.strategy ? String(req.query.strategy).trim() : null;
    const bucket = req.query.bucket ? String(req.query.bucket).trim() : "hour";
    const limit = req.query.limit ? Number(req.query.limit) : 72;

    const impact = await getLearningImpact({ symbol, strategy, bucket, limit });
    res.json({ ok: true, hasDb: hasDb(), symbol, strategy: strategy || "ALL", bucket, limit, ...impact });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/learn", async (req, res) => {
  try {
    const { symbol, signal, priceAtSignal, priceAfter, strategy, horizon } = req.body;
    if (!symbol || !signal || typeof priceAtSignal !== "number" || typeof priceAfter !== "number") {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    const row = await insertLearningEvent({
      symbol: String(symbol).toUpperCase().trim(),
      strategy: strategy ? String(strategy).trim() : "global",
      signal: String(signal).toUpperCase().trim(),
      horizon: horizon ? String(horizon).trim() : "medium",
      priceAtSignal,
      priceAfter
    });

    const patterns = await getHistoricalPatterns(String(symbol).toUpperCase().trim(), 50);

    res.json({
      ok: true,
      stored: !!row,
      event: row,
      totalPatterns: patterns.length,
      historicalAccuracy: calculateAccuracyFromPatterns(patterns)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -----------------------
// HTTP server + WebSocket
// -----------------------
const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws/war-room" });

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on("connection", async () => {
  // Push initial state
  broadcast("symbols", tradedSymbols);
  broadcast("portfolio", await buildPortfolioSnapshot());
  broadcast("trades", { rows: await getRecentTrades({ limit: 25 }) });
});

// -----------------------
// One round of “Bots Fight”
// -----------------------
app.get("/api/fight/:symbol", async (req, res) => {
  const symbol = String(req.params.symbol || "").toUpperCase().trim();

  try {
    const quote = await getStockQuote(symbol);
    let news = [];
    try { news = await getNewsBundle(symbol); } catch { news = []; }

    const f = computeFeatures(quote, news);

    const strategies = ["sp500_long", "market_swing", "day_trade", "news_only"];
    const bots = [];
    const trades = [];

    // Decide + possibly trade
    const accounts = await getBotAccounts();
    const acctMap = Object.fromEntries(accounts.map(a => [a.strategy, a]));

    for (const s of strategies) {
      const sig = botSignal(s, f);

      // Build bot entry (for UI)
      bots.push({
        strategy: s,
        signal: sig.signal,
        horizon: s === "sp500_long" ? "long" : s === "day_trade" ? "short" : "medium",
        rationale: sig.rationale,
        baseConfidence: 60,
      });

      // Reasoning stream
      broadcast("reasoning", { ts: Date.now(), strategy: s, rationale: sig.rationale });

      // Execute trades (simple)
      const cash = Number(acctMap[s]?.cash ?? 100000);
      const note = `${sig.rationale} | Sent ${f.avgSent.toFixed(2)} | Δ% ${Number(f.changePercent).toFixed(2)}`;

      if (sig.signal === "BUY") {
        const budget = cash * buyBudgetPct(s);
        if (budget > 25) {
          const qty = budget / quote.price;
          await recordTrade({ strategy: s, symbol, side: "BUY", qty, price: quote.price, note });
          trades.push({ strategy: s, symbol, side: "BUY", qty, price: quote.price, note });
          broadcast("trade", { strategy: s, symbol, side: "BUY", qty, price: quote.price, note });
        }
      }

      if (sig.signal === "SELL") {
        const pos = await getBotPositions(s);
        const p = pos.find(x => x.symbol === symbol);
        if (p && p.qty > 0.000001) {
          await recordTrade({ strategy: s, symbol, side: "SELL", qty: p.qty, price: quote.price, note });
          trades.push({ strategy: s, symbol, side: "SELL", qty: p.qty, price: quote.price, note });
          broadcast("trade", { strategy: s, symbol, side: "SELL", qty: p.qty, price: quote.price, note });
        }
      }
    }

    // Update symbol carousel
    if (!tradedSymbols.includes(symbol)) {
      tradedSymbols.unshift(symbol);
      if (tradedSymbols.length > MAX_SYMBOLS) tradedSymbols.pop();
      broadcast("symbols", tradedSymbols);
    }

    // Portfolio + sentiment stream
    broadcast("sentiment", { symbol, price: quote.price, sentiment: f.avgSent, ts: Date.now() });
    broadcast("portfolio", await buildPortfolioSnapshot());
    broadcast("trades", { rows: await getRecentTrades({ limit: 25 }) });

    // Winner (simple rule: highest abs sentiment “alignment”)
    const winner = bots[0]?.strategy || "sp500_long";

    res.json({ ok: true, symbol, quote, features: f, bots, trades, winner, news, version: APP_VERSION });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -----------------------
// Nonstop Runner (optional activity)
// -----------------------
function parseBool(v) {
  return String(v || "").toLowerCase().trim() === "true" || String(v || "").trim() === "1";
}

const RUNNER_ENABLED = parseBool(process.env.RUNNER_ENABLED);
const RUNNER_INTERVAL_SEC = Math.max(5, Number(process.env.RUNNER_INTERVAL_SEC) || 15);

// A simple rotating list for autopilot fights
const AUTO_SYMBOLS = (process.env.AUTO_SYMBOLS || "AAPL,MSFT,NVDA,TSLA,GOOGL,META,AMZN")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

let autoIdx = 0;

async function runnerTick() {
  try {
    const sym = AUTO_SYMBOLS[autoIdx % AUTO_SYMBOLS.length];
    autoIdx += 1;
    // Trigger one fight round
    await fetch(`http://127.0.0.1:${PORT}/api/fight/${sym}`);
  } catch (e) {
    console.error("Runner tick error:", e.message);
  }
}

// Start server after DB init
(async function start() {
  try { await initDb(); } catch (e) { console.error("DB init error:", e.message); }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on PORT ${PORT}`);
    console.log(`🔌 WS path: /ws/war-room`);

    if (RUNNER_ENABLED) {
      console.log(`♻ Runner enabled. Interval: ${RUNNER_INTERVAL_SEC}s`);
      setInterval(runnerTick, RUNNER_INTERVAL_SEC * 1000);
      // kick once immediately
      runnerTick();
    } else {
      console.log("⏸ Runner disabled (set RUNNER_ENABLED=true to generate continuous activity)");
    }
  });
})();
