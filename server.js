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
// ENV (matches your Railway vars)
// -----------------------------
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY || "";

const NEWSDATA_KEY = process.env.NEWS_API_KEY || ""; // primary: newsdata.io
const NEWSAPI_KEY = process.env.NEWSAPI_BACKUP_KEY || ""; // backup: newsapi.org

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

// AUTO_SYMBOLS (your Railway var)
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
    "wins",
    "approval",
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
    "ban",
    "recall",
  ];
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
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
          s
        )}&token=${encodeURIComponent(FINNHUB_KEY)}`,
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
        `https://api.twelvedata.com/price?symbol=${encodeURIComponent(
          s
        )}&apikey=${encodeURIComponent(TWELVEDATA_KEY)}`,
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
            changePercent: 0,
          };
        }
      }
    } catch {}
  }

  return {
    provider: "mock",
    symbol: s,
    price: Math.round((50 + Math.random() * 450) * 100) / 100,
    changePercent: Math.round(((Math.random() - 0.5) * 2) * 1000) / 1000,
  };
}

// -----------------------------
// News: NewsData.io -> NewsAPI.org -> Mock
// -----------------------------
async function getNews(symbol, limit = 8) {
  const s = symbol.toUpperCase().trim();

  if (NEWSDATA_KEY) {
    try {
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
    } catch {}
  }

  if (NEWSAPI_KEY) {
    try {
      const r = await fetch(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(
          s
        )}&language=en&pageSize=${limit}&sortBy=publishedAt`,
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
// General (non-finance) news feed -> impacted tickers (Arena v2)
// -----------------------------
const FINANCEY_NEWS_TERMS = [
  "stock",
  "stocks",
  "shares",
  "earnings",
  "nasdaq",
  "nyse",
  "dow",
  "s&p",
  "sp500",
  "analyst",
  "price target",
  "upgrade",
  "downgrade",
  "quarter",
  "q1",
  "q2",
  "q3",
  "q4",
  "dividend",
  "guidance",
  "ipo",
  "sec filing",
  "10-k",
  "10-q",
];

function looksTooFinancey(article) {
  const hay = `${article?.title || ""} ${article?.summary || ""}`.toLowerCase();
  return FINANCEY_NEWS_TERMS.some((w) => hay.includes(w));
}

async function getGeneralNews(limit = 8) {
  // Broad, real-world “macro” query. Goal: non-finance news that still moves markets.
  const query =
    "(inflation OR rates OR fed OR oil OR opec OR war OR sanctions OR regulation OR ai OR chips OR supply chain OR shipping OR election OR cybersecurity OR climate)";

  // NewsData: q=...
  if (NEWSDATA_KEY) {
    try {
      const r = await fetch(
        `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(
          NEWSDATA_KEY
        )}&q=${encodeURIComponent(query)}&language=en`,
        { timeout: 15000 }
      );
      const parsed = await safeJson(r);
      if (parsed.ok && Array.isArray(parsed.json?.results)) {
        const items = parsed.json.results
          .map((a) => ({
            title: a.title || "",
            url: a.link || "",
            source: a.source_id || "newsdata",
            publishedAt: a.pubDate || "",
            summary: a.description || "",
          }))
          .filter((a) => a.title)
          .filter((a) => !looksTooFinancey(a))
          .slice(0, limit);
        return { provider: "newsdata", items };
      }
    } catch {}
  }

  // NewsAPI: q=...
  if (NEWSAPI_KEY) {
    try {
      const r = await fetch(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(
          query
        )}&language=en&pageSize=${Math.min(limit * 2, 20)}&sortBy=publishedAt`,
        { timeout: 15000, headers: { "X-Api-Key": NEWSAPI_KEY } }
      );
      const parsed = await safeJson(r);
      if (parsed.ok && Array.isArray(parsed.json?.articles)) {
        const items = parsed.json.articles
          .map((a) => ({
            title: a.title || "",
            url: a.url || "",
            source: a.source?.name || "newsapi",
            publishedAt: a.publishedAt || "",
            summary: a.description || "",
          }))
          .filter((a) => a.title)
          .filter((a) => !looksTooFinancey(a))
          .slice(0, limit);
        return { provider: "newsapi", items };
      }
    } catch {}
  }

  // Mock fallback (never empty)
  const items = Array.from({ length: Math.min(limit, 8) }).map((_, i) => ({
    title: `General news placeholder #${i + 1} (configure NEWS keys for real headlines)`,
    url: "#",
    source: "mock",
    publishedAt: new Date().toISOString(),
    summary: "Add NEWS_API_KEY or NEWSAPI_BACKUP_KEY in Railway to fetch real headlines.",
  }));
  return { provider: "mock", items };
}

