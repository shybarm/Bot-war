/**
 * server.js — AI Trading Arena / Bot War Platform
 * Fixes:
 * 1) Events + reasoning persist across refresh (DB-backed replay)
 * 2) General news feed (not stock-market only)
 * 3) “Article → impacted stocks” analysis endpoint (OpenAI optional, heuristic fallback)
 */

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import pg from "pg";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// -----------------------------
// Env / Keys
// -----------------------------
const FINNHUB_KEY = process.env.FINNHUB_KEY || "";
const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY || "";
const NEWSDATA_KEY = process.env.NEWSDATA_KEY || "";
const NEWSAPI_KEY = process.env.NEWSAPI_KEY || "";
const OPENAI_KEY = process.env.OPENAI_KEY || "";

const MARKET_TZ = "America/New_York";
const NEWS_ONLY_WHEN_CLOSED = (process.env.NEWS_ONLY_WHEN_CLOSED || "true").toLowerCase() === "true";
const RUNNER_ENABLED = (process.env.RUNNER_ENABLED || "true").toLowerCase() === "true";
const RUNNER_INTERVAL_SEC = Number(process.env.RUNNER_INTERVAL_SEC || 5);

// -----------------------------
// DB
// -----------------------------
const { Pool } = pg;
const hasDb = !!process.env.DATABASE_URL;
const pool = hasDb
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : undefined })
  : null;

async function dbQuery(sql, params = []) {
  if (!hasDb) throw new Error("Postgres not configured");
  return pool.query(sql, params);
}

