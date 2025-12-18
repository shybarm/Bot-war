// server.js (ESM)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";

import {
  hasDb,
  dbInit,
  dbQuery,
  getSetting,
  setSetting,
} from "./db.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Serve public/
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// -----------------------------
// Providers + Failover
// -----------------------------
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY || "";

// News primary: NewsData.io (you already use NEWS_API_KEY)
// News backup: NewsAPI.org (you stored as NEWSAPI_BACKUP_KEY in Railway)
const NEWSDATA_KEY = process.env.NEWS_API_KEY || "";
const NEWSAPI_KEY = process.env.NEWSAPI_BACKUP_KEY || "";

async function safeJson(res) {
  const text = await res.text();
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, text };
  }
}

// Stock price: Finnhub -> TwelveData
async function getStockPrice(symbol) {
  const s = symbol.toUpperCase().trim();

  // 1) Finnhub
  if (FINNHUB_KEY) {
    try {
      const r = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
          s
        )}&token=${FINNHUB_KEY}`,
        { timeout: 15000 }
      );
      if (r.ok) {
        const data = await r.json();
        if (typeof data?.c === "number") {
          return {
            provider: "finnhub",
            symbol: s,
            price: data.c,
            change: data.d ?? 0,
            changePercent: data.dp ?? 0,
          };
        }
      }
      // If rate-limited or invalid, fallthrough
    } catch {}
  }

  // 2) TwelveData backup
  if (TWELVEDATA_KEY) {
    try {
      // real-time price endpoint
      const r = await fetch(
        `https://api.twelvedata.com/price?symbol=${encodeURIComponent(
          s
        )}&apikey=${TWELVEDATA_KEY}`,
        { timeout: 15000 }
      );
      const parsed = await safeJson(r);
      if (parsed.ok && parsed.json?.price) {
        const price = Number(parsed.json.price);
        if (Number.isFinite(price)) {
          return {
            provider: "twelvedata",
            symbol: s,
            price,
            change: 0,
            changePercent: 0,
          };
        }
      }
    } catch {}
  }

  // fallback mock
  return {
    provider: "mock",
    symbol: s,
    price: Math.round((100 + Math.random() * 400) * 100) / 100,
    change: 0,
    changePercent: 0,
  };
}

// News: NewsData.io -> NewsAPI.org
async function getNews(symbol, limit = 8) {
  const s = symbol.toUpperCase().trim();

  // 1) NewsData.io (primary)
  if (NEWSDATA_KEY) {
    try {
      // NewsData uses /api/1/news?apikey=...&q=... (common pattern)
      const r = await fetch(
        `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(
          NEWSDATA_KEY
        )}&q=${encodeURIComponent(s)}&language=en`,
        { timeout: 15000 }
      );
      const parsed = await safeJson(r);
      if (parsed.ok && Array.isArray(parsed.json?.results)) {
        const items = parsed.json.results.slice(0, limit).map((a) => ({
          title: a.title || "",
          url: a.link || "",
          source: a.source_id || "newsdata",
          publishedAt: a.pubDate || "",
          summary: a.description || "",
        }));
        return { provider: "newsdata", items };
      }

      // If auth issue or rate limit, fallthrough to backup.
    } catch {}
  }

  // 2) NewsAPI.org (backup)
  if (NEWSAPI_KEY) {
    try {
      const r = await fetch(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(
          s
        )}&language=en&pageSize=${limit}&sortBy=publishedAt`,
        {
          timeout: 15000,
          headers: { "X-Api-Key": NEWSAPI_KEY },
        }
      );
      const parsed = await safeJson(r);
      if (parsed.ok && Array.isArray(parsed.json?.articles)) {
        const items = parsed.json.articles.slice(0, limit).map((a) => ({
          title: a.title || "",
          url: a.url || "",
          source: a.source?.name || "newsapi",
          publishedAt: a.publishedAt || "",
          summary: a.description || "",
        }));
        return { provider: "newsapi", items };
      }
    } catch {}
  }

  // fallback
  const items = Array.from({ length: Math.min(limit, 4) }).map((_, i) => ({
    title: `${s} news placeholder #${i + 1}`,
    url: "#",
    source: "mock",
    publishedAt: new Date().toISOString(),
    summary: "No provider available",
  }));
  return { provider: "mock", items };
}