// Simple “impact router”: keywords -> a small set of tickers the average user recognizes.
// This is intentionally non-technical and explainable; OpenAI can later upgrade it.
const IMPACT_RULES = [
  {
    name: "Oil & Energy",
    terms: ["oil", "crude", "opec", "brent", "gas", "pipeline", "refinery"],
    tickers: ["XOM", "CVX", "COP"],
    horizon: "short",
  },
  {
    name: "Rates & Inflation",
    terms: [
      "inflation",
      "rates",
      "fed",
      "powell",
      "cpi",
      "ppi",
      "jobs report",
      "unemployment",
    ],
    tickers: ["JPM", "BAC", "GS", "V"],
    horizon: "medium",
  },
  {
    name: "Chips & AI",
    terms: ["chip", "chips", "semiconductor", "gpu", "ai", "nvidia", "amd", "tsmc"],
    tickers: ["NVDA", "AMD", "MSFT", "GOOGL"],
    horizon: "short",
  },
  {
    name: "Cybersecurity",
    terms: ["hack", "breach", "cyber", "ransomware", "outage"],
    tickers: ["MSFT", "AMZN", "GOOGL"],
    horizon: "short",
  },
  {
    name: "Shipping & Supply Chain",
    terms: ["shipping", "supply chain", "port", "freight", "strike", "container"],
    tickers: ["WMT", "AMZN", "AAPL"],
    horizon: "medium",
  },
  {
    name: "Regulation & Antitrust",
    terms: ["regulation", "antitrust", "ban", "lawsuit", "doj", "eu"],
    tickers: ["META", "GOOGL", "AAPL", "MSFT"],
    horizon: "medium",
  },
  {
    name: "Geopolitics",
    terms: [
      "war",
      "sanctions",
      "missile",
      "conflict",
      "attack",
      "ukraine",
      "israel",
      "iran",
      "china",
      "taiwan",
    ],
    tickers: ["XOM", "LMT", "RTX", "NVDA"],
    horizon: "short",
  },
  {
    name: "Consumer + Retail",
    terms: ["consumer", "spending", "prices", "boycott", "retail", "food", "shortage"],
    tickers: ["WMT", "COST", "KO"],
    horizon: "medium",
  },
];

function inferImpactedTickers(article) {
  const text = `${article?.title || ""} ${article?.summary || ""}`.toLowerCase();
  const hits = [];

  for (const rule of IMPACT_RULES) {
    if (rule.terms.some((t) => text.includes(t))) hits.push(rule);
  }

  const tickers = Array.from(new Set(hits.flatMap((h) => h.tickers))).slice(0, 8);

  let why = "Broader market relevance detected.";
  let horizon = "short";
  let confidence = 55;

  if (hits.length) {
    const top = hits[0];
    why = `${top.name} headline: likely impacts the related sector basket.`;
    horizon = top.horizon;
    confidence = Math.min(85, 60 + hits.length * 8);
  } else {
    const mega = ["apple", "microsoft", "google", "amazon", "meta", "tesla", "nvidia"];
    if (mega.some((m) => text.includes(m))) {
      why = "Major mega-cap brand mentioned: tends to ripple into related tickers.";
      horizon = "short";
      confidence = 62;
    }
  }

  return {
    tickers,
    why,
    horizon,
    confidence,
    ruleHits: hits.map((h) => h.name),
  };
}

