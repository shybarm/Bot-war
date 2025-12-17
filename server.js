/**
 * AI Trading Arena - War Room Edition (WebSocket + Carousel + Simple History)
 * --------------------------------------------------------------------------
 * This file includes:
 * - Stock failover (Finnhub → TwelveData)
 * - News failover (NewsData.io → NewsAPI)
 * - War Room WebSocket server
 * - Real-time trades, reasoning, sentiment, portfolio broadcasting
 * - Auto-updating symbol carousel
 * - Simple historical line data for TradingView
 * - Bot fight engine + trade execution
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket, { WebSocketServer } from "ws";

import {
  initDb,
  hasDb,
  getSetting,
  setSetting,
  logBotDecision,
  getBotAccounts,
  getBotPositions,
  recordTrade,
  getRecentTrades
} from "./db.js";

dotenv.config();

// --------------------------------------------------
// Setup
// --------------------------------------------------

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const APP_VERSION = "arena-warroom-v3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// --------------------------------------------------
// STOCK PROVIDERS (Failover: Finnhub → TwelveData)
// --------------------------------------------------

async function finnhubQuote(symbol) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error("FINNHUB_API_KEY missing");

  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${key}`);
  const j = await r.json();

  if (!j.c) throw new Error("Finnhub returned no price");

  return {
    provider: "finnhub",
    price: j.c,
    changePercent: j.dp ?? 0,
    change: j.d ?? 0
  };
}

async function twelveDataQuote(symbol) {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new Error("TWELVEDATA_API_KEY missing");

  const r = await fetch(`https://api.twelvedata.com/price?symbol=${symbol}&apikey=${key}`);
  const j = await r.json();

  if (!j.price) throw new Error("TwelveData returned no price");

  return {
    provider: "twelvedata",
    price: Number(j.price),
    changePercent: 0,
    change: 0
  };
}

async function getStockQuote(symbol) {
  try {
    return await finnhubQuote(symbol);
  } catch (e) {
    try {
      return await twelveDataQuote(symbol);
    } catch (e2) {
      throw new Error("Both stock providers failed");
    }
  }
}

// --------------------------------------------------
// NEWS PROVIDERS (Failover: NewsData → NewsAPI)
// --------------------------------------------------

function sentimentScore(text = "") {
  const pos = ["gain", "surge", "strong", "profit", "upgrade"];
  const neg = ["drop", "weak", "loss", "downgrade", "fall"];

  let s = 0;
  const t = text.toLowerCase();

  pos.forEach(w => t.includes(w) && (s += 0.1));
  neg.forEach(w => t.includes(w) && (s -= 0.1));

  return Math.max(-1, Math.min(1, s));
}

async function newsdataNews(symbol) {
  const key = process.env.NEWSDATA_API_KEY;
  if (!key) throw new Error("NEWSDATA_API_KEY missing");

  const r = await fetch(`https://newsdata.io/api/1/news?apikey=${key}&q=${symbol}&language=en`);
  const j = await r.json();

  if (!j.results) throw new Error("NewsData failed");

  return j.results.slice(0, 8).map(n => ({
    title: n.title,
    description: n.description,
    url: n.link,
    publishedAt: n.pubDate,
    provider: "newsdata",
    sentiment: sentimentScore(n.title + " " + n.description)
  }));
}

async function newsApiNews(symbol) {
  const key = process.env.NEWSAPI_BACKUP_KEY;
  if (!key) throw new Error("NEWSAPI_BACKUP_KEY missing");

  const r = await fetch(
    `https://newsapi.org/v2/everything?q=${symbol}&language=en&sortBy=relevancy&apiKey=${key}`
  );
  const j = await r.json();

  if (!j.articles) throw new Error("NewsAPI failed");

  return j.articles.slice(0, 8).map(a => ({
    title: a.title,
    description: a.description,
    url: a.url,
    publishedAt: a.publishedAt,
    provider: "newsapi",
    sentiment: sentimentScore(a.title + " " + a.description)
  }));
}

async function getNewsBundle(symbol) {
  try {
    return await newsdataNews(symbol);
  } catch (e) {
    return await newsApiNews(symbol);
  }
}

// --------------------------------------------------
// Bot Intelligence
// --------------------------------------------------

function computeFeatures(quote, news) {
  const avgSent = news.reduce((a, n) => a + n.sentiment, 0) / (news.length || 1);

  return {
    avgSent,
    changePercent: quote.changePercent
  };
}

function botSignal(strategy, f) {
  if (strategy === "sp500_long") {
    if (f.avgSent > 0.15) return { signal: "BUY", rationale: "Macro sentiment strong" };
    if (f.avgSent < -0.15) return { signal: "SELL", rationale: "Macro sentiment negative" };
    return { signal: "HOLD", rationale: "Macro sentiment neutral" };
  }

  if (strategy === "market_swing") {
    if (f.avgSent > 0.1 && f.changePercent > 0)
      return { signal: "BUY", rationale: "Sentiment + momentum alignment" };
    if (f.avgSent < -0.1 && f.changePercent < 0)
      return { signal: "SELL", rationale: "Momentum breakdown" };
    return { signal: "HOLD", rationale: "Swing conditions unclear" };
  }

  // day trade
  if (f.changePercent > 1.2)
    return { signal: "BUY", rationale: "Intraday breakout" };
  if (f.changePercent < -1.2)
    return { signal: "SELL", rationale: "Intraday breakdown" };
  return { signal: "HOLD", rationale: "Flat intraday tape" };
}

function buyBudgetPct(strategy) {
  if (strategy === "day_trade") return 0.30;
  if (strategy === "market_swing") return 0.20;
  return 0.15;
}

// --------------------------------------------------
// WebSocket Server (War Room)
// --------------------------------------------------

const server = app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 War Room server running on PORT ${PORT}`)
);

const wss = new WebSocketServer({ server });

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// Track recently traded symbols (carousel)
const tradedSymbols = [];
const MAX_SYMBOLS = 20;

// --------------------------------------------------
// Simple History Endpoint (TradingView Line Data)
// --------------------------------------------------

app.get("/api/history/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

  try {
    // Produce simple synthetic line history
    // Based on live quote baseline
    const q = await getStockQuote(symbol);

    const data = [];
    const now = Math.floor(Date.now() / 1000);

    for (let i = 60; i >= 1; i--) {
      data.push({
        time: now - i,
        value: q.price + (Math.sin(i / 3) * 0.6)
      });
    }

    res.json({ ok: true, data, sentiment: [] });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// --------------------------------------------------
// BOT FIGHT (Main Trading Logic)
// --------------------------------------------------

app.get("/api/fight/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();

    const quote = await getStockQuote(symbol);
    const news = await getNewsBundle(symbol);
    const f = computeFeatures(quote, news);

    const bots = await getBotAccounts();
    const map = Object.fromEntries(bots.map(b => [b.strategy, b]));

    const strategies = ["sp500_long", "market_swing", "day_trade"];
    const trades = [];

    for (const s of strategies) {
      const sig = botSignal(s, f);
      const acc = map[s];
      const note = `${sig.rationale} | Sentiment ${f.avgSent.toFixed(2)}`;

      // reasoning broadcast
      broadcast("reasoning", {
        ts: Date.now(),
        strategy: s,
        rationale: sig.rationale
      });

      // BUY
      if (sig.signal === "BUY") {
        const budget = acc.cash * buyBudgetPct(s);
        if (budget > 50) {
          const qty = budget / quote.price;

          await recordTrade({
            strategy: s,
            symbol,
            side: "BUY",
            qty,
            price: quote.price,
            note
          });

          trades.push({ strategy: s, symbol, side: "BUY", qty, price: quote.price, note });
        }
      }

      // SELL
      if (sig.signal === "SELL") {
        const pos = await getBotPositions(s);
        const p = pos.find(x => x.symbol === symbol);

        if (p) {
          await recordTrade({
            strategy: s,
            symbol,
            side: "SELL",
            qty: p.qty,
            price: quote.price,
            note
          });

          trades.push({ strategy: s, symbol, side: "SELL", qty: p.qty, price: quote.price, note });
        }
      }
    }

    // Update carousel symbols
    if (!tradedSymbols.includes(symbol)) {
      tradedSymbols.unshift(symbol);
      if (tradedSymbols.length > MAX_SYMBOLS) tradedSymbols.pop();
    }

    // Broadcast trades
    trades.forEach(t => broadcast("trade", t));

    // Broadcast symbol list
    broadcast("symbols", tradedSymbols);

    // Broadcast sentiment tick
    broadcast("sentiment", {
      symbol,
      price: quote.price,
      sentiment: f.avgSent,
      ts: Date.now()
    });

    // Broadcast portfolio snapshot
    const snapshot = await buildPortfolioSnapshot();
    broadcast("portfolio", snapshot);

    res.json({
      ok: true,
      symbol,
      quote,
      features: f,
      news,
      trades,
      version: APP_VERSION
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// --------------------------------------------------
// War Room Portfolio Snapshot
// --------------------------------------------------

async function buildPortfolioSnapshot() {
  const bots = await getBotAccounts();
  const positions = {};

  for (const b of bots) {
    positions[b.strategy] = await getBotPositions(b.strategy);
  }

  return { bots, positions };
}

app.get("/api/war/bots", async (req, res) => {
  res.json(await buildPortfolioSnapshot());
});

app.get("/api/war/trades", async (req, res) => {
  res.json({ ok: true, rows: await getRecentTrades({ limit: 50 }) });
});

app.get("/api/war/symbols", (req, res) => {
  res.json({ ok: true, symbols: tradedSymbols });
});

// --------------------------------------------------
// STARTUP
// --------------------------------------------------

(async function start() {
  try {
    await initDb();
    console.log("DB Ready");
  } catch (e) {
    console.error("DB init error:", e.message);
  }
})();