// Sentiment heuristic (fast)
function sentimentScore(text) {
  const t = (text || "").toLowerCase();
  const pos = [
    "surge",
    "beats",
    "profit",
    "upgrade",
    "strong",
    "record",
    "growth",
    "bullish",
    "rally",
  ];
  const neg = [
    "miss",
    "drop",
    "downgrade",
    "weak",
    "lawsuit",
    "probe",
    "bearish",
    "decline",
    "fall",
  ];
  let score = 0;
  for (const w of pos) if (t.includes(w)) score += 0.12;
  for (const w of neg) if (t.includes(w)) score -= 0.12;
  return Math.max(-1, Math.min(1, score));
}

// -----------------------------
// Bots + Portfolio (4 bots)
// -----------------------------
const BOTS = [
  { bot: "sp500_long", label: "S&P500 Long", horizon: "long" },
  { bot: "market_swing", label: "Market Swing", horizon: "medium" },
  { bot: "day_trade", label: "Day Trade", horizon: "short" },
  { bot: "news_only", label: "News-Only", horizon: "short" }, // 4th bot
];

const START_CASH = 100000;
const GOAL_CASH = 150000;

async function ensurePortfolios() {
  if (!hasDb) return;
  for (const b of BOTS) {
    await dbQuery(
      `
      INSERT INTO portfolios(bot, cash, goal)
      VALUES ($1, $2, $3)
      ON CONFLICT (bot) DO NOTHING
    `,
      [b.bot, START_CASH, GOAL_CASH]
    );
  }
}

function decideSignal({ bot, avgSent, changePercent }) {
  // simple differentiated behaviors
  if (bot === "sp500_long") {
    if (avgSent > 0.15) return { signal: "BUY", confidence: 62, why: "Positive news drift (long horizon)" };
    if (avgSent < -0.2) return { signal: "HOLD", confidence: 58, why: "Negative sentiment; long bot avoids churn" };
    return { signal: "HOLD", confidence: 55, why: "No long-term edge detected" };
  }

  if (bot === "market_swing") {
    if (avgSent > 0.05 && changePercent < 0) return { signal: "BUY", confidence: 64, why: "Positive news + dip = swing entry" };
    if (avgSent < -0.1 && changePercent > 0) return { signal: "SELL", confidence: 63, why: "Negative news + pop = exit/reversal" };
    return { signal: "HOLD", confidence: 54, why: "No swing setup" };
  }

  if (bot === "day_trade") {
    if (Math.abs(changePercent) > 0.7) {
      const dir = changePercent < 0 ? "BUY" : "SELL";
      return { signal: dir, confidence: 60, why: "Short-term momentum mean-reversion" };
    }
    return { signal: "HOLD", confidence: 53, why: "Range noise" };
  }

  // news_only: ignore price, trade only on news sentiment
  if (bot === "news_only") {
    if (avgSent > 0.18) return { signal: "BUY", confidence: 66, why: "Trades strictly on positive news cluster" };
    if (avgSent < -0.18) return { signal: "SELL", confidence: 66, why: "Trades strictly on negative news cluster" };
    return { signal: "HOLD", confidence: 55, why: "News signal not strong enough" };
  }

  return { signal: "HOLD", confidence: 50, why: "Default" };
}

async function recordTrade({ bot, symbol, side, qty, price, rationale, confidence, horizon }) {
  if (!hasDb) return null;
  const r = await dbQuery(
    `
    INSERT INTO trades(bot, symbol, side, qty, price, rationale, confidence, horizon)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *
  `,
    [bot, symbol, side, qty, price, rationale, confidence, horizon]
  );
  return r.rows[0];
}