// -----------------------------
// Universe + carousel symbols
// -----------------------------
const SP500_MINI = [
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "GOOGL",
  "META",
  "TSLA",
  "AMD",
  "NFLX",
  "INTC",
  "JPM",
  "V",
  "MA",
  "UNH",
  "XOM",
  "COST",
  "WMT",
  "AVGO",
  "LLY",
  "KO",
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
// Bots + Learning
// -----------------------------
const START_CASH = 100000;
const GOAL_CASH = 150000;

const BOTS = [
  { strategy: "sp500_long", label: "S&P500 Long", horizon: "long" },
  { strategy: "market_swing", label: "Market Swing", horizon: "medium" },
  { strategy: "day_trade", label: "Day Trade", horizon: "short" },
  { strategy: "news_only", label: "News-Only", horizon: "short" },
];

function baseDecision(strategy, features) {
  const { avgSent, changePercent } = features;

  if (strategy === "sp500_long") {
    if (changePercent < -1.25)
      return { signal: "BUY", confidence: 64, why: "Long-bias: buying dip on quality" };
    if (changePercent > 2.0)
      return { signal: "SELL", confidence: 56, why: "Long-bias: trimming strength" };
    return { signal: "HOLD", confidence: 54, why: "No long-term edge detected" };
  }

  if (strategy === "market_swing") {
    if (changePercent < -0.9)
      return { signal: "BUY", confidence: 61, why: "Swing: mean reversion dip buy" };
    if (changePercent > 1.2) return { signal: "SELL", confidence: 60, why: "Swing: sell rally" };
    return { signal: "HOLD", confidence: 53, why: "No swing setup" };
  }

  if (strategy === "day_trade") {
    if (Math.abs(changePercent) > 0.8) {
      return {
        signal: changePercent < 0 ? "BUY" : "SELL",
        confidence: 57,
        why: "Short-term volatility reaction",
      };
    }
    return { signal: "HOLD", confidence: 53, why: "Range noise" };
  }

  if (strategy === "news_only") {
    if (avgSent > 0.18)
      return { signal: "BUY", confidence: 66, why: "Trades strictly on positive news cluster" };
    if (avgSent < -0.18)
      return { signal: "SELL", confidence: 66, why: "Trades strictly on negative news cluster" };
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

// ✅ Always insert BOTH bot + strategy (never NULL)
async function recordTrade({
  bot,
  strategy,
  symbol,
  side,
  qty,
  price,
  rationale,
  confidence,
  horizon,
  features,
}) {
  if (!hasDb) return null;

  const b = bot ?? strategy ?? "unknown";
  const st = strategy ?? bot ?? "unknown";

  const r = await dbQuery(
    `
    INSERT INTO trades(bot, strategy, symbol, side, qty, price, rationale, confidence, horizon, features)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    RETURNING *
  `,
    [
      b,
      st,
      symbol,
      side,
      Number(qty) || 0,
      Number(price) || 0,
      String(rationale || ""),
      Number(confidence) || 50,
      String(horizon || "medium"),
      JSON.stringify(features || {}),
    ]
  );

  return r.rows[0];
}

async function applyTradeToPortfolio({ bot, symbol, side, qty, price }) {
  if (!hasDb) return;

  const pr = await dbQuery(`SELECT cash FROM portfolios WHERE bot=$1`, [bot]);
  if (!pr.rows[0]) return;

  let cash = Number(pr.rows[0].cash);

  const pos = await dbQuery(`SELECT qty, avg_price FROM positions WHERE bot=$1 AND symbol=$2`, [
    bot,
    symbol,
  ]);

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

async function logLearningSample({
  bot,
  strategy,
  symbol,
  signal,
  horizon,
  priceAtSignal,
  features,
  rationale,
  confidence,
  evalAfterSec,
}) {
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

  const lr = 0.15;

  const s = Number(features.avgSent || 0);
  const c = Number(features.changePercent || 0) / 2.0;

  const grad = y - p;

  const newBias = Number(w.bias || 0) + lr * grad * 1.0;
  const newWS = Number(w.avgSent || 0) + lr * grad * s;
  const newWC = Number(w.changePercent || 0) + lr * grad * c;

  await setWeight(strategy, "bias", newBias);
  await setWeight(strategy, "avgSent", newWS);
  await setWeight(strategy, "changePercent", newWC);
}

// -----------------------------
// Runner + WebSocket (event feed)
// -----------------------------
const server = app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  if (hasDb) {
    await dbInit();
    console.log("✅ DB initialized");
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set();

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const c of clients) {
    try {
      c.send(msg);
    } catch {}
  }
}

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

async function emitEvent(type, payload = {}) {
  const event = { type, ts: new Date().toISOString(), payload };

  if (hasDb) {
    try {
      const r = await dbQuery(
        `INSERT INTO events(type, payload) VALUES ($1, $2::jsonb) RETURNING id, ts`,
        [type, JSON.stringify(payload || {})]
      );
      event.id = r.rows[0]?.id ?? null;
      event.ts = r.rows[0]?.ts ?? event.ts;
    } catch {}
  }

  broadcast(event);
  return event;
}

// -----------------------------
// API: Health + Status
// -----------------------------
app.get("/api/health", async (req, res) => {
  res.json({
    ok: true,
    postgres: !!hasDb,
    ts: new Date().toISOString(),
  });
});

app.get("/api/runner/status", async (req, res) => {
  const enabled = (process.env.RUNNER_ENABLED || "true").toLowerCase() === "true";
  const intervalSec = Number(process.env.RUNNER_INTERVAL_SEC || 5);
  const scanBatch = Number(process.env.RUNNER_SCAN_BATCH || 40);
  const tradeTop = Number(process.env.RUNNER_TRADE_TOP || 3);
  const lockId = process.env.RUNNER_LOCK_ID || "default-lock";

  const market = isMarketOpen();
  const state = hasDb ? await getRunnerState() : { idx: 0, lastTick: null, lastSymbol: "AAPL" };

  const universe = await getUniverse();
  const symbols = universeSymbols(universe);

  const nextIdx = ((state.idx || 0) + 1) % symbols.length;
  const nextSymbol = symbols[nextIdx] || "—";

  res.json({
    enabled,
    intervalSec,
    scanBatch,
    tradeTop,
    lockId,
    market,
    state,
    nextSymbol,
    universe,
    newsOnlyWhenClosed: NEWS_ONLY_WHEN_CLOSED ? "YES" : "NO",
  });
});

// -----------------------------
// API: Portfolios, Events, Trades
// -----------------------------
app.get("/api/portfolios", async (req, res) => {
  try {
    if (!hasDb) return res.json({ items: [] });
    const p = await dbQuery(`SELECT bot, cash, goal, updated_at FROM portfolios ORDER BY bot ASC`);
    res.json({ items: p.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/events/recent", async (req, res) => {
  try {
    if (!hasDb) return res.json({ items: [] });
    const limit = Math.min(300, Math.max(1, Number(req.query.limit || 120)));
    const afterId = Number(req.query.afterId || 0);
    const r = await dbQuery(
      `
      SELECT id, ts, type, payload
      FROM events
      WHERE id > $1
      ORDER BY id ASC
      LIMIT $2
    `,
      [afterId, limit]
    );
    res.json({ items: r.rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/trades/recent", async (req, res) => {
  try {
    if (!hasDb) return res.json({ items: [] });
    const limit = Math.min(Number(req.query.limit || 25), 500);
    const r = await dbQuery(
      `SELECT id, ts, bot, strategy, symbol, side, qty, price, rationale, confidence, horizon, features
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

app.get("/api/trades/bot/:bot", async (req, res) => {
  try {
    if (!hasDb) return res.json({ items: [] });
    const bot = String(req.params.bot || "");
    const limit = Math.min(Number(req.query.limit || 200), 2000);

    const r = await dbQuery(
      `SELECT id, ts, bot, strategy, symbol, side, qty, price, rationale, confidence, horizon, features
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

app.post("/api/universe", async (req, res) => {
  const mode = String(req.body?.mode || "any").toLowerCase();
  const custom = Array.isArray(req.body?.custom) ? req.body.custom : [];
  const u = { mode, custom };
  if (hasDb) await setSetting("universe", u);
  res.json({ ok: true, universe: u });
});

app.post("/api/learning/speed", async (req, res) => {
  const mode = String(req.body?.mode || "realtime").toLowerCase();
  const evalAfterSec = Number(req.body?.evalAfterSec || (mode === "accelerated" ? 60 : 3600));
  const v = { mode, evalAfterSec };
  if (hasDb) await setSetting("learning_speed", v);
  res.json({ ok: true, learning_speed: v });
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
      const accuracy = evaluated ? Math.round((correct / evaluated) * 1000) / 10 : null;

      if (!byStrategy[strategy]) byStrategy[strategy] = [];
      byStrategy[strategy].push({ day, evaluated, correct, accuracy });
    }

    const series = Object.entries(byStrategy).map(([strategy, points]) => ({
      strategy,
      points,
    }));

    res.json({ days, series });
  } catch (e) {
    res.status(500).json({ error: e.message, series: [] });
  }
});

// -----------------------------
// Arena v2: General News (non-finance) + Impact mapping
// -----------------------------
app.get("/api/news/general", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 8), 1), 12);
    const pack = await getGeneralNews(limit);

    const items = (pack.items || []).map((a) => {
      const impact = inferImpactedTickers(a);
      return {
        ...a,
        impact: {
          tickers: impact.tickers,
          why: impact.why,
          horizon: impact.horizon,
          confidence: impact.confidence,
          ruleHits: impact.ruleHits,
        },
      };
    });

    res.json({ provider: pack.provider, items });
  } catch (e) {
    res.status(500).json({ error: e.message, provider: "error", items: [] });
  }
});

// -----------------------------
// Arena v2: Market Pulse (reference basket prices)
// -----------------------------
app.get("/api/market/pulse", async (req, res) => {
  try {
    const market = isMarketOpen();

    let symbols = null;
    if (req.query.symbols) {
      symbols = String(req.query.symbols)
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 15);
    }

    if (!symbols || !symbols.length) {
      const universe = await getUniverse();
      symbols = universeSymbols(universe).slice(0, 10);
    }

    const results = await Promise.all(
      symbols.map(async (sym) => {
        const q = await getStockPrice(sym);
        return {
          symbol: q.symbol,
          price: q.price,
          changePercent: q.changePercent || 0,
          provider: q.provider,
        };
      })
    );

    res.json({ market, items: results });
  } catch (e) {
    res.status(500).json({ error: e.message, items: [] });
  }
});

// -----------------------------
// Core bot endpoint (used by War Room + runner)
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
      hasDb ? getSetting("learning_speed") : Promise.resolve(null),
    ]);

    const avgSent =
      newsPack.items && newsPack.items.length
        ? newsPack.items
            .map((a) => sentimentScore(`${a.title} ${a.summary || ""}`))
            .reduce((a, b) => a + b, 0) / newsPack.items.length
        : 0;

    const features = {
      price: q.price,
      changePercent: q.changePercent || 0,
      avgSent,
      marketOpen: market.open,
      priceProvider: q.provider,
      newsProvider: newsPack.provider,
    };

    const bots = [];
    for (const b of BOTS) {
      const base = baseDecision(b.strategy, features);
      const adjusted = await applyLearningAdjust(
        b.strategy,
        { signal: base.signal, confidence: base.confidence },
        features
      );
      bots.push({
        strategy: b.strategy,
        label: b.label,
        horizon: b.horizon,
        signal: adjusted.signal,
        rationale: base.why,
        baseConfidence: base.confidence,
        confidence: adjusted.confidence,
        learnedP: adjusted.learnedP,
      });
    }

    const winner = bots.reduce((a, b) => (b.confidence > a.confidence ? b : a), bots[0]);

    res.json({
      symbol,
      market,
      tradesAllowed,
      logged: bots.length,
      logError: null,
      features,
      bots,
      winner: winner.strategy,
      news: newsPack,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------
// Runner loop
// -----------------------------
async function ensurePortfolios() {
  if (!hasDb) return;
  for (const b of BOTS) {
    await dbQuery(
      `
      INSERT INTO portfolios(bot, cash, goal)
      VALUES ($1,$2,$3)
      ON CONFLICT (bot) DO NOTHING
    `,
      [b.strategy, START_CASH, GOAL_CASH]
    );
  }
}

async function evaluateLearningSamples() {
  if (!hasDb) return 0;

  const ls = (await getSetting("learning_speed")) || { mode: "realtime", evalAfterSec: 3600 };
  const evalAfterSec = Number(ls.evalAfterSec || 3600);

  const r = await dbQuery(
    `
    SELECT id, strategy, features, price_at_signal, created_at
    FROM learning_samples
    WHERE evaluated_at IS NULL
    ORDER BY created_at ASC
    LIMIT 50
  `
  );

  let evaluated = 0;

  for (const row of r.rows || []) {
    const created = new Date(row.created_at).getTime();
    const ageSec = (Date.now() - created) / 1000;
    if (ageSec < evalAfterSec) continue;

    const priceAfter = Number(row.price_at_signal) * (1 + (Math.random() - 0.5) * 0.01);
    const outcomePct =
      ((priceAfter - Number(row.price_at_signal)) / Number(row.price_at_signal)) * 100;
    const correct = outcomePct >= 0;

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

  if (evaluated > 0) {
    await emitEvent("learning_evaluated", { evaluated });
  }
  return evaluated;
}

async function runnerTick() {
  if (!hasDb) return;

  const market = isMarketOpen();
  const tradesAllowed = market.open;

  const universe = await getUniverse();
  const symbols = universeSymbols(universe);
  if (!symbols.length) return;

  const ls = (await getSetting("learning_speed")) || { mode: "realtime", evalAfterSec: 3600 };
  const evalAfterSec = Number(ls.evalAfterSec || 3600);

  const state = await getRunnerState();
  const idx = Number(state.idx || 0);
  const symbol = symbols[idx % symbols.length];

  await setRunnerState({
    idx: (idx + 1) % symbols.length,
    lastTick: new Date().toISOString(),
    lastSymbol: symbol,
  });

  await emitEvent("carousel_tick", { symbol, market });

  const q = await getStockPrice(symbol);
  const newsPack = await getNews(symbol, 8);

  const avgSent =
    newsPack.items && newsPack.items.length
      ? newsPack.items
          .map((a) => sentimentScore(`${a.title} ${a.summary || ""}`))
          .reduce((a, b) => a + b, 0) / newsPack.items.length
      : 0;

  const features = {
    price: q.price,
    changePercent: q.changePercent || 0,
    avgSent,
    marketOpen: market.open,
    priceProvider: q.provider,
    newsProvider: newsPack.provider,
  };

  const bots = [];
  for (const b of BOTS) {
    const base = baseDecision(b.strategy, features);
    const adjusted = await applyLearningAdjust(
      b.strategy,
      { signal: base.signal, confidence: base.confidence },
      features
    );
    bots.push({
      strategy: b.strategy,
      label: b.label,
      horizon: b.horizon,
      signal: adjusted.signal,
      rationale: base.why,
      baseConfidence: base.confidence,
      confidence: adjusted.confidence,
      learnedP: adjusted.learnedP,
    });
  }

  const winner = bots.sort((a, b) => b.confidence - a.confidence).slice(0, RUNNER_TRADE_TOP)[0];

  // log learning samples for all bots
  let logged = 0;
  let logError = null;
  if (hasDb) {
    try {
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

  // Execute ONE trade by winner (if allowed).
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
              strategy: bot,
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
          const pos = await dbQuery(`SELECT qty FROM positions WHERE bot=$1 AND symbol=$2`, [
            bot,
            symbol,
          ]);
          const held = pos.rows[0] ? Number(pos.rows[0].qty) : 0;
          const qty = Math.floor(held * 0.25 * 1000) / 1000;

          if (qty > 0) {
            executedTrade = await recordTrade({
              bot,
              strategy: bot,
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
            strategy: bot,
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
        executedTrade = await recordTrade({
          bot,
          strategy: bot,
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
        logged,
        logError,
      });
    } catch (e) {
      await emitEvent("runner_error", { symbol, error: e.message || String(e) });
    }
  }
}

async function runnerLoop() {
  if (!hasDb) return;
  await ensurePortfolios();
  await emitEvent("server_booted", { ok: true });

  setInterval(async () => {
    try {
      await runnerTick();
      await evaluateLearningSamples();
      await emitEvent("runner_state", await getRunnerState());
    } catch (e) {
      await emitEvent("runner_error", { error: e.message || String(e) });
    }
  }, RUNNER_INTERVAL_SEC * 1000);
}

if (RUNNER_ENABLED) {
  runnerLoop().catch(() => {});
}
