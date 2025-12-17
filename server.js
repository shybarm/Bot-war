import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

import {
  initDb,
  hasDb,
  insertLearningEvent,
  getStrategyAccuracy,
  logBotDecision,
  getDueDecisions,
  markDecisionEvaluated,
  getLearningSummary,
} from "./db.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 8080;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ------------------ External data ------------------

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

// Default: NewsAPI. (You said you changed provider; keep this working by using your provider’s key here.)
// If you now use Finnhub news, swap this implementation later — but keep it as-is if it works for you.
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

// ------------------ OpenAI analysis ------------------

async function openaiAnalyze({ symbol, quote, news }) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      signal: "HOLD",
      confidence: 50,
      reasoning: "OPENAI_API_KEY missing. Using HOLD fallback.",
      targetPrice: quote.price,
      stopLoss: quote.price,
      timeHorizon: "medium"
    };
  }

  const headlines = news.slice(0, 6).map(n => n.title).join("; ");

  const prompt = `
Analyze ${symbol} for a trading signal.

Price:
- Current: ${quote.price}
- Change%: ${quote.changePercent}

Headlines:
${headlines}

Return VALID JSON ONLY:
{
 "signal":"BUY|SELL|HOLD",
 "confidence":0-100,
 "reasoning":"string",
 "targetPrice":number,
 "stopLoss":number,
 "timeHorizon":"short|medium|long"
}
`.\db?.trim?.() || prompt.trim(); // harmless safeguard

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4",
      temperature: 0.4,
      max_tokens: 350,
      messages: [
        { role: "system", content: "You are a cautious market analyst. Output JSON only." },
        { role: "user", content: prompt.trim() }
      ]
    })
  });

  const j = await r.json();
  const text = j?.choices?.[0]?.message?.content || "{}";

  try {
    return JSON.parse(text);
  } catch {
    return {
      signal: "HOLD",
      confidence: 50,
      reasoning: "AI response was not valid JSON; fallback to HOLD.",
      targetPrice: quote.price,
      stopLoss: quote.price,
      timeHorizon: "medium"
    };
  }
}

// ------------------ Learning evaluation ------------------

async function evaluateDueDecisions(limit = 20) {
  if (!hasDb()) return { evaluated: 0, stored: 0, reason: "no_db" };

  let due = [];
  try {
    due = await getDueDecisions(limit);
  } catch {
    return { evaluated: 0, stored: 0, reason: "db_unavailable" };
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
      // Leave decision pending if price fetch fails; do not crash the app
    }
  }

  return { evaluated, stored };
}

// ------------------ Bots logic ------------------

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

function horizonToEvalAfterSec(horizon) {
  if (horizon === "short") return 4 * 60 * 60;        // 4 hours
  if (horizon === "medium") return 3 * 24 * 60 * 60;  // 3 days
  return 14 * 24 * 60 * 60;                           // 14 days
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

// ------------------ API routes ------------------

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    apis: {
      finnhub: !!process.env.FINNHUB_API_KEY,
      newsApi: !!process.env.NEWS_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      postgres: hasDb()
    }
  });
});

app.get("/api/market-overview", async (req, res) => {
  try {
    const symbols = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "AMD"];
    const rows = await Promise.all(symbols.map(async (s) => {
      const q = await finnhubQuote(s);
      return { symbol: s, price: q.price, change: q.changePercent };
    }));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
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

app.get("/api/analyze/:symbol", async (req, res) => {
  try {
    await evaluateDueDecisions(10);

    const symbol = req.params.symbol.toUpperCase();
    const [quote, news] = await Promise.all([finnhubQuote(symbol), newsFor(symbol)]);
    const analysis = await openaiAnalyze({ symbol, quote, news });

    res.json({ symbol, quote, news: news.slice(0, 6), analysis });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/bots/:symbol", async (req, res) => {
  try {
    await evaluateDueDecisions(20);

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

    // Log decisions for learning
    let logged = 0;
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
      } catch {
        logged = 0; // DB temporarily unavailable; keep serving
      }
    }

    const scored = await scoreBots(symbol, botsRaw);

    res.json({
      symbol,
      features,
      logged,
      ...scored
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/evaluate", async (req, res) => {
  try {
    const limit = Number(req.body?.limit) || 20;
    const result = await evaluateDueDecisions(Math.min(50, Math.max(1, limit)));
    res.json({ success: true, ...result });
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

// ------------------ Start ------------------

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
