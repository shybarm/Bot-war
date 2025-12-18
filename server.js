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

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Serve public/
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// -----------------------------
// Config / Providers + Failover
// -----------------------------
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY || "";

const NEWSDATA_KEY = process.env.NEWS_API_KEY || "";          // primary: newsdata.io
const NEWSAPI_KEY = process.env.NEWSAPI_BACKUP_KEY || "";     // backup: newsapi.org

const OPENAI_KEY = process.env.OPENAI_API_KEY || "";

const MARKET_TZ = process.env.MARKET_TZ || "America/New_York";
const NEWS_ONLY_WHEN_CLOSED =
  (process.env.MARKET_NEWS_ONLY_WHEN_CLOSED || "true").toLowerCase() === "true";

async function safeJson(res) {
  const text = await res.text();
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, text };
  }
}

// -----------------------------
// Ticker validation + Universe
// -----------------------------
function isValidTicker(symbolRaw) {
  const s = String(symbolRaw || "").trim().toUpperCase();
  // allow dot and dash tickers (BRK.B, RDS-A), max 10 chars
  if (!s) return { ok: false, reason: "Empty symbol" };
  if (s.length > 10) return { ok: false, reason: "Too long" };
  if (!/^[A-Z0-9.\-]+$/.test(s)) return { ok: false, reason: "Invalid characters" };
  return { ok: true, symbol: s };
}