async function initDb() {
  if (!hasDb) return;

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS runner_state (
      id INT PRIMARY KEY DEFAULT 1,
      symbol_index INT NOT NULL DEFAULT 0,
      last_symbol TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbQuery(`INSERT INTO runner_state(id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS portfolios (
      bot TEXT PRIMARY KEY,
      cash NUMERIC NOT NULL,
      goal NUMERIC NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS trades (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      bot TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      qty NUMERIC NOT NULL,
      price NUMERIC NOT NULL,
      rationale TEXT,
      confidence NUMERIC,
      horizon TEXT,
      features JSONB
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS learning_samples (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      evaluated_at TIMESTAMPTZ,
      symbol TEXT NOT NULL,
      strategy TEXT NOT NULL,
      signal TEXT NOT NULL,
      price_at_signal NUMERIC NOT NULL,
      price_after NUMERIC,
      outcome_pct NUMERIC,
      correct BOOLEAN,
      eval_after_sec INT NOT NULL DEFAULT 3600,
      features JSONB
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS model_weights (
      strategy TEXT NOT NULL,
      key TEXT NOT NULL,
      value NUMERIC NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(strategy, key)
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  // Seed settings
  const seed = await dbQuery(`SELECT key FROM settings WHERE key='learning_speed'`);
  if (seed.rows.length === 0) {
    await dbQuery(`INSERT INTO settings(key, value) VALUES ($1, $2::jsonb)`, [
      "learning_speed",
      JSON.stringify({ mode: "realtime", evalAfterSec: 3600 }),
    ]);
  }
  const seedUni = await dbQuery(`SELECT key FROM settings WHERE key='universe'`);
  if (seedUni.rows.length === 0) {
    await dbQuery(`INSERT INTO settings(key, value) VALUES ($1, $2::jsonb)`, [
      "universe",
      JSON.stringify({ mode: "default", custom: [] }),
    ]);
  }
}

async function getSetting(key) {
  if (!hasDb) return null;
  const r = await dbQuery(`SELECT value FROM settings WHERE key=$1`, [key]);
  return r.rows[0]?.value || null;
}
async function setSetting(key, value) {
  if (!hasDb) return;
  await dbQuery(
    `INSERT INTO settings(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [key, JSON.stringify(value)]
  );
}

async function getUniverse() {
  const u = await getSetting("universe");
  return u || { mode: "default", custom: [] };
}

// -----------------------------
// Time / Market
// -----------------------------
function getNowInTZ(tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    weekday: get("weekday"),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
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
// Utilities
// -----------------------------
function safeJson(resp) {
  return resp
    .text()
    .then((t) => {
      try {
        return { ok: resp.ok, json: JSON.parse(t) };
      } catch {
        return { ok: false, json: null };
      }
    })
    .catch(() => ({ ok: false, json: null }));
}

function isValidTicker(raw) {
  const s = String(raw || "").toUpperCase().trim();
  if (!s) return { ok: false, reason: "Missing symbol" };
  if (!/^[A-Z.\-]{1,10}$/.test(s)) return { ok: false, reason: "Invalid ticker format" };
  return { ok: true, symbol: s };
}

function sentimentScore(text) {
  const t = (text || "").toLowerCase();
  const pos = ["surge", "beats", "profit", "upgrade", "strong", "record", "growth", "bullish", "rally", "wins", "approval"];
  const neg = ["miss", "drop", "downgrade", "weak", "lawsuit", "probe", "bearish", "decline", "fall", "ban", "recall"];
  let score = 0;
  for (const w of pos) if (t.includes(w)) score += 0.12;
  for (const w of neg) if (t.includes(w)) score -= 0.12;
  return Math.max(-1, Math.min(1, score));
}

// -----------------------------
// Price: Finnhub -> TwelveData -> Mock
// -----------------------------
async function getStockPrice(symbol) {
  const s = symbol.toUpperCase().trim();

  if (FINNHUB_KEY) {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${encodeURIComponent(FINNHUB_KEY)}`, { timeout: 15000 });
      const parsed = await safeJson(r);
      if (parsed.ok && parsed.json && Number.isFinite(parsed.json.c)) {
        return {
          provider: "finnhub",
          symbol: s,
          price: Number(parsed.json.c),
          change: Number(parsed.json.d || 0),
          changePercent: Number(parsed.json.dp || 0),
        };
      }
    } catch {}
  }

  if (TWELVEDATA_KEY) {
    try {
      const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(s)}&apikey=${encodeURIComponent(TWELVEDATA_KEY)}`, { timeout: 15000 });
      const parsed = await safeJson(r);
      if (parsed.ok && parsed.json?.price) {
        const price = Number(parsed.json.price);
        if (Number.isFinite(price)) {
          return { provider: "twelvedata", symbol: s, price, change: 0, changePercent: 0 };
        }
      }
    } catch {}
  }

  return {
    provider: "mock",
    symbol: s,
    price: Math.round((100 + Math.random() * 400) * 100) / 100,
    change: 0,
    changePercent: 0,
  };
}

// -----------------------------
// News: stock-bound (existing behavior)
// -----------------------------
async function getNews(symbol, limit = 8) {
  const s = symbol.toUpperCase().trim();

  if (NEWSDATA_KEY) {
    try {
      const r = await fetch(
        `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(NEWSDATA_KEY)}&q=${encodeURIComponent(s)}&language=en`,
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
    } catch {}
  }

  if (NEWSAPI_KEY) {
    try {
      const r = await fetch(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(s)}&language=en&pageSize=${limit}&sortBy=publishedAt`,
        { timeout: 15000, headers: { "X-Api-Key": NEWSAPI_KEY } }
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

  const items = Array.from({ length: Math.min(limit, 4) }).map((_, i) => ({
    title: `${s} news placeholder #${i + 1}`,
    url: "#",
    source: "mock",
    publishedAt: new Date().toISOString(),
    summary: "No provider available",
  }));
  return { provider: "mock", items };
}

// -----------------------------
// NEW: General news (non “stock market” oriented) with a pragmatic filter.
// -----------------------------
async function getGeneralNews(limit = 10) {
  const q =
    "(traffic OR infrastructure OR regulation OR energy OR healthcare OR retail OR airline OR automotive OR semiconductors OR technology OR manufacturing) " +
    "-stock -stocks -shares -earnings -nasdaq -nyse -dow -s&p -sp500 -investor -IPO";

  if (NEWSDATA_KEY) {
    try {
      const r = await fetch(
        `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(NEWSDATA_KEY)}&q=${encodeURIComponent(q)}&language=en`,
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
    } catch {}
  }

  if (NEWSAPI_KEY) {
    try {
      const r = await fetch(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&pageSize=${limit}&sortBy=publishedAt`,
        { timeout: 15000, headers: { "X-Api-Key": NEWSAPI_KEY } }
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

  // minimal fallback
  return {
    provider: "mock",
    items: [
      {
        title: "No news provider available",
        url: "#",
        source: "mock",
        publishedAt: new Date().toISOString(),
        summary: "Configure NEWSDATA_KEY or NEWSAPI_KEY to enable general news.",
      },
    ],
  };
}

// -----------------------------
// Learning model (simple online logistic regression)
// -----------------------------
async function getWeight(strategy, key, fallback = 0) {
  if (!hasDb) return fallback;
  const r = await dbQuery(`SELECT value FROM model_weights WHERE strategy=$1 AND key=$2`, [strategy, key]);
  return r.rows.length ? Number(r.rows[0].value) : fallback;
}
async function setWeight(strategy, key, value) {
  if (!hasDb) return;
  await dbQuery(
    `INSERT INTO model_weights(strategy, key, value) VALUES ($1,$2,$3)
     ON CONFLICT (strategy, key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [strategy, key, Number(value)]
  );
}

async function scoreWithWeights(strategy, features) {
  const w = {
    bias: await getWeight(strategy, "bias", 0),
    avgSent: await getWeight(strategy, "avgSent", 0),
    changePercent: await getWeight(strategy, "changePercent", 0),
  };
  const xBias = 1;
  const xSent = Number(features.avgSent || 0);
  const xChg = Number(features.changePercent || 0) / 2.0;

  const z = w.bias * xBias + w.avgSent * xSent + w.changePercent * xChg;
  const p = 1 / (1 + Math.exp(-z));
  return { p, weights: w };
}

async function updateModelFromOutcome(strategy, features, correct) {
  if (!hasDb) return;
  const lr = 0.18;
  const { p } = await scoreWithWeights(strategy, features);
  const y = correct ? 1 : 0;

  const w = {
    bias: await getWeight(strategy, "bias", 0),
    avgSent: await getWeight(strategy, "avgSent", 0),
    changePercent: await getWeight(strategy, "changePercent", 0),
  };

  const grad = (y - p);
  const xBias = 1;
  const xSent = Number(features.avgSent || 0);
  const xChg = Number(features.changePercent || 0) / 2.0;

  await setWeight(strategy, "bias", Number(w.bias) + lr * grad * xBias);
  await setWeight(strategy, "avgSent", Number(w.avgSent) + lr * grad * xSent);
  await setWeight(strategy, "changePercent", Number(w.changePercent) + lr * grad * xChg);
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
// WebSocket + Events (DB-backed)
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
  let eventId = null;

  if (hasDb) {
    const r = await dbQuery(
      `INSERT INTO events(type, payload) VALUES ($1, $2::jsonb) RETURNING id`,
      [type, JSON.stringify(payload || {})]
    );
    eventId = r.rows[0]?.id || null;
  }

  wsBroadcast({ id: eventId, type, payload, ts: new Date().toISOString() });
}

// -----------------------------
// Article impact explanation (existing single-symbol) + NEW: multi-stock impact
// -----------------------------
async function openaiJson(prompt) {
  if (!OPENAI_KEY) return null;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: "Return only valid JSON. No markdown." },
          { role: "user", content: prompt },
        ],
      }),
      timeout: 20000,
    });
    const parsed = await safeJson(r);
    if (!parsed.ok) return null;
    const content = parsed.json?.choices?.[0]?.message?.content || "{}";
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// Heuristic “regular news → stocks” mapping.
// This is intentionally transparent and conservative.
// (Your traffic light example maps to Siemens/IBM/Cisco/Qualcomm – per your doc.)
const IMPACT_MAP = [
  {
    name: "Smart traffic signals / V2X / city infrastructure",
    match: ["traffic light", "green wave", "traffic signal", "smart intersection", "v2x", "vehicle-to-infrastructure", "signal timing", "adaptive signal"],
    candidates: [
      { ticker: "SIEGY", company: "Siemens AG (ADR)", direction: "benefit", why: "Traffic control platforms + signal coordination deployments." },
      { ticker: "IBM", company: "IBM", direction: "benefit", why: "Smart city analytics platforms, integration, and optimization." },
      { ticker: "CSCO", company: "Cisco", direction: "benefit", why: "Networking backbone for connected intersections and telemetry." },
      { ticker: "QCOM", company: "Qualcomm", direction: "benefit", why: "C-V2X / connectivity enabling vehicle-infrastructure communication." },
    ],
  },
];

