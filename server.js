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
// ENV (Railway)
// -----------------------------
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY || "";

const NEWSDATA_KEY = process.env.NEWS_API_KEY || "";       // ✅ NewsData.io primary
const NEWSAPI_KEY = process.env.NEWSAPI_BACKUP_KEY || "";  // ✅ NewsAPI backup

const OPENAI_KEY = process.env.OPENAI_API_KEY || "";

const MARKET_TZ = process.env.MARKET_TZ || "America/New_York";
const NEWS_ONLY_WHEN_CLOSED =
  (process.env.MARKET_NEWS_ONLY_WHEN_CLOSED || "true").toLowerCase() === "true";

const RUNNER_ENABLED =
  (process.env.RUNNER_ENABLED || "true").toLowerCase() === "true";
const RUNNER_INTERVAL_SEC = Number(process.env.RUNNER_INTERVAL_SEC || 5);
const RUNNER_SCAN_BATCH = Number(process.env.RUNNER_SCAN_BATCH || 40);
const RUNNER_TRADE_TOP = Number(process.env.RUNNER_TRADE_TOP || 3);
const RUNNER_LOCK_ID = process.env.RUNNER_LOCK_ID || "default-lock";

// AUTO_SYMBOLS
function parseAutoSymbols() {
  const raw = String(process.env.AUTO_SYMBOLS || "").trim();
  if (!raw) return null;
  const arr = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return arr.length ? arr : null;
}

// -----------------------------
// Crash-proof fetch (fixes 502)
// -----------------------------
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function safeJson(res) {
  const text = await res.text();
  try {
    return { ok: res.ok, json: JSON.parse(text), text };
  } catch {
    return { ok: false, json: null, text };
  }
}