// Minimal S&P500-ish list for carousel mode (you can expand later)
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
  if (!universe || universe.mode === "any") return SP500_MINI; // carousel needs a list
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
// Mon-Fri 9:30–16:00 ET (holidays not included)
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
  return {
    weekday: get("weekday"), // Mon, Tue...
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

function isMarketOpen() {
  const { weekday, hour, minute } = getNowInTZ(MARKET_TZ);
  const isWeekday = ["Mon","Tue","Wed","Thu","Fri"].includes(weekday);
  if (!isWeekday) return { open: false, reason: "Weekend" };

  const mins = hour * 60 + minute;
  const openMins = 9 * 60 + 30;
  const closeMins = 16 * 60;

  if (mins < openMins) return { open: false, reason: "Pre-market" };
  if (mins >= closeMins) return { open: false, reason: "After-hours" };
  return { open: true, reason: "Open" };
}

// -----------------------------
// Stock price: Finnhub -> TwelveData
// -----------------------------
async function getStockPrice(symbol) {
  const s = symbol.toUpperCase().trim();

  if (FINNHUB_KEY) {
    try {
      const r = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${FINNHUB_KEY}`,
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
    } catch {}
  }

  if (TWELVEDATA_KEY) {
    try {
      const r = await fetch(
        `https://api.twelvedata.com/price?symbol=${encodeURIComponent(s)}&apikey=${TWELVEDATA_KEY}`,
        { timeout: 15000 }
      );
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
// News: NewsData.io -> NewsAPI.org
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

  const items = Array.from({ length: Math.min(limit, 4) }).map((_, i) => ({
    title: `${s} news placeholder #${i + 1}`,
    url: "#",
    source: "mock",
    publishedAt: new Date().toISOString(),
    summary: "No provider available",
  }));
  return { provider: "mock", items };
}

function sentimentScore(text) {
  const t = (text || "").toLowerCase();
  const pos = ["surge","beats","profit","upgrade","strong","record","growth","bullish","rally"];
  const neg = ["miss","drop","downgrade","weak","lawsuit","probe","bearish","decline","fall"];
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

// Base heuristic decision
function decideBase({ bot, avgSent, changePercent }) {
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
  if (bot === "news_only") {
    if (avgSent > 0.18) return { signal: "BUY", confidence: 66, why: "Trades strictly on positive news cluster" };
    if (avgSent < -0.18) return { signal: "SELL", confidence: 66, why: "Trades strictly on negative news cluster" };
    return { signal: "HOLD", confidence: 55, why: "News signal not strong enough" };
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

  // scale changePercent to smaller magnitude
  const z = bias + wS * s + wC * (c / 2.0);
  return { z, p: sigmoid(z) };
}

// Adjust base signal/confidence with learned probability
async function applyLearningAdjust(strategy, base, features) {
  if (!hasDb) return { ...base, learnedP: null };

  const w = await getWeights(strategy);
  const { p } = modelScore(w, features);

  // Convert p into +/- confidence adjustment around 50
  const delta = Math.round((p - 0.5) * 30); // -15..+15 typical
  const confidence = Math.max(1, Math.min(99, base.confidence + delta));

  // Optional: if learned p is strongly negative, discourage BUY, etc
  let signal = base.signal;
  if (base.signal === "BUY" && p < 0.35) signal = "HOLD";
  if (base.signal === "SELL" && p > 0.65) signal = "HOLD";

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
    RETURNING id, created_at
  `,
    [bot, strategy, symbol, signal, horizon, priceAtSignal, JSON.stringify(features || {}), rationale || "", confidence || 50, evalAfterSec]
  );
  return r.rows[0] || null;
}

// Online update weights when sample evaluated.
// We predict y=1 when “correct”, else 0. Update weights by gradient step.
async function updateModelFromOutcome(strategy, features, correctBool) {
  if (!hasDb) return;
  const y = correctBool ? 1 : 0;

  const w = await getWeights(strategy);
  const { p } = modelScore(w, features);

  // learning rate (small and stable)
  const lr = 0.05;

  const xBias = 1;
  const xSent = Number(features.avgSent || 0);
  const xChg = Number(features.changePercent || 0) / 2.0;

  const grad = (y - p); // logistic gradient for log-loss

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

    // Online update weights from this labeled outcome
    await updateModelFromOutcome(row.strategy, row.features || {}, correct);

    evaluated++;
  }

  return { evaluated };
}

// -----------------------------
// Learning verdict utilities (Phase 4)
// No schema changes. Best-effort mapping:
// - For a given trade: find nearest learning_sample in time for same bot+symbol+signal
// - If sample evaluated => WIN/LOSS else PENDING
// -----------------------------
function verdictFromSampleRow(row) {
  if (!row) return "PENDING";
  if (!row.evaluated_at) return "PENDING";
  return row.correct === true ? "WIN" : "LOSS";
}

async function attachLearningVerdictsToTrades(trades) {
  if (!hasDb) return trades || [];
  const items = Array.isArray(trades) ? trades : [];
  if (!items.length) return items;

  // Identify a time window around these trades
  const tsList = items
    .map(t => new Date(t.ts).getTime())
    .filter(x => Number.isFinite(x));
  if (!tsList.length) return items;

  const minTs = Math.min(...tsList);
  const maxTs = Math.max(...tsList);

  // Pull samples in a buffered range (10 minutes)
  const from = new Date(minTs - 10 * 60 * 1000).toISOString();
  const to   = new Date(maxTs + 10 * 60 * 1000).toISOString();

  // We need only relevant samples:
  // strategy (bot) + symbol + signal + created_at + evaluated_at + correct
  // We'll fetch per bot in one query with symbol filter.
  const bots = Array.from(new Set(items.map(t => String(t.bot || "")))).filter(Boolean);
  const symbols = Array.from(new Set(items.map(t => String(t.symbol || "")))).filter(Boolean);

  if (!bots.length || !symbols.length) {
    return items.map(t => ({ ...t, learningVerdict: "PENDING" }));
  }

  // Note: using ANY($n) arrays to keep it safe.
  const sampleRes = await dbQuery(
    `
    SELECT strategy, symbol, signal, created_at, evaluated_at, correct
    FROM learning_samples
    WHERE created_at >= $1
      AND created_at <= $2
      AND strategy = ANY($3)
      AND symbol   = ANY($4)
  `,
    [from, to, bots, symbols]
  );

  const samples = sampleRes.rows || [];

  // Index samples by (strategy|symbol|signal) and sort by created_at for nearest match
  const key = (strategy, symbol, signal) => `${strategy}||${symbol}||${signal}`;
  const map = new Map();
  for (const s of samples) {
    const k = key(s.strategy, s.symbol, s.signal);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(s);
  }
  for (const [k, arr] of map.entries()) {
    arr.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    map.set(k, arr);
  }

  function nearestSample(arr, targetMs) {
    if (!arr || !arr.length) return null;
    // binary search for closest created_at
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const midMs = new Date(arr[mid].created_at).getTime();
      if (midMs < targetMs) lo = mid + 1;
      else hi = mid;
    }
    // candidates: lo and lo-1
    const cand1 = arr[lo] || null;
    const cand0 = lo > 0 ? arr[lo - 1] : null;

    if (!cand0) return cand1;
    if (!cand1) return cand0;

    const d0 = Math.abs(new Date(cand0.created_at).getTime() - targetMs);
    const d1 = Math.abs(new Date(cand1.created_at).getTime() - targetMs);
    return d1 < d0 ? cand1 : cand0;
  }

  // Attach verdict per trade
  const out = items.map(t => {
    const bot = String(t.bot || "");
    const sym = String(t.symbol || "");
    const sig = String(t.side || "");
    const tms = new Date(t.ts).getTime();

    const arr = map.get(key(bot, sym, sig));
    const near = nearestSample(arr, tms);

    // Only accept if within 2 minutes (tight match to the fight tick)
    let verdict = "PENDING";
    if (near) {
      const deltaMs = Math.abs(new Date(near.created_at).getTime() - tms);
      if (deltaMs <= 2 * 60 * 1000) verdict = verdictFromSampleRow(near);
    }

    return { ...t, learningVerdict: verdict };
  });

  return out;
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
// News article “why it impacts stock” explanation
// OpenAI if available, fallback if not
// -----------------------------
async function explainArticleImpact({ symbol, title, summary }) {
  const s = symbol.toUpperCase().trim();
  const sent = sentimentScore(`${title} ${summary}`);
  const horizon =
    Math.abs(sent) > 0.2 ? "short" : Math.abs(sent) > 0.1 ? "medium" : "long";

  if (!OPENAI_KEY) {
    const direction =
      sent > 0.08 ? "upward" : sent < -0.08 ? "downward" : "unclear";
    return {
      summary1: `This article is likely to create ${direction} pressure on ${s} because the language and key terms imply ${sent > 0 ? "positive" : sent < 0 ? "negative" : "mixed"} investor reaction.`,
      summary2: `Expected impact horizon: ${horizon}. (Heuristic sentiment-based explanation; enable OpenAI for deeper causal reasoning.)`,
      horizon,
      confidence: Math.round((Math.min(1, Math.abs(sent)) * 60) + 35),
    };
  }

  try {
    const prompt = `
You are a market analyst. Explain in 1–2 short lines how this specific article could affect the stock price of ${s}.
Return STRICT JSON with keys: summary1, summary2, horizon (short|medium|long), confidence (0-100).
Article title: ${title}
Article summary: ${summary}
If the article is not clearly about ${s}, explain uncertainty.
`;
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
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
    if (!parsed.ok) throw new Error("OpenAI non-JSON");

    const content = parsed.json?.choices?.[0]?.message?.content || "{}";
    const out = JSON.parse(content);
    return {
      summary1: String(out.summary1 || "").slice(0, 220),
      summary2: String(out.summary2 || "").slice(0, 220),
      horizon: ["short","medium","long"].includes(out.horizon) ? out.horizon : horizon,
      confidence: Number(out.confidence) >= 0 ? Math.min(100, Math.max(0, Number(out.confidence))) : 60,
    };
  } catch {
    const direction =
      sent > 0.08 ? "upward" : sent < -0.08 ? "downward" : "unclear";
    return {
      summary1: `This article is likely to create ${direction} pressure on ${s} based on sentiment cues.`,
      summary2: `Expected impact horizon: ${horizon}.`,
      horizon,
      confidence: Math.round((Math.min(1, Math.abs(sent)) * 60) + 35),
    };
  }
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
    version: "arena-v4-ui-warroom-drawer-verdicts",
  });
});

app.get("/api/version", (req, res) => {
  res.json({ version: "arena-v4-ui-warroom-drawer-verdicts", timestamp: new Date().toISOString() });
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

    const runnerEnabled = (process.env.RUNNER_ENABLED || "").toLowerCase() === "true";
    const intervalSec = Math.max(Number(process.env.RUNNER_INTERVAL_SEC || 10), 3);
    const symbols = universeSymbols(universe);
    const nextSymbol = symbols[st.idx % symbols.length];

    res.json({
      enabled: runnerEnabled,
      intervalSec,
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

// Simple history endpoint (for TradingView mini chart usage)
app.get("/api/price/history", async (req, res) => {
  try {
    const symbolV = isValidTicker(req.query.symbol || "AAPL");
    if (!symbolV.ok) return res.status(400).json({ error: symbolV.reason });
    const symbol = symbolV.symbol;
    const points = Math.min(Math.max(Number(req.query.points || 40), 10), 200);

    const spot = await getStockPrice(symbol);
    const base = Number(spot.price);
    const series = [];
    let p = base;

    for (let i = points - 1; i >= 0; i--) {
      p = p * (1 + (Math.random() - 0.5) * 0.003);
      series.push({ t: Date.now() - i * 60_000, p: Math.round(p * 100) / 100 });
    }

    res.json({ symbol, provider: spot.provider, series });
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

// Explain article impact (1–2 lines)
app.post("/api/news/explain", async (req, res) => {
  try {
    const { symbol, title, summary } = req.body || {};
    const symbolV = isValidTicker(symbol);
    if (!symbolV.ok) return res.status(400).json({ error: symbolV.reason });

    const out = await explainArticleImpact({
      symbol: symbolV.symbol,
      title: String(title || ""),
      summary: String(summary || ""),
    });

    res.json({ symbol: symbolV.symbol, ...out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Market overview (popular stocks)
app.get("/api/market-overview", async (req, res) => {
  try {
    const symbols = SP500_MINI.slice(0, 10);
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

// Trades recent (with learningVerdict)
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
    const items = await attachLearningVerdictsToTrades(r.rows || []);
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trades by bot (full history, with learningVerdict)
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

    const items = await attachLearningVerdictsToTrades(r.rows || []);
    res.json({ items });
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

// NEW: Learning verdict summary for a bot (Phase 4)
// Used by War Room drawer to compute win rate KPI.
// NOTE: This does not require schema changes.
app.get("/api/learning/verdicts", async (req, res) => {
  try {
    if (!hasDb) return res.json({ bot: null, verdictByTradeId: {}, stats: { win: 0, loss: 0, pending: 0 } });

    const bot = String(req.query.bot || "").trim();
    if (!bot) return res.status(400).json({ error: "Missing bot" });

    // Recent window — last N days
    const days = Math.min(Math.max(Number(req.query.days || 14), 1), 90);

    const r = await dbQuery(
      `
      SELECT evaluated_at, correct
      FROM learning_samples
      WHERE strategy = $1
        AND created_at >= NOW() - ($2 || ' days')::interval
      ORDER BY created_at DESC
      LIMIT 2000
    `,
      [bot, days]
    );

    let win = 0, loss = 0, pending = 0;
    for (const row of (r.rows || [])) {
      if (!row.evaluated_at) pending++;
      else if (row.correct === true) win++;
      else loss++;
    }

    // We keep verdictByTradeId empty by design (no schema link).
    // Per-trade verdicts are served on /api/trades/* via best-effort matching.
    res.json({
      bot,
      verdictByTradeId: {},
      stats: { win, loss, pending }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------
// BOT FIGHT endpoint
// - validates ticker
// - uses learning model to adjust confidence/signal
// - market-hours gate: trades only when market open
// - when market closed AND NEWS_ONLY_WHEN_CLOSED=true => no trades, but still logs learning + emits events
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

    // Base + learning-adjusted decisions for each bot
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

    // Winner = highest confidence
    const winner = bots.reduce((a, b) => (b.confidence > a.confidence ? b : a), bots[0]);

    // Learning sample logging
    let logged = 0;
    let logError = null;

    const evalAfterSec =
      setting?.mode === "accelerated"
        ? (Number(setting.evalAfterSec) > 0 ? Number(setting.evalAfterSec) : 30)
        : (Number(setting.evalAfterSec) > 0 ? Number(setting.evalAfterSec) : 3600);

    const sampleIds = [];

    if (hasDb) {
      try {
        await ensurePortfolios();

        for (const b of bots) {
          const row = await logLearningSample({
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
          if (row?.id) {
            logged++;
            sampleIds.push({ strategy: b.strategy, id: row.id });
          }
        }
      } catch (e) {
        logError = e.message;
      }
    }

    // Execute ONE trade by winner (if allowed).
    // If market closed and NEWS_ONLY_WHEN_CLOSED=true => still emit event but do not place trades.
    let executedTrade = null;

    if (hasDb) {
      try {
        const bot = winner.strategy;
        const side = winner.signal;

        const canTrade = tradesAllowed;
        const shouldPaperOnly = !canTrade && NEWS_ONLY_WHEN_CLOSED;

        if (canTrade) {
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
                confidence: winner.confidence,
                horizon: winner.horizon,
                features,
              });
              await applyTradeToPortfolio({ bot, symbol, side: "BUY", qty, price: Number(q.price) });
            }
          } else if (side === "SELL") {
            const pos = await dbQuery(`SELECT qty FROM positions WHERE bot=$1 AND symbol=$2`, [bot, symbol]);
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
                confidence: winner.confidence,
                horizon: winner.horizon,
                features,
              });
              await applyTradeToPortfolio({ bot, symbol, side: "SELL", qty, price: Number(q.price) });
            }
          } else {
            executedTrade = await recordTrade({
              bot,
              symbol,
              side: "HOLD",
              qty: 0,
              price: Number(q.price),
              rationale: winner.rationale,
              confidence: winner.confidence,
              horizon: winner.horizon,
              features,
            });
          }
        } else if (shouldPaperOnly) {
          // “News-only mode while closed” => log HOLD trade as a “paper event” without portfolio changes
          executedTrade = await recordTrade({
            bot,
            symbol,
            side: "HOLD",
            qty: 0,
            price: Number(q.price),
            rationale: `Market closed (${market.reason}). Paper mode: ${winner.rationale}`,
            confidence: winner.confidence,
            horizon: winner.horizon,
            features,
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
          sampleIds, // informational only
        });
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

  const runnerEnabled = (process.env.RUNNER_ENABLED || "").toLowerCase() === "true";
  const intervalSec = Math.max(Number(process.env.RUNNER_INTERVAL_SEC || 10), 3);

  if (runnerEnabled) {
    console.log(`♻ Runner enabled. Interval: ${intervalSec}s`);

    // Resume from runner_state
    let state = hasDb ? await getRunnerState() : { idx: 0, lastTick: null, lastSymbol: "AAPL" };

    setInterval(async () => {
      try {
        const universe = await getUniverse();
        const symbols = universeSymbols(universe);

        const m = isMarketOpen();
        const idx = Number(state.idx || 0);
        const symbol = symbols[idx % symbols.length];

        // Update runner state BEFORE doing work (so redeploy resumes smoothly)
        state = {
          idx: idx + 1,
          lastTick: new Date().toISOString(),
          lastSymbol: symbol,
        };
        if (hasDb) await setRunnerState(state);

        await emitEvent("carousel_tick", { symbol, idx, market: m, universe });

        // Always evaluate learning due
        const ev = await evaluateDueLearning();
        if (ev.evaluated) await emitEvent("learning_evaluated", ev);

        // Run fight every tick. If market closed, endpoint will go “paper mode” if enabled.
        await fetch(`http://127.0.0.1:${PORT}/api/bots/${symbol}`).catch(() => {});
      } catch {}
    }, intervalSec * 1000);
  } else {
    console.log(`⏸ Runner disabled (set RUNNER_ENABLED=true to enable)`);
  }
}

start();

export default app;