function detectImpactCandidates(title, summary) {
  const t = `${title || ""} ${summary || ""}`.toLowerCase();
  const out = [];
  for (const bucket of IMPACT_MAP) {
    const hit = bucket.match.some((k) => t.includes(k));
    if (hit) {
      out.push(...bucket.candidates.map((c) => ({ ...c, bucket: bucket.name })));
    }
  }
  // de-dup by ticker
  const seen = new Set();
  return out.filter((x) => (seen.has(x.ticker) ? false : (seen.add(x.ticker), true)));
}

async function analyzeArticleImpactMulti({ title, summary }) {
  const fallback = detectImpactCandidates(title, summary);

  // If OpenAI is available, ask it to rank/justify and add confidence + horizon.
  const prompt = `
You are a market analyst. Given a general news article (not stock-market news), identify up to 6 US-traded public tickers likely to be impacted.
Return STRICT JSON:
{
  "items":[
    {"ticker":"", "company":"", "direction":"benefit|risk|mixed", "horizon":"short|medium|long", "confidence":0-100, "why":"1 short line"},
    ...
  ]
}
Rules:
- Prefer US-traded tickers (NYSE/NASDAQ/NYSE Arca/OTC ADRs are acceptable).
- The "why" must be causal and specific.
- If uncertain, use direction="mixed" and lower confidence.
Article title: ${title}
Article summary: ${summary}
`;
  const ai = await openaiJson(prompt);

  if (ai?.items && Array.isArray(ai.items) && ai.items.length) {
    return {
      provider: "openai",
      items: ai.items
        .slice(0, 6)
        .map((x) => ({
          ticker: String(x.ticker || "").toUpperCase().trim(),
          company: String(x.company || "").trim(),
          direction: ["benefit", "risk", "mixed"].includes(x.direction) ? x.direction : "mixed",
          horizon: ["short", "medium", "long"].includes(x.horizon) ? x.horizon : "medium",
          confidence: Number.isFinite(Number(x.confidence)) ? Math.max(0, Math.min(100, Number(x.confidence))) : 55,
          why: String(x.why || "").slice(0, 180),
        }))
        .filter((x) => x.ticker),
    };
  }

  // Heuristic fallback (transparent)
  return {
    provider: "heuristic",
    items: fallback.map((x) => ({
      ticker: x.ticker,
      company: x.company,
      direction: x.direction,
      horizon: "medium",
      confidence: 62,
      why: `${x.why} (${x.bucket})`,
    })),
  };
}