function getNowInTZ(tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
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

function isValidTicker(raw) {
  const s = String(raw || "").toUpperCase().trim();
  if (!s) return { ok: false, reason: "Missing symbol" };
  if (!/^[A-Z.\-]{1,10}$/.test(s))
    return { ok: false, reason: "Invalid ticker format" };
  return { ok: true, symbol: s };
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
// Data: Prices
// -----------------------------
async function getStockPrice(symbol) {
  const s = symbol.toUpperCase().trim();

  if (FINNHUB_KEY) {
    try {
      const r = await fetchWithTimeout(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${encodeURIComponent(FINNHUB_KEY)}`,
        {},
        15000
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
      const r = await fetchWithTimeout(
        `https://api.twelvedata.com/price?symbol=${encodeURIComponent(s)}&apikey=${encodeURIComponent(TWELVEDATA_KEY)}`,
        {},
        15000
      );
      const parsed = await safeJson(r);
      if (parsed.ok && parsed.json?.price) {
        const price = Number(parsed.json.price);
        if (Number.isFinite(price)) {
          return { provider: "twelvedata", symbol: s, price, changePercent: 0 };
        }
      }
    } catch {}
  }

  // Mock fallback
  const base = 50 + (s.charCodeAt(0) % 40);
  const t = Date.now() / 1000;
  const price = base + 3 * Math.sin(t / 30);
  return { provider: "mock", symbol: s, price: Number(price.toFixed(2)), changePercent: 0 };
}

// -----------------------------
// Data: News (symbol)
// -----------------------------
async function getNewsForSymbol(symbol, limit = 8) {
  const s = symbol.toUpperCase().trim();

  if (NEWSDATA_KEY) {
    try {
      const url =
        `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(NEWSDATA_KEY)}` +
        `&q=${encodeURIComponent(s)}&language=en&size=${Math.min(limit, 10)}`;
      const r = await fetchWithTimeout(url, {}, 15000);
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
      const r = await fetchWithTimeout(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(s)}&language=en&pageSize=${limit}&sortBy=publishedAt`,
        { headers: { "X-Api-Key": NEWSAPI_KEY } },
        15000
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

  // Mock fallback (never crashes)
  const items = Array.from({ length: Math.min(limit, 8) }).map((_, i) => ({
    title: `${s} news placeholder #${i + 1} (configure NEWS_API_KEY for NewsData.io)`,
    url: "#",
    source: "mock",
    publishedAt: new Date().toISOString(),
    summary: "No provider available",
  }));
  return { provider: "mock", items };
}

// -----------------------------
// Data: General News (Top 8) — Arena v2 uses this
// -----------------------------
async function getGeneralNews(limit = 8) {
  if (NEWSDATA_KEY) {
    try {
      const url =
        `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(NEWSDATA_KEY)}` +
        `&country=us&language=en&size=${Math.min(limit, 10)}`;
      const r = await fetchWithTimeout(url, {}, 15000);
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
      return { provider: "newsdata", items: [] };
    } catch {
      return { provider: "error", items: [] };
    }
  }

  if (NEWSAPI_KEY) {
    try {
      const r = await fetchWithTimeout(
        `https://newsapi.org/v2/top-headlines?country=us&pageSize=${limit}`,
        { headers: { "X-Api-Key": NEWSAPI_KEY } },
        15000
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
      return { provider: "newsapi", items: [] };
    } catch {
      return { provider: "error", items: [] };
    }
  }

  // If no keys, still show placeholders (UX clarity)
  const items = Array.from({ length: Math.min(limit, 8) }).map((_, i) => ({
    title: `General news placeholder #${i + 1} (add NEWS_API_KEY in Railway)`,
    url: "#",
    source: "mock",
    publishedAt: new Date().toISOString(),
    summary: "No provider configured",
  }));
  return { provider: "mock", items };
}

// -----------------------------
// Bots
// -----------------------------
const BOTS = [
  { bot: "sp500_long", label: "S&P500 Long", horizon: "long" },
  { bot: "market_swing", label: "Market Swing", horizon: "medium" },
  { bot: "day_trade", label: "Day Trade", horizon: "short" },
  { bot: "news_only", label: "News-Only", horizon: "short" },
];

const START_CASH = 100000;
const GOAL_CASH = 150000;

async function ensureBotAccounts() {
  if (!hasDb) return;
  for (const b of BOTS) {
    await dbQuery(
      `
      INSERT INTO bot_accounts(bot, cash, goal)
      VALUES ($1, $2, $3)
      ON CONFLICT (bot) DO NOTHING
    `,
      [b.bot, START_CASH, GOAL_CASH]
    );
  }
}

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
      return { signal: dir, confidence: 60, why: "Short-term volatility reaction" };
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

// Online learner (simple logistic regression)
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
  if (base.signal === "BUY" && p < 0.35) signal = "HOLD";
  if (base.signal === "SELL" && p > 0.65) signal = "HOLD";

  return { ...base, signal, confidence, learnedP: p };
}

async function recordTrade({ bot, strategy, symbol, side, qty, price, rationale, confidence, horizon, marketOpen, features }) {
  if (!hasDb) return null;
  const r = await dbQuery(
    `
    INSERT INTO bot_trades(bot, strategy, symbol, side, qty, price, rationale, confidence, horizon, market_open, features)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    RETURNING *
  `,
    [
      bot,
      strategy || "",
      symbol,
      side,
      qty,
      price,
      rationale || "",
      confidence || 50,
      horizon || "medium",
      !!marketOpen,
      JSON.stringify(features || {}),
    ]
  );
  return r.rows[0];
}

async function applyTradeToAccount({ bot, symbol, side, qty, price }) {
  if (!hasDb) return;

  const ar = await dbQuery(`SELECT cash FROM bot_accounts WHERE bot=$1`, [bot]);
  if (!ar.rows[0]) return;
  let cash = Number(ar.rows[0].cash);

  const pr = await dbQuery(
    `SELECT qty, avg_price FROM bot_positions WHERE bot=$1 AND symbol=$2`,
    [bot, symbol]
  );
  let curQty = pr.rows[0] ? Number(pr.rows[0].qty) : 0;
  let avgPrice = pr.rows[0] ? Number(pr.rows[0].avg_price) : 0;

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

  await dbQuery(`UPDATE bot_accounts SET cash=$2, updated_at=NOW() WHERE bot=$1`, [bot, cash]);

  await dbQuery(
    `
    INSERT INTO bot_positions(bot, symbol, qty, avg_price, updated_at)
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
    [
      bot,
      strategy,
      symbol,
      signal,
      horizon,
      priceAtSignal,
      JSON.stringify(features || {}),
      rationale || "",
      confidence || 50,
      evalAfterSec,
    ]
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
// Runner universe
// -----------------------------
function defaultUniverse() {
  const auto = parseAutoSymbols();
  if (auto && auto.length) return auto;

  // fallback basket
  return ["AAPL","MSFT","NVDA","TSLA","AMZN","GOOGL","META","KO","XOM","LLY","AVGO","COST","UNH","WMT"];
}

async function getUniverseList() {
  const st = (await getSetting("universe")) || { mode: "auto", custom: [] };
  if (st.mode === "custom" && Array.isArray(st.custom) && st.custom.length) return st.custom.map(s => String(s).toUpperCase());
  return defaultUniverse();
}

async function nextSymbol() {
  const list = await getUniverseList();
  const state = await getRunnerState();
  const idx = Number(state.idx || 0);
  const sym = list[idx % list.length] || list[0];
  const next = (idx + 1) % list.length;

  const newState = {
    idx: idx + 1,
    lastTick: new Date().toISOString(),
    lastSymbol: sym,
  };
  await setRunnerState(newState);
  return { sym, nextSym: list[next] || list[0], state: newState, listLen: list.length };
}

// -----------------------------
// Fight
// -----------------------------
async function fightSymbol(symbol) {
  const market = isMarketOpen();
  const tradesAllowed = market.open || !NEWS_ONLY_WHEN_CLOSED;

  const priceInfo = await getStockPrice(symbol);
  const news = await getNewsForSymbol(symbol, 8);
  const avgSent =
    news.items?.length
      ? news.items.map(a => sentimentScore(`${a.title} ${a.summary}`)).reduce((a,b)=>a+b,0) / news.items.length
      : 0;

  const features = {
    avgSent: Number(avgSent.toFixed(3)),
    changePercent: Number((priceInfo.changePercent ?? 0).toFixed(3)),
    price: Number(priceInfo.price),
    priceProvider: priceInfo.provider,
    newsProvider: news.provider,
    marketOpen: market.open,
  };

  const bots = [];
  for (const b of BOTS) {
    const base = decideBase({ bot: b.bot, avgSent: features.avgSent, changePercent: features.changePercent });
    const adj = await applyLearningAdjust(b.bot, base, features);
    bots.push({
      strategy: b.bot,
      label: b.label,
      signal: adj.signal,
      horizon: b.horizon,
      rationale: adj.why,
      baseConfidence: base.confidence,
      confidence: adj.confidence,
      learnedP: adj.learnedP,
    });

    // learning sample per decision
    const speed = (await getSetting("learning_speed")) || { mode: "realtime", evalAfterSec: 3600 };
    const evalAfterSec = speed.mode === "accelerated" ? 60 : Number(speed.evalAfterSec || 3600);
    await logLearningSample({
      bot: b.bot,
      strategy: b.bot,
      symbol,
      signal: adj.signal,
      horizon: b.horizon,
      priceAtSignal: features.price,
      features,
      rationale: adj.why,
      confidence: adj.confidence,
      evalAfterSec,
    });
  }

  // pick winner by confidence
  const sorted = [...bots].sort((a,b)=>b.confidence-a.confidence);
  const winner = sorted[0]?.strategy || "sp500_long";

  // Execute top N trades if allowed
  if (hasDb && tradesAllowed) {
    const top = sorted.slice(0, RUNNER_TRADE_TOP);
    for (const bot of top) {
      if (bot.signal === "HOLD") continue;

      const qty = 1; // conservative single-share execution
      await recordTrade({
        bot: bot.strategy,
        strategy: bot.strategy,
        symbol,
        side: bot.signal,
        qty,
        price: features.price,
        rationale: bot.rationale,
        confidence: bot.confidence,
        horizon: bot.horizon,
        marketOpen: market.open,
        features,
      });

      await applyTradeToAccount({
        bot: bot.strategy,
        symbol,
        side: bot.signal,
        qty,
        price: features.price,
      });
    }
  }

  const learningEval = await evaluateDueLearning();

  return {
    symbol,
    market,
    tradesAllowed,
    features,
    bots,
    winner,
    newsProvider: news.provider,
    newsItems: news.items,
    learningEvaluated: learningEval.evaluated,
  };
}

// -----------------------------
// API
// -----------------------------
app.get("/api/health", async (_req, res) => {
  const market = isMarketOpen();
  res.json({
    ok: true,
    market,
    postgres: hasDb,
    apis: {
      finnhub: !!FINNHUB_KEY,
      twelvedata: !!TWELVEDATA_KEY,
      newsData: !!NEWSDATA_KEY,
      newsApi: !!NEWSAPI_KEY,
      openai: !!OPENAI_KEY,
      postgres: hasDb,
    },
    runner: {
      enabled: RUNNER_ENABLED,
      intervalSec: RUNNER_INTERVAL_SEC,
      scanBatch: RUNNER_SCAN_BATCH,
      tradeTop: RUNNER_TRADE_TOP,
      lockId: RUNNER_LOCK_ID,
    },
  });
});

app.get("/api/runner/status", async (_req, res) => {
  const market = isMarketOpen();
  const state = await getRunnerState();
  const uni = (await getSetting("universe")) || { mode: "auto", custom: [] };
  const list = await getUniverseList();
  const idx = Number(state.idx || 0);
  res.json({
    enabled: RUNNER_ENABLED,
    intervalSec: RUNNER_INTERVAL_SEC,
    scanBatch: RUNNER_SCAN_BATCH,
    tradeTop: RUNNER_TRADE_TOP,
    lockId: RUNNER_LOCK_ID,
    market,
    newsOnlyWhenClosed: NEWS_ONLY_WHEN_CLOSED,
    universe: uni,
    state,
    nextSymbol: list[(idx + 1) % list.length] || list[0],
  });
});

// Compatibility endpoint used by your War Room UI
app.get("/api/portfolios", async (_req, res) => {
  if (!hasDb) return res.json({ items: [] });
  const r = await dbQuery(`SELECT bot, cash, goal FROM bot_accounts ORDER BY bot ASC`);
  res.json({ items: r.rows });
});

// ✅ Fixes: “column ts/bot/rationale does not exist” — now reads bot_trades only
app.get("/api/trades/recent", async (req, res) => {
  if (!hasDb) return res.json({ items: [] });
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 25)));
  const r = await dbQuery(
    `SELECT id, ts, bot, side, symbol, qty, price, rationale, confidence, horizon
     FROM bot_trades
     ORDER BY ts DESC
     LIMIT $1`,
    [limit]
  );
  res.json({ items: r.rows });
});

// ✅ Fixes bot drawer: /api/trades/bot/day_trade was missing
app.get("/api/trades/bot/:bot", async (req, res) => {
  if (!hasDb) return res.json({ items: [] });
  const bot = String(req.params.bot || "").trim();
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 100)));
  const r = await dbQuery(
    `SELECT id, ts, bot, side, symbol, qty, price, rationale, confidence, horizon
     FROM bot_trades
     WHERE bot=$1
     ORDER BY ts DESC
     LIMIT $2`,
    [bot, limit]
  );
  res.json({ items: r.rows });
});

// Bots fight (on-demand)
app.get("/api/bots/:symbol", async (req, res) => {
  const v = isValidTicker(req.params.symbol);
  if (!v.ok) return res.status(400).json({ error: v.reason });

  try {
    const out = await fightSymbol(v.symbol);
    res.json({
      symbol: out.symbol,
      market: out.market,
      tradesAllowed: out.tradesAllowed,
      logged: out.learningEvaluated,
      logError: null,
      features: out.features,
      bots: out.bots,
      winner: out.winner,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Fight failed" });
  }
});

// Arena needs Top 8 general news
app.get("/api/news/general", async (_req, res) => {
  const data = await getGeneralNews(8);
  res.json(data);
});

// Universe / Learning toggles (kept for your UI)
app.get("/api/settings", async (_req, res) => {
  const speed = (await getSetting("learning_speed")) || { mode: "realtime", evalAfterSec: 3600 };
  const uni = (await getSetting("universe")) || { mode: "auto", custom: [] };
  res.json({ learning_speed: speed, universe: uni });
});

app.post("/api/settings/learning_speed", async (req, res) => {
  const mode = String(req.body?.mode || "realtime");
  const evalAfterSec = Number(req.body?.evalAfterSec || 3600);
  const v = { mode, evalAfterSec };
  await setSetting("learning_speed", v);
  res.json(v);
});

app.post("/api/settings/universe", async (req, res) => {
  const mode = String(req.body?.mode || "auto");
  const custom = Array.isArray(req.body?.custom) ? req.body.custom : [];
  const clean = custom
    .map(s => String(s || "").toUpperCase().trim())
    .filter(Boolean)
    .slice(0, 500);
  const v = { mode, custom: clean };
  await setSetting("universe", v);
  res.json(v);
});

// -----------------------------
// Boot + WS + Runner loop
// -----------------------------
const server = app.listen(PORT, async () => {
  console.log(`Server on :${PORT}`);
  await dbInit();
  await ensureBotAccounts();
  console.log("DB init OK:", hasDb);

  // Emit boot event
  await emitEvent("server_booted", { ok: true });
});

wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
  ws.send(JSON.stringify({ type: "hello", ts: new Date().toISOString(), payload: { ok: true } }));
});

let runnerTimer = null;

async function runnerTick() {
  const market = isMarketOpen();
  const { sym, nextSym, state } = await nextSymbol();

  await emitEvent("runner_state", { ...state, market });

  await emitEvent("carousel_tick", { symbol: sym, market });

  try {
    const out = await fightSymbol(sym);
    await emitEvent("bot_fight", {
      symbol: sym,
      winner: out.winner,
      tradesAllowed: out.tradesAllowed,
      newsProvider: out.newsProvider,
    });

    if (out.learningEvaluated) {
      await emitEvent("learning_evaluated", { evaluated: out.learningEvaluated });
    }
  } catch (e) {
    await emitEvent("runner_error", { symbol: sym, error: e.message || String(e) });
  }
}

if (RUNNER_ENABLED) {
  runnerTimer = setInterval(() => runnerTick().catch(() => {}), Math.max(2, RUNNER_INTERVAL_SEC) * 1000);
  // kick once immediately
  runnerTick().catch(() => {});
}