async function applyTradeToPortfolio({ bot, symbol, side, qty, price }) {
  if (!hasDb) return;

  // Get current portfolio
  const pr = await dbQuery(`SELECT cash, goal FROM portfolios WHERE bot=$1`, [bot]);
  if (!pr.rows[0]) return;

  let cash = Number(pr.rows[0].cash);

  // Get position
  const pos = await dbQuery(
    `SELECT qty, avg_price FROM positions WHERE bot=$1 AND symbol=$2`,
    [bot, symbol]
  );
  let curQty = pos.rows[0] ? Number(pos.rows[0].qty) : 0;
  let avgPrice = pos.rows[0] ? Number(pos.rows[0].avg_price) : 0;

  if (side === "BUY" && qty > 0) {
    const cost = qty * price;
    if (cash < cost) return; // no margin for MVP
    const newQty = curQty + qty;
    const newAvg = newQty === 0 ? 0 : (curQty * avgPrice + qty * price) / newQty;
    cash -= cost;
    curQty = newQty;
    avgPrice = newAvg;
  }

  if (side === "SELL" && qty > 0) {
    const sellQty = Math.min(curQty, qty);
    const proceeds = sellQty * price;
    cash += proceeds;
    curQty = curQty - sellQty;
    if (curQty === 0) avgPrice = 0;
  }

  await dbQuery(
    `UPDATE portfolios SET cash=$2, updated_at=NOW() WHERE bot=$1`,
    [bot, cash]
  );

  await dbQuery(
    `
    INSERT INTO positions(bot, symbol, qty, avg_price, updated_at)
    VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (bot, symbol)
    DO UPDATE SET qty=$3, avg_price=$4, updated_at=NOW()
  `,
    [bot, symbol, curQty, avgPrice]
  );
}

async function logLearningSample({ bot, strategy, symbol, signal, horizon, priceAtSignal, features, rationale, confidence, evalAfterSec }) {
  if (!hasDb) return null;
  const r = await dbQuery(
    `
    INSERT INTO learning_samples(bot, strategy, symbol, signal, horizon, price_at_signal, features, rationale, confidence, eval_after_sec)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
    RETURNING id
  `,
    [bot, strategy, symbol, signal, horizon, priceAtSignal, JSON.stringify(features || {}), rationale || "", confidence || 50, evalAfterSec]
  );
  return r.rows[0]?.id ?? null;
}

async function evaluateDueLearning() {
  if (!hasDb) return { evaluated: 0 };

  // Find samples where eval time has passed and not evaluated
  const due = await dbQuery(
    `
    SELECT id, symbol, signal, price_at_signal, eval_after_sec
    FROM learning_samples
    WHERE evaluated_at IS NULL
      AND created_at + (eval_after_sec || ' seconds')::interval <= NOW()
    ORDER BY created_at ASC
    LIMIT 50
  `
  );

  let evaluated = 0;

  for (const row of due.rows) {
    const symbol = row.symbol;
    const priceNow = await getStockPrice(symbol);
    const priceAfter = Number(priceNow.price);
    const priceAt = Number(row.price_at_signal);
    const outcomePct = ((priceAfter - priceAt) / priceAt) * 100;

    let correct = false;
    if (row.signal === "BUY") correct = outcomePct > 0;
    if (row.signal === "SELL") correct = outcomePct < 0;
    if (row.signal === "HOLD") correct = Math.abs(outcomePct) < 1.0;

    await dbQuery(
      `
      UPDATE learning_samples
      SET evaluated_at=NOW(), price_after=$2, outcome_pct=$3, correct=$4
      WHERE id=$1
    `,
      [row.id, priceAfter, outcomePct, correct]
    );

    evaluated++;
  }

  return { evaluated };
}

// -----------------------------
// WebSocket (War Room)
// -----------------------------
let wss = null;
const wsClients = new Set();

function wsBroadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wsClients) {
    try {
      ws.send(msg);
    } catch {}
  }
}

async function emitEvent(type, payload) {
  if (hasDb) {
    await dbQuery(`INSERT INTO events(type, payload) VALUES ($1, $2::jsonb)`, [
      type,
      JSON.stringify(payload || {}),
    ]);
  }
  wsBroadcast({ type, payload, ts: new Date().toISOString() });
}

// -----------------------------
// API Routes
// -----------------------------
app.get("/api/health", async (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    apis: {
      finnhub: !!FINNHUB_KEY,
      twelvedata: !!TWELVEDATA_KEY,
      newsData: !!NEWSDATA_KEY,
      newsApi: !!NEWSAPI_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      postgres: !!hasDb,
    },
    version: "learning-impact-v2",
  });
});

app.get("/api/version", (req, res) => {
  res.json({ version: "learning-impact-v2", timestamp: new Date().toISOString() });
});

// learning speed setting
app.get("/api/settings/learning-speed", async (req, res) => {
  try {
    const v = hasDb ? await getSetting("learning_speed") : { mode: "realtime", evalAfterSec: 3600 };
    res.json(v || { mode: "realtime", evalAfterSec: 3600 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/settings/learning-speed", async (req, res) => {
  try {
    const { mode, evalAfterSec } = req.body || {};
    const payload = {
      mode: mode === "accelerated" ? "accelerated" : "realtime",
      evalAfterSec: Number(evalAfterSec) > 0 ? Number(evalAfterSec) : (mode === "accelerated" ? 30 : 3600),
    };
    if (hasDb) await setSetting("learning_speed", payload);
    res.json({ ok: true, setting: payload });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Simple history endpoint (for TradingView mini chart usage)
app.get("/api/price/history", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "AAPL").toUpperCase();
    const points = Number(req.query.points || 40);

    // MVP: synthetic history anchored to current price
    const spot = await getStockPrice(symbol);
    const base = Number(spot.price);
    const series = [];
    let p = base;

    for (let i = points - 1; i >= 0; i--) {
      p = p * (1 + (Math.random() - 0.5) * 0.003);
      series.push({
        t: Date.now() - i * 60_000,
        p: Math.round(p * 100) / 100,
      });
    }

    res.json({ symbol, provider: spot.provider, series });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// News endpoint
app.get("/api/news/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const pack = await getNews(symbol, 8);
    const items = pack.items.map((x) => ({
      ...x,
      sentiment: sentimentScore(`${x.title} ${x.summary}`),
    }));
    const avgSent =
      items.length ? items.reduce((a, b) => a + (b.sentiment || 0), 0) / items.length : 0;
    res.json({ symbol, provider: pack.provider, avgSent, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Market overview (popular stocks)
app.get("/api/market-overview", async (req, res) => {
  try {
    const symbols = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD"];
    const out = [];
    for (const s of symbols) {
      const q = await getStockPrice(s);
      out.push({ symbol: s, price: q.price, changePercent: q.changePercent ?? 0, provider: q.provider });
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// BOT FIGHT (returns 4 bots + logs learning + optional trade)
app.get("/api/bots/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const [q, newsPack, setting] = await Promise.all([
      getStockPrice(symbol),
      getNews(symbol, 8),
      hasDb ? getSetting("learning_speed") : Promise.resolve({ mode: "realtime", evalAfterSec: 3600 }),
    ]);

    const newsItems = newsPack.items.map((x) => ({
      ...x,
      sentiment: sentimentScore(`${x.title} ${x.summary}`),
    }));
    const avgSent =
      newsItems.length ? newsItems.reduce((a, b) => a + (b.sentiment || 0), 0) / newsItems.length : 0;

    const features = {
      avgSent: Math.round(avgSent * 1000) / 1000,
      changePercent: Math.round((q.changePercent ?? 0) * 1000) / 1000,
      price: q.price,
      priceProvider: q.provider,
      newsProvider: newsPack.provider,
    };

    // Decide for each bot
    const bots = BOTS.map((b) => {
      const d = decideSignal({ bot: b.bot, avgSent: features.avgSent, changePercent: features.changePercent });
      return {
        strategy: b.bot,
        label: b.label,
        signal: d.signal,
        horizon: b.horizon,
        rationale: d.why,
        baseConfidence: d.confidence,
      };
    });

    // Winner = highest confidence
    const winner = bots.reduce((a, b) => (b.baseConfidence > a.baseConfidence ? b : a), bots[0]);

    // Learning: log a sample for each bot
    let logged = 0;
    let logError = null;

    const evalAfterSec =
      setting?.mode === "accelerated"
        ? (Number(setting.evalAfterSec) > 0 ? Number(setting.evalAfterSec) : 30)
        : (Number(setting.evalAfterSec) > 0 ? Number(setting.evalAfterSec) : 3600);

    if (hasDb) {
      try {
        await ensurePortfolios();

        for (const b of bots) {
          const id = await logLearningSample({
            bot: b.strategy,
            strategy: b.strategy,
            symbol,
            signal: b.signal,
            horizon: b.horizon,
            priceAtSignal: Number(q.price),
            features,
            rationale: b.rationale,
            confidence: b.baseConfidence,
            evalAfterSec,
          });
          if (id) logged++;
        }
      } catch (e) {
        logError = e.message;
      }
    }

    // Execute ONE trade: the winner trades small size for MVP visibility
    // BUY = invest 5% of cash, SELL = sell 25% of held qty
    let executedTrade = null;
    if (hasDb) {
      try {
        const bot = winner.strategy;
        const side = winner.signal;

        if (side === "BUY") {
          const pr = await dbQuery(`SELECT cash FROM portfolios WHERE bot=$1`, [bot]);
          const cash = pr.rows[0] ? Number(pr.rows[0].cash) : START_CASH;
          const budget = cash * 0.05;
          const qty = Math.floor((budget / Number(q.price)) * 1000) / 1000;
          if (qty > 0) {
            executedTrade = await recordTrade({
              bot,
              symbol,
              side: "BUY",
              qty,
              price: Number(q.price),
              rationale: winner.rationale,
              confidence: winner.baseConfidence,
              horizon: winner.horizon,
            });
            await applyTradeToPortfolio({ bot, symbol, side: "BUY", qty, price: Number(q.price) });
          }
        } else if (side === "SELL") {
          const pos = await dbQuery(
            `SELECT qty FROM positions WHERE bot=$1 AND symbol=$2`,
            [bot, symbol]
          );
          const held = pos.rows[0] ? Number(pos.rows[0].qty) : 0;
          const qty = Math.floor((held * 0.25) * 1000) / 1000;
          if (qty > 0) {
            executedTrade = await recordTrade({
              bot,
              symbol,
              side: "SELL",
              qty,
              price: Number(q.price),
              rationale: winner.rationale,
              confidence: winner.baseConfidence,
              horizon: winner.horizon,
            });
            await applyTradeToPortfolio({ bot, symbol, side: "SELL", qty, price: Number(q.price) });
          }
        } else {
          // HOLD => still log a HOLD trade for visibility
          executedTrade = await recordTrade({
            bot: winner.strategy,
            symbol,
            side: "HOLD",
            qty: 0,
            price: Number(q.price),
            rationale: winner.rationale,
            confidence: winner.baseConfidence,
            horizon: winner.horizon,
          });
        }

        await emitEvent("bot_fight", {
          symbol,
          features,
          bots,
          winner: winner.strategy,
          tradeId: executedTrade?.id ?? null,
        });
      } catch (e) {
        // Don’t kill the endpoint
      }
    }

    res.json({
      symbol,
      logged,
      logError,
      features,
      bots: bots.map((b) => ({
        ...b,
        historicalAccuracy: 50,
        samples: 0,
        confidence: Math.max(1, Math.min(100, b.baseConfidence - 3)),
      })),
      winner: winner.strategy,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trades recent (for UI tables)
app.get("/api/trades/recent", async (req, res) => {
  try {
    if (!hasDb) return res.json({ items: [] });
    const limit = Math.min(Number(req.query.limit || 25), 200);
    const r = await dbQuery(
      `SELECT id, ts, bot, symbol, side, qty, price, rationale, confidence, horizon
       FROM trades
       ORDER BY ts DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ items: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Portfolios dashboard
app.get("/api/portfolios", async (req, res) => {
  try {
    if (!hasDb) return res.json({ items: [] });
    const p = await dbQuery(`SELECT bot, cash, goal, updated_at FROM portfolios ORDER BY bot ASC`);
    res.json({ items: p.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Learning impact over time (chart)
app.get("/api/learning/impact", async (req, res) => {
  try {
    if (!hasDb) return res.json({ series: [] });

    const days = Math.min(Math.max(Number(req.query.days || 14), 3), 60);

    // Aggregate correct rate per day per strategy
    const r = await dbQuery(
      `
      SELECT
        date_trunc('day', COALESCE(evaluated_at, created_at)) AS day,
        strategy,
        COUNT(*) FILTER (WHERE evaluated_at IS NOT NULL) AS evaluated,
        COUNT(*) FILTER (WHERE correct = TRUE) AS correct
      FROM learning_samples
      WHERE created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY 1,2
      ORDER BY 1 ASC
    `,
      [days]
    );

    // Shape into chart-friendly format
    const byStrategy = {};
    for (const row of r.rows) {
      const day = row.day.toISOString().slice(0, 10);
      const strategy = row.strategy;
      const evaluated = Number(row.evaluated || 0);
      const correct = Number(row.correct || 0);
      const acc = evaluated > 0 ? (correct / evaluated) * 100 : null;

      if (!byStrategy[strategy]) byStrategy[strategy] = [];
      byStrategy[strategy].push({ day, accuracy: acc, evaluated });
    }

    res.json({ days, byStrategy });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------
// Start + WS + Runner loop
// -----------------------------
async function start() {
  if (hasDb) {
    await dbInit();
    await ensurePortfolios();
  }

  const server = app.listen(PORT, async () => {
    console.log(`🚀 Server running on ${PORT}`);
    console.log(`DB: ${hasDb ? "✅" : "❌"}`);
  });

  // WebSocket server
  wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    wsClients.add(ws);

    ws.send(JSON.stringify({ type: "hello", payload: { ok: true }, ts: new Date().toISOString() }));

    ws.on("close", () => wsClients.delete(ws));
    ws.on("error", () => wsClients.delete(ws));
  });

  // Nonstop runner (optional)
  const runnerEnabled = (process.env.RUNNER_ENABLED || "").toLowerCase() === "true";
  const intervalSec = Math.max(Number(process.env.RUNNER_INTERVAL_SEC || 10), 3);

  const carousel = [
    "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","INTC"
  ];
  let idx = 0;

  if (runnerEnabled) {
    console.log(`♻ Runner enabled. Interval: ${intervalSec}s`);
    setInterval(async () => {
      try {
        const symbol = carousel[idx % carousel.length];
        idx++;
        await emitEvent("carousel_tick", { symbol });

        // Evaluate learning samples that are due
        const ev = await evaluateDueLearning();
        if (ev.evaluated) await emitEvent("learning_evaluated", ev);

        // Trigger bot fight silently (logs trades/events)
        // We call internal handler by HTTP for simplicity.
        await fetch(`http://127.0.0.1:${PORT}/api/bots/${symbol}`).catch(() => {});
      } catch {}
    }, intervalSec * 1000);
  } else {
    console.log(`⏸ Runner disabled (set RUNNER_ENABLED=true to enable)`);
  }
}

start();

export default app;