// -----------------------------
// Bots + portfolios
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

// Base heuristic
function decideBase({ bot, avgSent, changePercent }) {
  if (bot === "sp500_long") {
    if (avgSent > 0.15) return { signal: "BUY", confidence: 62, why: "Positive news drift (long horizon)" };
    if (avgSent < -0.2) return { signal: "HOLD", confidence: 58, why: "Negative sentiment; long bot avoids churn" };
    return { signal: "HOLD", confidence: 55, why: "No long-term edge detected" };
  }
  if (bot === "market_swing") {
    if (avgSent > 0.05 && changePercent < 0) return { signal: "BUY", confidence: 64, why: "Positive news + dip = swing entry" };
    if (avgSent < -0.15 && changePercent > 0) return { signal: "SELL", confidence: 63, why: "Negative news + rally = swing exit" };
    return { signal: "HOLD", confidence: 56, why: "No swing setup detected" };
  }
  if (bot === "day_trade") {
    if (Math.abs(changePercent) > 1.2) return { signal: changePercent > 0 ? "SELL" : "BUY", confidence: 66, why: "Volatility mean-reversion signal" };
    return { signal: "HOLD", confidence: 54, why: "Volatility insufficient for day edge" };
  }
  // news_only
  if (avgSent > 0.12) return { signal: "BUY", confidence: 65, why: "Headline tone implies near-term upside" };
  if (avgSent < -0.12) return { signal: "SELL", confidence: 65, why: "Headline tone implies near-term downside" };
  return { signal: "HOLD", confidence: 55, why: "Headline sentiment is mixed/neutral" };
}

