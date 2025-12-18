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
  getRunnerState,
  setRunnerState,
  getWeights,
  setWeight,
} from "./db.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// -----------------------------
// ENV (Railway) — FIXED mapping
// -----------------------------
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY || "";

/**
 * IMPORTANT:
 * - NewsData.io key is usually called NEWSDATA_KEY
 * - NewsAPI.org key is usually called NEWSAPI_KEY
 *
 * Your Railway currently has:
 * - NEWS_API_KEY (ambiguous)
 * - NEWSAPI_BACKUP_KEY
 *
 * We support ALL common names so you always get real news if any key exists.
 */
const NEWSDATA_KEY =
  process.env.NEWSDATA_KEY ||
  process.env.NEWSDATA_API_KEY ||
  process.env.NEWS_API_KEY || // fallback (your current primary)
  "";

const NEWSAPI_KEY =
  process.env.NEWSAPI_KEY ||
  process.env.NEWSAPI_BACKUP_KEY || // your current backup
  "";

const OPENAI_KEY = process.env.OPENAI_API_KEY || "";

const MARKET_TZ = process.env.MARKET_TZ || "America/New_York";
const NEWS_ONLY_WHEN_CLOSED =
  (process.env.MARKET_NEWS_ONLY_WHEN_CLOSED || "true").toLowerCase() === "true";

const RUNNER_ENABLED =
  (process.env.RUNNER_ENABLED || "true").toLowerCase() === "true";
const RUNNER_INTERVAL_SEC = Number(process.env.RUNNER_INTERVAL_SEC || 5);
const RUNNER_SCAN_BATCH = Number(process.env.RUNNER_SCAN_BATCH || 1);
const RUNNER_TRADE_TOP = Number(process.env.RUNNER_TRADE_TOP || 1);
const RUNNER_LOCK_ID = process.env.RUNNER_LOCK_ID || "default-lock";

// -----------------------------
// Ticker validation + Universe
// -----------------------------
function isValidTicker(symbolRaw) {
  const s = String(symbolRaw || "").trim().toUpperCase();
  if (!s) return { ok: false, reason: "Empty symbol" };
  if (s.length > 10) return { ok: false, reason: "Too long" };
  if (!/^[A-Z0-9.\-]+$/.test(s)) return { ok: false, reason: "Invalid characters" };
  return { ok: true, symbol: s };
}

const SP500_MINI = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","INTC",
  "JPM","V","MA","UNH","XOM","COST","WMT","AVGO","LLY","KO"
];

async function getUniverse() {
  const u = (hasDb ? await getSetting("universe") : null) || { mode: "any", custom: [] };
  const mode = (u.mode || "any").toLowerCase();
  const custom = Array.isArray(u.custom) ? u.custom : [];
  return { mode, custom };
}

function universeSymbols(universe) {
  if (!universe || universe.mode === "any") return SP500_MINI;
  if (universe.mode === "sp500") return SP500_MINI;
  if (universe.mode === "custom") {
    const out = universe.custom
      .map((x) => isValidTicker(x))
      .filter((x) => x.ok)
      .map((x) => x.symbol);
    return out.length ? out : SP500_MINI;
  }
  return SP500_MINI;
}

// -----------------------------
// Market hours gate (US market)
// -----------------------------
function getNowInTZ(tz) {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { weekday: get("weekday"), hour: Number(get("hour")), minute: Number(get("minute")) };
}

function isMarketOpen() {
  const { weekday, hour, minute } = getNowInTZ(MARKET_TZ);
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  if (!isWeekday) return { open: false, reason: "Weekend" };

  const mins = hour * 60 + minute;
  const openMins = 9 * 60 + 30;
  const closeMins = 16 * 60;

  if (mins < openMins) return { open: false, reason: "Pre-market" };
  if (mins >= closeMins) return { open: false, reason: "After-hours" };
  return { open: true, reason: "Open" };
}

// -----------------------------
// Helpers
// -----------------------------
async function safeJson(res) {
  const text = await res.text();
  try {
    return { ok: res.ok, json: JSON.parse(text) };
  } catch {
    return { ok: false, json: null };
  }
}

