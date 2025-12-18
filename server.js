import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";

import {
  initDb,
  insertLearningEvent,
  getHistoricalPatterns,
  calculateAccuracyFromPatterns,
  getLearningImpact,
  hasDb,
} from "./db.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 8080;

// ---------------------------
// BASIC SETUP
// ---------------------------
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Serve homepage
app.get("/", (req, res) => {
  res.sendFile(path.resolve("public", "index.html"));
});

// ============================================
// HELPERS: PRICES + NEWS + ANALYSIS
// ============================================

async function getStockPrice(symbol) {
  const apiKey = process.env.FINNHUB_API_KEY;

  if (!apiKey) {
    return {
      price: Math.random() * 500 + 100,
      change: Math.random() * 10 - 5,
      changePercent: Math.random() * 5 - 2.5,
      high: null,
      low: null,
      open: null,
      previousClose: null,
    };
  }

  try {
    const response = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${apiKey}`
    );
    const data = await response.json();

    return {
      price: data.c,
      change: data.d,
      changePercent: data.dp,
      high: data.h,
      low: data.l,
      open: data.o,
      previousClose: data.pc,
    };
  } catch (error) {
    console.error(`Error fetching price for ${symbol}:`, error.message);
    return null;
  }
}

function getMockNews(symbol) {
  const templates = [
    { title: `${symbol} reports strong Q4 earnings`, sentiment: 0.8 },
    { title: `Analysts upgrade ${symbol} to Buy`, sentiment: 0.6 },
    { title: `${symbol} announces new product line`, sentiment: 0.5 },
    { title: `${symbol} faces regulatory scrutiny`, sentiment: -0.4 },
    { title: `Market volatility affects ${symbol}`, sentiment: -0.2 },
  ];

  return templates.map((t) => ({
    ...t,
    description: `News about ${symbol}`,
    url: "#",
    publishedAt: new Date().toISOString(),
    source: "Mock News",
  }));
}

function analyzeSentiment(text) {
  const positive = [
    "surge", "growth", "profit", "beat", "strong",
    "record", "upgrade", "bullish", "gain", "rise",
  ];
  const negative = [
    "drop", "loss", "miss", "weak", "concern",
    "downgrade", "bearish", "fall", "decline",
  ];

  const lowerText = (text || "").toLowerCase();
  let score = 0;

  positive.forEach((word) => {
    if (lowerText.includes(word)) score += 0.1;
  });
  negative.forEach((word) => {
    if (lowerText.includes(word)) score -= 0.1;
  });

  return Math.max(-1, Math.min(1, score));
}

async function getCompanyNews(symbol) {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) return getMockNews(symbol);

  try {
    const today = new Date().toISOString().split("T")[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const response = await fetch(
      `https://newsapi.org/v2/everything?q=${symbol}&from=${weekAgo}&to=${today}&sortBy=relevancy&apiKey=${apiKey}`
    );

    const data = await response.json();

    return (
      data.articles?.slice(0, 10).map((article) => ({
        title: article.title,
        description: article.description,
        url: article.url,
        publishedAt: article.publishedAt,
        source: article.source?.name || "Unknown",
        sentiment: analyzeSentiment(
          (article.title || "") + " " + (article.description || "")
        ),
      })) || []
    );
  } catch (error) {
    console.error(`Error fetching news for ${symbol}:`, error.message);
    return getMockNews(symbol);
  }
}

function generateBasicAnalysis(symbol, news, priceData) {
  const sentimentScore =
    news.reduce((sum, n) => sum + (n.sentiment || 0), 0) / (news.length || 1);
  const priceChange = priceData?.changePercent || 0;

  let signal = "HOLD";
  let confidence = 50;

  if (sentimentScore > 0.3 && priceChange > 2) {
    signal = "BUY"; confidence = 75;
  } else if (sentimentScore > 0.1 && priceChange > 0) {
    signal = "BUY"; confidence = 65;
  } else if (sentimentScore < -0.3 && priceChange < -2) {
    signal = "SELL"; confidence = 75;
  } else if (sentimentScore < -0.1 && priceChange < 0) {
    signal = "SELL"; confidence = 65;
  }

  return {
    signal,
    confidence,
    reasoning: `Based on sentiment (${sentimentScore.toFixed(2)}) and price trend (${priceChange.toFixed(2)}%)`,
    targetPrice: priceData.price * (signal === "BUY" ? 1.05 : 0.95),
    stopLoss: priceData.price * (signal === "BUY" ? 0.95 : 1.05),
    timeHorizon: Math.abs(priceChange) > 3 ? "short" : "medium",
  };
}