function adjustDecisionWithLearning(base, pLearn) {
  const confAdj = Math.round((pLearn - 0.5) * 18);
  const confidence = Math.max(35, Math.min(90, base.confidence + confAdj));
  return { ...base, confidence };
}

async function logLearningSample({ symbol, strategy, signal, price, evalAfterSec, features }) {
  if (!hasDb) return;
  await dbQuery(
    `
    INSERT INTO learning_samples(symbol, strategy, signal, price_at_signal, eval_after_sec, features)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)
  `,
    [symbol, strategy, signal, Number(price), Number(evalAfterSec || 3600), JSON.stringify(features || {})]
  );
}

async function logTrade({ bot, symbol, side, qty, price, rationale, confidence, horizon, features }) {
  if (!hasDb) return;
  await dbQuery(
    `
    INSERT INTO trades(bot, symbol, side, qty, price, rationale, confidence, horizon, features)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
  `,
    [bot, symbol, side, Number(qty), Number(price), rationale || "", Number(confidence || 0), horizon || "", JSON.stringify(features || {})]
  );
}

async function applyTradeToPortfolio(bot, side, qty, price) {
  if (!hasDb) return;
  const q = Number(qty);
  const p = Number(price);
  const delta = side === "BUY" ? -q * p : q * p;
  await dbQuery(
    `UPDATE portfolios SET cash = cash + $2, updated_at=NOW() WHERE bot=$1`,
    [bot, delta]
  );
}

// -----------------------------
// Runner universe
// -----------------------------
const DEFAULT_UNIVERSE = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "JPM", "XOM", "UNH"];

async function getRunnerState() {
  if (!hasDb) return { symbol_index: 0, last_symbol: DEFAULT_UNIVERSE[0] };
  const r = await dbQuery(`SELECT symbol_index, last_symbol FROM runner_state WHERE id=1`);
  return r.rows[0] || { symbol_index: 0, last_symbol: DEFAULT_UNIVERSE[0] };
}

async function setRunnerState({ symbol_index, last_symbol }) {
  if (!hasDb) return;
  await dbQuery(`UPDATE runner_state SET symbol_index=$1, last_symbol=$2, updated_at=NOW() WHERE id=1`, [
    Number(symbol_index || 0),
    last_symbol || null,
  ]);
}

async function getUniverseSymbols() {
  const u = await getUniverse();
  if (u?.mode === "custom" && Array.isArray(u.custom) && u.custom.length) {
    return u.custom.map((s) => String(s).toUpperCase().trim()).filter(Boolean);
  }
  return DEFAULT_UNIVERSE;
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
    version: "arena-v4-events-replay-general-news-impact",
  });
});

app.get("/api/version", (req, res) => {
  res.json({ version: "arena-v4-events-replay-general-news-impact", timestamp: new Date().toISOString() });
});