function sentimentScore(text) {
  const t = (text || "").toLowerCase();
  const pos = ["surge","beats","profit","upgrade","strong","record","growth","bullish","rally","wins","approval"];
  const neg = ["miss","drop","downgrade","weak","lawsuit","probe","bearish","decline","fall","ban","recall"];
  let score = 0;
  for (const w of pos) if (t.includes(w)) score += 0.12;
  for (const w of neg) if (t.includes(w)) score -= 0.12;
  return Math.max(-1, Math.min(1, score));
}

// -----------------------------
// Prices: Finnhub -> TwelveData -> Mock
// -----------------------------
async function getStockPrice(symbol) {
  const s = symbol.toUpperCase().trim();

  if (FINNHUB_KEY) {
    try {
      const r = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${encodeURIComponent(FINNHUB_KEY)}`,
        { timeout: 15000 }
      );
      const parsed = await safeJson(r);
      if (parsed.ok && parsed.json && typeof parsed.json.c === "number") {
        return {
          provider: "finnhub",
          symbol: s,
          price: Number(parsed.json.c),
          changePercent: Number(parsed.json.dp ?? 0),
        };
      }
    } catch {}
  }

  if (TWELVEDATA_KEY) {
    try {
      const r = await fetch(
        `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(s)}&apikey=${encodeURIComponent(TWELVEDATA_KEY)}`,
        { timeout: 15000 }
      );
      const parsed = await safeJson(r);
      const price = Number(parsed.json?.close ?? parsed.json?.price);
      const chgPct = Number(parsed.json?.percent_change ?? 0);
      if (parsed.ok && Number.isFinite(price)) {
        return { provider: "twelvedata", symbol: s, price, changePercent: Number.isFinite(chgPct) ? chgPct : 0 };
      }
    } catch {}
  }

  return {
    provider: "mock",
    symbol: s,
    price: Math.round((100 + Math.random() * 400) * 100) / 100,
    changePercent: Math.round(((Math.random() - 0.5) * 1.6) * 1000) / 1000,
  };
}

// -----------------------------
// News: NewsData.io -> NewsAPI.org -> Mock
// -----------------------------
async function getNews(symbol, limit = 8) {
  const s = symbol.toUpperCase().trim();

  // NewsData.io
  if (NEWSDATA_KEY) {
    try {
      const r = await fetch(
        `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(NEWSDATA_KEY)}&q=${encodeURIComponent(s)}&language=en`,
        { timeout: 15000 }
      );
      const parsed = await safeJson(r);
      if (parsed.ok && Array.isArray(parsed.json?.results) && parsed.json.results.length) {
        const items = parsed.json.results.slice(0, limit).map((a) => ({
          title: a.title || "",
          url: a.link || "",
          source: a.source_id || "newsdata",
          publishedAt: a.pubDate || "",
          summary: a.description || "",
        }));
        return { provider: "newsdata", items };
      }
    } catch {}
  }

  // NewsAPI.org
  if (NEWSAPI_KEY) {
    try {
      const r = await fetch(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(s)}&language=en&pageSize=${limit}&sortBy=publishedAt`,
        { timeout: 15000, headers: { "X-Api-Key": NEWSAPI_KEY } }
      );
      const parsed = await safeJson(r);
      if (parsed.ok && Array.isArray(parsed.json?.articles) && parsed.json.articles.length) {
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

  const items = Array.from({ length: Math.min(limit, 4) }).map((_, i) => ({
    title: `${s} news placeholder #${i + 1}`,
    url: "#",
    source: "mock",
    publishedAt: new Date().toISOString(),
    summary: "No provider available (configure NEWSDATA_KEY or NEWSAPI_KEY).",
  }));
  return { provider: "mock", items };
}