// ============================================
// API ENDPOINTS
// ============================================

// Fast popular stocks (no AI, no news) for UI speed
app.get("/api/popular-fast", async (req, res) => {
  try {
    const symbols = ["AAPL", "NVDA", "TSLA", "MSFT", "GOOGL", "META"];

    const data = await Promise.all(symbols.map(async (symbol) => {
      const priceData = await getStockPrice(symbol);
      if (!priceData) return null;

      const change = priceData.changePercent || 0;
      const signal = change > 1 ? "BUY" : change < -1 ? "SELL" : "HOLD";
      const confidence = Math.min(90, Math.max(50, Math.round(Math.abs(change) * 15 + 50)));

      return {
        symbol,
        price: priceData.price,
        change,
        signal,
        confidence,
        reasoning: "Fast signal (no AI) for quick overview",
      };
    }));

    res.json(data.filter(Boolean));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// News endpoint separated from analysis (reliable UI)
app.get("/api/news/:symbol", async (req, res) => {
  try {
    const news = await getCompanyNews(req.params.symbol);
    res.json({ news: (news || []).slice(0, 10) });
  } catch (e) {
    res.status(500).json({ error: e.message, news: [] });
  }
});

// Learning impact over time (NEW)
app.get("/api/learning/impact/:symbol", async (req, res) => {
  try {
    const symbol = String(req.params.symbol || "").toUpperCase().trim();
    const strategy = req.query.strategy ? String(req.query.strategy).trim() : null;
    const bucket = req.query.bucket ? String(req.query.bucket).trim() : "hour";
    const limit = req.query.limit ? Number(req.query.limit) : 72;

    if (!symbol) return res.status(400).json({ ok: false, error: "Missing symbol" });

    const impact = await getLearningImpact({ symbol, strategy, bucket, limit });

    res.json({
      ok: true,
      hasDb: hasDb(),
      symbol,
      strategy: strategy || "ALL",
      bucket: bucket === "day" ? "day" : "hour",
      limit,
      ...impact,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Persist learning outcome (writes to Postgres)
app.post("/api/learn", async (req, res) => {
  try {
    const { symbol, signal, priceAtSignal, priceAfter, strategy, horizon } = req.body;

    if (!symbol || !signal || typeof priceAtSignal !== "number" || typeof priceAfter !== "number") {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const row = await insertLearningEvent({
      symbol: String(symbol).toUpperCase().trim(),
      signal: String(signal).toUpperCase().trim(),
      priceAtSignal,
      priceAfter,
      strategy: strategy ? String(strategy).trim() : "global",
      horizon: horizon ? String(horizon).trim() : "medium",
    });

    const patterns = await getHistoricalPatterns(String(symbol).toUpperCase().trim(), 50);

    res.json({
      success: true,
      stored: !!row,
      event: row,
      totalPatterns: patterns.length,
      historicalAccuracy: calculateAccuracyFromPatterns(patterns),
      persistence: hasDb() ? "postgres" : "none",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health
app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    apis: {
      finnhub: !!process.env.FINNHUB_API_KEY,
      newsApi: !!process.env.NEWS_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      postgres: hasDb(),
    },
    version: "learning-impact-v1",
  });
});

// ---------------------------
// START SERVER (DB init should never block startup)
// ---------------------------
async function start() {
  try {
    await initDb();
  } catch (e) {
    console.error("⚠️ DB init failed, starting server anyway:", e.message);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

start();