// Runner status (used for instant page hydration)
app.get("/api/runner/status", async (req, res) => {
  try {
    const st = await getRunnerState();
    const m = isMarketOpen();
    const uni = await getUniverse();
    const symbols = await getUniverseSymbols();
    const nextSymbol = symbols[(Number(st.symbol_index || 0) + 1) % symbols.length];
    res.json({
      enabled: RUNNER_ENABLED,
      intervalSec: RUNNER_INTERVAL_SEC,
      market: m,
      newsOnlyWhenClosed: NEWS_ONLY_WHEN_CLOSED,
      universe: uni,
      state: { lastSymbol: st.last_symbol || null, symbolIndex: Number(st.symbol_index || 0) },
      nextSymbol,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Events replay: lets UI rebuild reasoning stream after refresh
app.get("/api/events/recent", async (req, res) => {
  try {
    if (!hasDb) return res.json({ items: [] });
    const limit = Math.min(Math.max(Number(req.query.limit || 120), 10), 500);
    const afterId = Number(req.query.afterId || 0);

    const r = await dbQuery(
      `
      SELECT id, ts, type, payload
      FROM events
      WHERE id > $2
      ORDER BY id DESC
      LIMIT $1
    `,
      [limit, afterId]
    );

    const items = r.rows
      .map((x) => ({
        id: Number(x.id),
        ts: x.ts,
        type: x.type,
        payload: x.payload || {},
      }))
      .reverse(); // chronological
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// News routes
app.get("/api/news/:symbol", async (req, res) => {
  try {
    const symbolV = isValidTicker(req.params.symbol);
    if (!symbolV.ok) return res.status(400).json({ error: symbolV.reason });
    const pack = await getNews(symbolV.symbol, 8);
    res.json(pack);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/news/general", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 30);
    const pack = await getGeneralNews(limit);
    res.json(pack);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// “Regular article → impacted stocks”
app.post("/api/news/impact", async (req, res) => {
  try {
    const { title, summary } = req.body || {};
    const out = await analyzeArticleImpactMulti({ title: String(title || ""), summary: String(summary || "") });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Portfolios
app.get("/api/portfolios", async (req, res) => {
  try {
    if (!hasDb) return res.json({ items: [] });
    const p = await dbQuery(`SELECT bot, cash, goal, updated_at FROM portfolios ORDER BY bot ASC`);
    res.json({ items: p.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trades recent
app.get("/api/trades/recent", async (req, res) => {
  try {
    if (!hasDb) return res.json({ items: [] });
    const limit = Math.min(Math.max(Number(req.query.limit || 25), 5), 200);
    const r = await dbQuery(`SELECT id, ts, bot, symbol, side, qty, price, rationale, confidence, horizon FROM trades ORDER BY ts DESC LIMIT $1`, [limit]);
    res.json({ items: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trades by bot
app.get("/api/trades/:bot", async (req, res) => {
  try {
    if (!hasDb) return res.json({ items: [] });
    const bot = String(req.params.bot || "");
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 5), 500);
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

// Learning impact chart
app.get("/api/learning/impact", async (req, res) => {
  try {
    if (!hasDb) return res.json({ days: 14, byStrategy: {} });

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

// Settings
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
      evalAfterSec: Number(evalAfterSec) > 0 ? Number(evalAfterSec) : mode === "accelerated" ? 30 : 3600,
    };
    if (hasDb) await setSetting("learning_speed", payload);
    res.json({ ok: true, setting: payload });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Bots endpoint
app.get("/api/bots/:symbol", async (req, res) => {
  try {
    const symbolV = isValidTicker(req.params.symbol);
    if (!symbolV.ok) return res.status(400).json({ error: symbolV.reason });
    const symbol = symbolV.symbol;

    const market = isMarketOpen();
    const tradesAllowed = market.open;

    const setting = hasDb ? await getSetting("learning_speed") : { mode: "realtime", evalAfterSec: 3600 };
    const evalAfterSec = Number(setting?.evalAfterSec || 3600);

    const [q, newsPack] = await Promise.all([getStockPrice(symbol), getNews(symbol, 8)]);
    const newsItems = (newsPack.items || []).map((x) => ({ ...x, sentiment: sentimentScore(`${x.title} ${x.summary}`) }));
    const avgSent = newsItems.length ? newsItems.reduce((a, b) => a + (b.sentiment || 0), 0) / newsItems.length : 0;

    const features = { avgSent, changePercent: Number(q.changePercent || 0) };

    const botsOut = [];
    for (const b of BOTS) {
      const base = decideBase({ bot: b.bot, avgSent, changePercent: features.changePercent });
      const learn = await scoreWithWeights(b.bot, features);
      const adjusted = adjustDecisionWithLearning(base, learn.p);

      const side = adjusted.signal === "BUY" ? "BUY" : adjusted.signal === "SELL" ? "SELL" : "HOLD";
      const qty = side === "HOLD" ? 0 : 10;

      // Learning sample always
      await logLearningSample({
        symbol,
        strategy: b.bot,
        signal: side,
        price: q.price,
        evalAfterSec,
        features,
      });

      // Execute trade only if market open (or if you later allow paper trades here)
      if (tradesAllowed && side !== "HOLD") {
        await logTrade({
          bot: b.bot,
          symbol,
          side,
          qty,
          price: q.price,
          rationale: adjusted.why,
          confidence: adjusted.confidence,
          horizon: b.horizon,
          features,
        });
        await applyTradeToPortfolio(b.bot, side, qty, q.price);
      }

      botsOut.push({
        strategy: b.bot,
        label: b.label,
        horizon: b.horizon,
        signal: side,
        confidence: adjusted.confidence,
        rationale: adjusted.why,
      });
    }

    // Winner = max confidence
    const winner = botsOut.reduce((a, b) => (b.confidence > a.confidence ? b : a), botsOut[0])?.strategy || "—";

    res.json({
      symbol,
      market,
      tradesAllowed,
      price: q.price,
      provider: q.provider,
      features,
      bots: botsOut,
      winner,
      news: { provider: newsPack.provider, items: newsItems },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------
// Runner loop
// -----------------------------
let runnerTimer = null;

async function runnerTick() {
  const symbols = await getUniverseSymbols();
  const st = await getRunnerState();

  const idx = Number(st.symbol_index || 0) % symbols.length;
  const sym = symbols[idx];

  await setRunnerState({
    symbol_index: (idx + 1) % symbols.length,
    last_symbol: sym,
  });

  const market = isMarketOpen();
  await emitEvent("carousel_tick", { symbol: sym, market });

  // drive fights
  const r = await fetch(`http://127.0.0.1:${PORT}/api/bots/${encodeURIComponent(sym)}`).catch(() => null);
  if (r) {
    const parsed = await safeJson(r);
    if (parsed.ok && parsed.json) {
      await emitEvent("bot_fight", {
        symbol: sym,
        market: parsed.json.market,
        tradesAllowed: parsed.json.tradesAllowed,
        winner: parsed.json.winner,
        bots: parsed.json.bots,
        features: parsed.json.features,
      });
    }
  }

  // evaluate learning
  const ev = await evaluateDueLearning();
  if (ev.evaluated > 0) await emitEvent("learning_evaluated", { evaluated: ev.evaluated });
}

function startRunner() {
  if (!RUNNER_ENABLED) return;
  if (runnerTimer) return;
  runnerTimer = setInterval(() => runnerTick().catch(() => {}), RUNNER_INTERVAL_SEC * 1000);
}

// -----------------------------
// Boot
// -----------------------------
const server = http.createServer(app);
wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
});

(async function boot() {
  await initDb().catch(() => {});
  await ensurePortfolios().catch(() => {});
  startRunner();
})();

server.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
