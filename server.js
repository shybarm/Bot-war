/**
 * AI Trading Arena - War Room Edition (Stable WS + Carousel + Simple History)
 * - WebSocket path: /ws/war-room
 * - Stock failover: Finnhub -> TwelveData
 * - News failover: NewsData -> NewsAPI
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

import {
  initDb,
  getBotAccounts,
  getBotPositions,
  recordTrade,
  getRecentTrades
} from "./db.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const APP_VERSION = "arena-warroom-v3.1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// -------------------------
// STOCK FAILOVER
// -------------------------
async function finnhubQuote(symbol) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error("FINNHUB_API_KEY missing");
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${key}`);
  const j = await r.json();
  if (!j || !j.c) throw new Error("Finnhub returned no price");
  return { provider: "finnhub", price: j.c, changePercent: j.dp ?? 0, change: j.d ?? 0 };
}

async function twelveDataQuote(symbol) {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new Error("TWELVEDATA_API_KEY missing");
  const r = await fetch(`https://api.twelvedata.com/price?symbol=${symbol}&apikey=${key}`);
  const j = await r.json();
  if (!j || !j.price) throw new Error("TwelveData returned no price");
  return { provider: "twelvedata", price: Number(j.price), changePercent: 0, change: 0 };
}

async function getStockQuote(symbol) {
  try {
    return await finnhubQuote(symbol);
  } catch {
    return await twelveDataQuote(symbol);
  }
}

// -------------------------
// NEWS FAILOVER
// -------------------------
function sentimentScore(text = "") {
  const pos = ["gain", "surge", "strong", "profit", "upgrade", "beats", "record"];
  const neg = ["drop", "weak", "loss", "downgrade", "fall", "miss", "lawsuit"];
  const t = text.toLowerCase();
  let s = 0;
  for (const w of pos) if (t.includes(w)) s += 0.1;
  for (const w of neg) if (t.includes(w)) s -= 0.1;
  return Math.max(-1, Math.min(1, s));
}

async function newsdataNews(symbol) {
  const key = process.env.NEWSDATA_API_KEY;
  if (!key) throw new Error("NEWSDATA_API_KEY missing");
  const r = await fetch(`https://newsdata.io/api/1/news?apikey=${key}&q=${symbol}&language=en`);
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
  const r = await fetch(
    `https://newsapi.org/v2/everything?q=${symbol}&language=en&sortBy=relevancy&apiKey=${key}`
  );
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
  try {
    return await newsdataNews(symbol);
  } catch {
    return await newsApiNews(symbol);
  }
}

// -------------------------
// BOT LOGIC
// -------------------------
function computeFeatures(quote, news) {
  const avgSent = news.reduce((a, n) => a + (n.sentiment || 0), 0) / (news.length || 1);
  return { avgSent, changePercent: quote.changePercent ?? 0 };
}

function botSignal(strategy, f) {
  if (strategy === "sp500_long") {
    if (f.avgSent > 0.15) return { signal: "BUY", rationale: "Macro sentiment strong" };
    if (f.avgSent < -0.15) return { signal: "SELL", rationale: "Macro sentiment negative" };
    return { signal: "HOLD", rationale: "Macro sentiment neutral" };
  }
  if (strategy === "market_swing") {
    if (f.avgSent > 0.1 && f.changePercent > 0) return { signal: "BUY", rationale: "Sentiment + momentum alignment" };
    if (f.avgSent < -0.1 && f.changePercent < 0) return { signal: "SELL", rationale: "Momentum breakdown" };
    return { signal: "HOLD", rationale: "Swing conditions unclear" };
  }
  if (f.changePercent > 1.2) return { signal: "BUY", rationale: "Intraday breakout" };
  if (f.changePercent < -1.2) return { signal: "SELL", rationale: "Intraday breakdown" };
  return { signal: "HOLD", rationale: "Flat intraday tape" };
}

function buyBudgetPct(strategy) {
  if (strategy === "day_trade") return 0.30;
  if (strategy === "market_swing") return 0.20;
  return 0.15;
}

// -------------------------
// Start HTTP server
// -------------------------
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 War Room server running on PORT ${PORT}`);
});

// -------------------------
// WebSocket server on /ws/war-room
// -------------------------
const wss = new WebSocketServer({ server, path: "/ws/war-room" });

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// carousel memory
const tradedSymbols = [];
const MAX_SYMBOLS = 20;

// -------------------------
// History endpoint (simple line)
// -------------------------
app.get("/api/history/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const q = await getStockQuote(symbol);
    const now = Math.floor(Date.now() / 1000);
    const data = [];
    for (let i = 60; i >= 1; i--) {
      data.push({ time: now - i, value: q.price + Math.sin(i / 3) * 0.6 });
    }
    res.json({ ok: true, data, sentiment: [] });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// -------------------------
// War Room endpoints
// -------------------------
async function buildPortfolioSnapshot() {
  const bots = await getBotAccounts();
  const positions = {};
  for (const b of bots) positions[b.strategy] = await getBotPositions(b.strategy);
  return { bots, positions };
}

app.get("/api/war/bots", async (req, res) => res.json(await buildPortfolioSnapshot()));
app.get("/api/war/trades", async (req, res) => res.json({ ok: true, rows: await getRecentTrades({ limit: 50 }) }));
app.get("/api/war/symbols", (req, res) => res.json({ ok: true, symbols: tradedSymbols }));

// -------------------------
// Bot Fight
// -------------------------
app.get("/api/fight/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const quote = await getStockQuote(symbol);

    let news = [];
    try {
      news = await getNewsBundle(symbol);
    } catch {
      news = [];
    }

    const f = computeFeatures(quote, news);

    const bots = await getBotAccounts();
    const map = Object.fromEntries(bots.map(b => [b.strategy, b]));

    const strategies = ["sp500_long", "market_swing", "day_trade"];
    const trades = [];

    for (const s of strategies) {
      const sig = botSignal(s, f);
      const acc = map[s];
      const note = `${sig.rationale} | Sentiment ${f.avgSent.toFixed(2)}`;

      broadcast("reasoning", { ts: Date.now(), strategy: s, rationale: sig.rationale });

      if (sig.signal === "BUY") {
        const budget = acc.cash * buyBudgetPct(s);
        if (budget > 50) {
          const qty = budget / quote.price;
          await recordTrade({ strategy: s, symbol, side: "BUY", qty, price: quote.price, note });
          trades.push({ strategy: s, symbol, side: "BUY", qty, price: quote.price, note });
        }
      }

      if (sig.signal === "SELL") {
        const pos = await getBotPositions(s);
        const p = pos.find(x => x.symbol === symbol);
        if (p && p.qty > 0) {
          await recordTrade({ strategy: s, symbol, side: "SELL", qty: p.qty, price: quote.price, note });
          trades.push({ strategy: s, symbol, side: "SELL", qty: p.qty, price: quote.price, note });
        }
      }
    }

    // update carousel
    if (!tradedSymbols.includes(symbol)) {
      tradedSymbols.unshift(symbol);
      if (tradedSymbols.length > MAX_SYMBOLS) tradedSymbols.pop();
    }

    // broadcast events
    for (const t of trades) broadcast("trade", t);
    broadcast("symbols", tradedSymbols);
    broadcast("sentiment", { symbol, price: quote.price, sentiment: f.avgSent, ts: Date.now() });
    broadcast("portfolio", await buildPortfolioSnapshot());

    res.json({ ok: true, symbol, quote, features: f, news, trades, version: APP_VERSION });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------------------
// Init DB (don’t crash the app if DB init fails)
// -------------------------
(async function start() {
  try {
    await initDb();
    console.log("✅ DB Ready");
  } catch (e) {
    console.error("❌ DB init error:", e.message);
  }
})();