// -----------------------------
// Bots + Portfolio (4 bots)
// -----------------------------
const BOTS = [
  { bot: "sp500_long", label: "S&P500 Long", horizon: "long" },
  { bot: "market_swing", label: "Market Swing", horizon: "medium" },
  { bot: "day_trade", label: "Day Trade", horizon: "short" },
  { bot: "news_only", label: "News-Only", horizon: "short" },
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

// ✅ Looser decision thresholds so trades happen with weak signals
function decideBase({ bot, avgSent, changePercent }) {
  if (bot === "sp500_long") {
    if (avgSent > 0.06) return { signal: "BUY", confidence: 60, why: "Positive news drift (long horizon)" };
    if (avgSent < -0.12) return { signal: "HOLD", confidence: 58, why: "Negative sentiment; long bot avoids churn" };
    return { signal: "HOLD", confidence: 54, why: "No long-term edge detected" };
  }
  if (bot === "market_swing") {
    if (avgSent > 0.04 && changePercent <= 0) return { signal: "BUY", confidence: 62, why: "Positive news + dip = swing entry" };
    if (avgSent < -0.06 && changePercent > 0) return { signal: "SELL", confidence: 61, why: "Negative news + pop = exit/reversal" };
    return { signal: "HOLD", confidence: 53, why: "No swing setup" };
  }
  if (bot === "day_trade") {
    if (Math.abs(changePercent) > 0.25) {
      const dir = changePercent < 0 ? "BUY" : "SELL";
      return { signal: dir, confidence: 60, why: "Short-term volatility reaction" };
    }
    return { signal: "HOLD", confidence: 52, why: "Range noise" };
  }
  if (bot === "news_only") {
    if (avgSent > 0.10) return { signal: "BUY", confidence: 64, why: "Trades strictly on positive news cluster" };
    if (avgSent < -0.10) return { signal: "SELL", confidence: 64, why: "Trades strictly on negative news cluster" };
    return { signal: "HOLD", confidence: 54, why: "News signal not strong enough" };
  }
  return { signal: "HOLD", confidence: 50, why: "Default" };
}

// Online learner: logistic regression score -> probability
function sigmoid(z) {
  const x = Math.max(-10, Math.min(10, z));
  return 1 / (1 + Math.exp(-x));
}

function modelScore(weights, features) {
  const bias = Number(weights.bias || 0);
  const wS = Number(weights.avgSent || 0);
  const wC = Number(weights.changePercent || 0);

  const s = Number(features.avgSent || 0);
  const c = Number(features.changePercent || 0);

  const z = bias + wS * s + wC * (c / 2.0);
  return { z, p: sigmoid(z) };
}

async function applyLearningAdjust(strategy, base, features) {
  if (!hasDb) return { ...base, learnedP: null };

  const w = await getWeights(strategy);
  const { p } = modelScore(w, features);

  const delta = Math.round((p - 0.5) * 30);
  const confidence = Math.max(1, Math.min(99, base.confidence + delta));

  let signal = base.signal;
  if (base.signal === "BUY" && p < 0.30) signal = "HOLD";
  if (base.signal === "SELL" && p > 0.70) signal = "HOLD";

  return { ...base, signal, confidence, learnedP: p };
}

async function recordTrade({ bot, symbol, side, qty, price, rationale, confidence, horizon, features }) {
  if (!hasDb) return null;
  const r = await dbQuery(
    `
    INSERT INTO trades(bot, symbol, side, qty, price, rationale, confidence, horizon, features)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    RETURNING *
  `,
    [bot, symbol, side, qty, price, rationale, confidence, horizon, JSON.stringify(features || {})]
  );
  return r.rows[0];
}

async function applyTradeToPortfolio({ bot, symbol, side, qty, price }) {
  if (!hasDb) return;

  const pr = await dbQuery(`SELECT cash FROM portfolios WHERE bot=$1`, [bot]);
  if (!pr.rows[0]) return;

  let cash = Number(pr.rows[0].cash);

  const pos = await dbQuery(
    `SELECT qty, avg_price FROM positions WHERE bot=$1 AND symbol=$2`,
    [bot, symbol]
  );

  let curQty = pos.rows[0] ? Number(pos.rows[0].qty) : 0;
  let avgPrice = pos.rows[0] ? Number(pos.rows[0].avg_price) : 0;

  if (side === "BUY" && qty > 0) {
    const cost = qty * price;
    if (cash < cost) return;
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

  await dbQuery(`UPDATE portfolios SET cash=$2, updated_at=NOW() WHERE bot=$1`, [bot, cash]);

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

async function updateModelFromOutcome(strategy, features, correctBool) {
  if (!hasDb) return;
  const y = correctBool ? 1 : 0;

  const w = await getWeights(strategy);
  const { p } = modelScore(w, features);

  const lr = 0.05;

  const xBias = 1;
  const xSent = Number(features.avgSent || 0);
  const xChg = Number(features.changePercent || 0) / 2.0;

  const grad = (y - p);

  const nb = Number(w.bias) + lr * grad * xBias;
  const ns = Number(w.avgSent) + lr * grad * xSent;
  const nc = Number(w.changePercent) + lr * grad * xChg;

  await setWeight(strategy, "bias", nb);
  await setWeight(strategy, "avgSent", ns);
  await setWeight(strategy, "changePercent", nc);
}

async function evaluateDueLearning() {
  if (!hasDb) return { evaluated: 0 };

  const due = await dbQuery(
    `
    SELECT id, symbol, signal, price_at_signal, eval_after_sec, strategy, features
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

    await updateModelFromOutcome(row.strategy, row.features || {}, correct);
    evaluated++;
  }

  return { evaluated };
}

// -----------------------------
// WebSocket
// -----------------------------
let wss = null;
const wsClients = new Set();

function wsBroadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wsClients) {
    try { ws.send(msg); } catch {}
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
  const m = isMarketOpen();
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    apis: {
      finnhub: !!FINNHUB_KEY,
      twelvedata: !!TWELVEDATA_KEY,
      newsData: !!NEWSDATA_KEY,
      newsApi: !!NEWSAPI_KEY,
      openai: !!OPENAI_KEY,
      postgres: !!hasDb,
    },
    market: { open: m.open, reason: m.reason, tz: MARKET_TZ },
    version: "arena-v3-learning-universe-runner",
  });
});

app.get("/api/version", (req, res) => {
  res.json({ version: "arena-v3-learning-universe-runner", timestamp: new Date().toISOString() });
});

// Debug stats (so you can confirm data is flowing)
app.get("/api/debug/stats", async (req, res) => {
  try {
    if (!hasDb) return res.json({ ok: false, error: "DB missing" });

    const [t, p, s, e] = await Promise.all([
      dbQuery(`SELECT COUNT(*)::int AS n FROM trades`),
      dbQuery(`SELECT COUNT(*)::int AS n FROM positions`),
      dbQuery(`SELECT COUNT(*)::int AS n FROM learning_samples`),
      dbQuery(`SELECT COUNT(*)::int AS n FROM events`),
    ]);

    const lastTrade = await dbQuery(`SELECT * FROM trades ORDER BY ts DESC LIMIT 1`);
    const lastSample = await dbQuery(`SELECT * FROM learning_samples ORDER BY created_at DESC LIMIT 1`);

    res.json({
      ok: true,
      counts: {
        trades: t.rows?.[0]?.n ?? 0,
        positions: p.rows?.[0]?.n ?? 0,
        learning_samples: s.rows?.[0]?.n ?? 0,
        events: e.rows?.[0]?.n ?? 0,
      },
      lastTrade: lastTrade.rows?.[0] ?? null,
      lastSample: lastSample.rows?.[0] ?? null,
      env: {
        newsdata_configured: !!NEWSDATA_KEY,
        newsapi_configured: !!NEWSAPI_KEY,
        runner_enabled: RUNNER_ENABLED,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Learning speed setting
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

// Universe setting
app.get("/api/settings/universe", async (req, res) => {
  try {
    const u = await getUniverse();
    res.json(u);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/settings/universe", async (req, res) => {
  try {
    const { mode, custom } = req.body || {};
    const m = String(mode || "any").toLowerCase();
    const payload = {
      mode: ["any","sp500","custom"].includes(m) ? m : "any",
      custom: Array.isArray(custom) ? custom : [],
    };
    if (hasDb) await setSetting("universe", payload);
    res.json({ ok: true, universe: payload });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Runner status endpoint
app.get("/api/runner/status", async (req, res) => {
  try {
    const m = isMarketOpen();
    const universe = await getUniverse();
    const st = hasDb ? await getRunnerState() : { idx: 0, lastTick: null, lastSymbol: "AAPL" };

    const symbols = universeSymbols(universe);
    const nextSymbol = symbols[st.idx % symbols.length];

    res.json({
      enabled: RUNNER_ENABLED,
      intervalSec: Math.max(Number(RUNNER_INTERVAL_SEC || 10), 3),
      market: { open: m.open, reason: m.reason, tz: MARKET_TZ },
      newsOnlyWhenClosed: NEWS_ONLY_WHEN_CLOSED,
      universe,
      state: st,
      nextSymbol,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// News endpoint
app.get("/api/news/:symbol", async (req, res) => {
  try {
    const symbolV = isValidTicker(req.params.symbol);
    if (!symbolV.ok) return res.status(400).json({ error: symbolV.reason });
    const symbol = symbolV.symbol;

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

// Trades recent
app.get("/api/trades/recent", async (req, res) => {
  try {
    if (!hasDb) return res.json({ items: [] });
    const limit = Math.min(Number(req.query.limit || 25), 500);
    const r = await dbQuery(
      `SELECT id, ts, bot, symbol, side, qty, price, rationale, confidence, horizon, features
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

// Trades by bot
app.get("/api/trades/bot/:bot", async (req, res) => {
  try {
    if (!hasDb) return res.json({ items: [] });
    const bot = String(req.params.bot || "");
    const limit = Math.min(Number(req.query.limit || 200), 2000);

    const r = await dbQuery(
      `SELECT id, ts, bot, symbol, side, qty, price, rationale, confidence, horizon, features
       FROM trades
       WHERE bot=$1
       ORDER BY ts DESC
       LIMIT $2`,
      [bot, limit]
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
// BOT FIGHT endpoint
// -----------------------------
app.get("/api/bots/:symbol", async (req, res) => {
  try {
    const symbolV = isValidTicker(req.params.symbol);
    if (!symbolV.ok) return res.status(400).json({ error: symbolV.reason });
    const symbol = symbolV.symbol;

    const market = isMarketOpen();
    const tradesAllowed = market.open;

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
      marketOpen: market.open,
    };

    const bots = [];
    for (const b of BOTS) {
      const base = decideBase({ bot: b.bot, avgSent: features.avgSent, changePercent: features.changePercent });
      const learned = await applyLearningAdjust(b.bot, base, features);

      bots.push({
        strategy: b.bot,
        label: b.label,
        signal: learned.signal,
        horizon: b.horizon,
        rationale: learned.why,
        baseConfidence: base.confidence,
        confidence: learned.confidence,
        learnedP: learned.learnedP,
      });
    }

    const winner = bots.reduce((a, b) => (b.confidence > a.confidence ? b : a), bots[0]);

    const evalAfterSec =
      setting?.mode === "accelerated"
        ? (Number(setting.evalAfterSec) > 0 ? Number(setting.evalAfterSec) : 30)
        : (Number(setting.evalAfterSec) > 0 ? Number(setting.evalAfterSec) : 3600);

    let logged = 0;
    let logError = null;

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
            confidence: b.confidence,
            evalAfterSec,
          });
          if (id) logged++;
        }
      } catch (e) {
        logError = e.message;
      }
    }

    // ✅ Always record an audit-grade trade row so UI never looks empty
    let executedTrade = null;

    if (hasDb) {
      try {
        const bot = winner.strategy;
        const desired = winner.signal; // BUY/SELL/HOLD

        const canTrade = tradesAllowed;
        const shouldPaperOnly = !canTrade && NEWS_ONLY_WHEN_CLOSED;

        const price = Number(q.price);

        if (canTrade) {
          if (desired === "BUY") {
            const pr = await dbQuery(`SELECT cash FROM portfolios WHERE bot=$1`, [bot]);
            const cash = pr.rows[0] ? Number(pr.rows[0].cash) : START_CASH;
            const budget = cash * 0.05;
            const qty = Math.floor((budget / price) * 1000) / 1000;

            if (qty > 0) {
              executedTrade = await recordTrade({
                bot, symbol, side: "BUY", qty, price,
                rationale: winner.rationale,
                confidence: winner.confidence,
                horizon: winner.horizon,
                features,
              });
              await applyTradeToPortfolio({ bot, symbol, side: "BUY", qty, price });
            } else {
              executedTrade = await recordTrade({
                bot, symbol, side: "HOLD", qty: 0, price,
                rationale: `BUY signal but qty=0 (cash=${cash.toFixed(2)}, price=${price}). ${winner.rationale}`,
                confidence: winner.confidence,
                horizon: winner.horizon,
                features: { ...features, desired: "BUY", skippedReason: "qty=0" },
              });
            }
          } else if (desired === "SELL") {
            const pos = await dbQuery(`SELECT qty FROM positions WHERE bot=$1 AND symbol=$2`, [bot, symbol]);
            const held = pos.rows[0] ? Number(pos.rows[0].qty) : 0;
            const qty = Math.floor((held * 0.25) * 1000) / 1000;

            if (qty > 0) {
              executedTrade = await recordTrade({
                bot, symbol, side: "SELL", qty, price,
                rationale: winner.rationale,
                confidence: winner.confidence,
                horizon: winner.horizon,
                features,
              });
              await applyTradeToPortfolio({ bot, symbol, side: "SELL", qty, price });
            } else {
              executedTrade = await recordTrade({
                bot, symbol, side: "HOLD", qty: 0, price,
                rationale: `SELL signal but no position to sell (held=0). ${winner.rationale}`,
                confidence: winner.confidence,
                horizon: winner.horizon,
                features: { ...features, desired: "SELL", skippedReason: "no_position" },
              });
            }
          } else {
            executedTrade = await recordTrade({
              bot, symbol, side: "HOLD", qty: 0, price,
              rationale: winner.rationale,
              confidence: winner.confidence,
              horizon: winner.horizon,
              features,
            });
          }
        } else if (shouldPaperOnly) {
          executedTrade = await recordTrade({
            bot, symbol, side: "HOLD", qty: 0, price,
            rationale: `Market closed (${market.reason}). Paper mode: ${winner.rationale}`,
            confidence: winner.confidence,
            horizon: winner.horizon,
            features: { ...features, paper: true },
          });
        }

        await emitEvent("bot_fight", {
          symbol,
          market,
          tradesAllowed,
          features,
          bots,
          winner: winner.strategy,
          tradeId: executedTrade?.id ?? null,
        });

        if (executedTrade?.id) {
          await emitEvent("trade_recorded", {
            id: executedTrade.id,
            bot: executedTrade.bot,
            symbol: executedTrade.symbol,
            side: executedTrade.side,
            qty: Number(executedTrade.qty),
            price: Number(executedTrade.price),
            rationale: executedTrade.rationale,
          });
        }
      } catch {
        // keep endpoint alive
      }
    }

    res.json({
      symbol,
      market,
      tradesAllowed,
      logged,
      logError,
      features,
      bots,
      winner: winner.strategy,
    });
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

  wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    wsClients.add(ws);
    ws.send(JSON.stringify({ type: "hello", payload: { ok: true }, ts: new Date().toISOString() }));
    ws.on("close", () => wsClients.delete(ws));
    ws.on("error", () => wsClients.delete(ws));
  });

  const intervalSec = Math.max(Number(RUNNER_INTERVAL_SEC || 10), 3);

  if (RUNNER_ENABLED) {
    console.log(`♻ Runner enabled. Interval: ${intervalSec}s`);

    let state = hasDb ? await getRunnerState() : { idx: 0, lastTick: null, lastSymbol: "AAPL" };

    setInterval(async () => {
      try {
        const universe = await getUniverse();
        const symbols = universeSymbols(universe);

        const m = isMarketOpen();
        const idx = Number(state.idx || 0);
        const symbol = symbols[idx % symbols.length];

        state = {
          idx: idx + 1,
          lastTick: new Date().toISOString(),
          lastSymbol: symbol,
        };
        if (hasDb) await setRunnerState(state);

        await emitEvent("carousel_tick", { symbol, idx, market: m, universe });

        const ev = await evaluateDueLearning();
        if (ev.evaluated) await emitEvent("learning_evaluated", ev);

        // Run fight every tick
        await fetch(`http://127.0.0.1:${PORT}/api/bots/${symbol}`).catch(() => {});
      } catch {}
    }, intervalSec * 1000);
  } else {
    console.log(`⏸ Runner disabled (set RUNNER_ENABLED=true to enable)`);
  }
}

start();

export default app;
