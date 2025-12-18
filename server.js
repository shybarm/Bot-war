// server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));

// Static
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// -----------------------------
// ENV (robust mapping)
// -----------------------------
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || process.env.FINNHUB_KEY || "";
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY || process.env.TWELVEDATA_KEY || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API || "";

// News providers (you have: NEWS_API_KEY + NEWSAPI_BACKUP_KEY)
const NEWSDATA_KEY = process.env.NEWSDATA_KEY || process.env.NEWS_API_KEY || "";
const NEWSAPI_KEY = process.env.NEWSAPI_KEY || process.env.NEWSAPI_BACKUP_KEY || "";

const MARKET_TZ = process.env.MARKET_TZ || "America/New_York";
const NEWS_ONLY_WHEN_CLOSED = String(process.env.MARKET_NEWS_ONLY_WHEN_CLOSED || "true").toLowerCase() === "true";

const RUNNER_ENABLED = String(process.env.RUNNER_ENABLED || "true").toLowerCase() === "true";
const RUNNER_INTERVAL_SEC = Math.max(Number(process.env.RUNNER_INTERVAL_SEC || 5), 3);
const RUNNER_SCAN_BATCH = Math.max(Number(process.env.RUNNER_SCAN_BATCH || 40), 5);
const RUNNER_TRADE_TOP = Math.max(Number(process.env.RUNNER_TRADE_TOP || 3), 1);

const RUNNER_LOCK_ID = String(process.env.RUNNER_LOCK_ID || "default-lock");

// Symbols parsing (AUTO_SYMBOLS can be JSON array or CSV)
function parseSymbolsEnv(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  if (!s) return [];
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
    } catch {}
  }
  return s.split(/[\n, ]+/).map((x) => x.trim()).filter(Boolean);
}

const AUTO_SYMBOLS = parseSymbolsEnv(process.env.AUTO_SYMBOLS);

// Fallback universe
const SP500_MINI = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","BRK.B","JPM","V",
  "UNH","XOM","LLY","PG","AVGO","KO","PEP","COST","WMT","HD",
  "NFLX","DIS","INTC","AMD","BA","GE","NKE","ORCL","CRM","ADBE",
];

// -----------------------------
// Market hours gate (simple)
// -----------------------------
function isMarketOpen() {
  // Lightweight approximation; your runner status shows OPEN already.
  // If you want a strict NYSE calendar later, we can upgrade.
  const now = new Date();
  const utc = now.getTime();
  const est = new Date(utc);

  const day = est.getUTCDay(); // not perfect but acceptable for gating vs closed
  if (day === 0 || day === 6) return { open: false, reason: "Weekend" };

  // Allow “open” for now (your status already says OPEN).
  return { open: true, reason: "Open" };
}

function isValidTicker(sym) {
  const s = String(sym || "").trim().toUpperCase();
  if (!/^[A-Z.\-]{1,10}$/.test(s)) return { ok: false, reason: "Invalid ticker" };
  return { ok: true, symbol: s };
}

// -----------------------------
// Simple sentiment heuristic
// -----------------------------
function sentimentScore(text) {
  const t = String(text || "").toLowerCase();
  const pos = ["beat","surge","win","record","growth","strong","approve","partnership","launch"];
  const neg = ["miss","drop","lawsuit","recall","strike","ban","fraud","crash","weak","delay","probe"];
  let score = 0;
  for (const w of pos) if (t.includes(w)) score += 1;
  for (const w of neg) if (t.includes(w)) score -= 1;
  return Math.max(-1, Math.min(1, score / 6));
}

// -----------------------------
// Price fetch with failover
// -----------------------------
async function getStockPrice(symbol) {
  // Finnhub
  if (FINNHUB_KEY) {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(FINNHUB_KEY)}`);
      if (r.ok) {
        const j = await r.json();
        const price = Number(j.c || 0);
        const prev = Number(j.pc || 0);
        const changePercent = prev ? ((price - prev) / prev) * 100 : 0;
        if (price > 0) return { price, changePercent, provider: "finnhub" };
      }
    } catch {}
  }

  // TwelveData backup
  if (TWELVEDATA_KEY) {
    try {
      const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(TWELVEDATA_KEY)}`);
      if (r.ok) {
        const j = await r.json();
        const price = Number(j.price || 0);
        if (price > 0) return { price, changePercent: 0, provider: "twelvedata" };
      }
    } catch {}
  }

  // Mock
  const base = 50 + Math.random() * 250;
  return { price: Math.round(base * 100) / 100, changePercent: (Math.random() - 0.5) * 2, provider: "mock" };
}

// -----------------------------
// News: symbol-specific (existing style)
// -----------------------------
async function getNews(symbol, limit = 8) {
  // If no keys → mock
  if (!NEWSDATA_KEY && !NEWSAPI_KEY) {
    return {
      provider: "mock",
      items: [
        {
          title: `No news key configured for ${symbol}`,
          summary: "Set NEWSDATA_KEY/NEWSAPI_KEY (or your NEWS_API_KEY/NEWSAPI_BACKUP_KEY) to enable real news.",
          url: "",
          publishedAt: new Date().toISOString(),
          source: "mock",
        },
      ],
    };
  }

  // Try NewsData first (if key provided via NEWS_API_KEY mapping)
  if (NEWSDATA_KEY) {
    try {
      const r = await fetch(
        `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(NEWSDATA_KEY)}&q=${encodeURIComponent(symbol)}&language=en&size=${Math.min(limit, 10)}`
      );
      if (r.ok) {
        const j = await r.json();
        const items = (j.results || []).map((x) => ({
          title: x.title || "",
          summary: x.description || x.content || "",
          url: x.link || "",
          publishedAt: x.pubDate || new Date().toISOString(),
          source: x.source_id || "newsdata",
        }));
        if (items.length) return { provider: "newsdata", items };
      }
    } catch {}
  }

  // NewsAPI backup
  if (NEWSAPI_KEY) {
    try {
      const r = await fetch(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(symbol)}&pageSize=${Math.min(limit, 10)}&language=en&sortBy=publishedAt`,
        { headers: { "X-Api-Key": NEWSAPI_KEY } }
      );
      if (r.ok) {
        const j = await r.json();
        const items = (j.articles || []).map((a) => ({
          title: a.title || "",
          summary: a.description || a.content || "",
          url: a.url || "",
          publishedAt: a.publishedAt || new Date().toISOString(),
          source: a.source?.name || "newsapi",
        }));
        if (items.length) return { provider: "newsapi", items };
      }
    } catch {}
  }

  return { provider: "error", items: [] };
}

// -----------------------------
// ✅ General news (non-finance oriented) – top headlines style
// -----------------------------
async function getGeneralNews(limit = 8) {
  if (!NEWSDATA_KEY && !NEWSAPI_KEY) {
    return {
      provider: "mock",
      items: [
        {
          title: "No general news provider configured",
          summary: "Configure NEWS_API_KEY / NEWSAPI_BACKUP_KEY to enable general news.",
          url: "",
          publishedAt: new Date().toISOString(),
          source: "mock",
        },
      ],
    };
  }

  // NewsAPI: Top headlines works best for “regular news”
  if (NEWSAPI_KEY) {
    try {
      const r = await fetch(
        `https://newsapi.org/v2/top-headlines?country=us&pageSize=${Math.min(limit, 20)}`,
        { headers: { "X-Api-Key": NEWSAPI_KEY } }
      );
      if (r.ok) {
        const j = await r.json();
        const items = (j.articles || []).map((a) => ({
          title: a.title || "",
          summary: a.description || a.content || "",
          url: a.url || "",
          publishedAt: a.publishedAt || new Date().toISOString(),
          source: a.source?.name || "newsapi",
        }));
        if (items.length) return { provider: "newsapi", items: items.slice(0, limit) };
      }
    } catch {}
  }

  // NewsData: broad query (US + trending-like)
  if (NEWSDATA_KEY) {
    try {
      const r = await fetch(
        `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(NEWSDATA_KEY)}&country=us&language=en&size=${Math.min(limit, 10)}`
      );
      if (r.ok) {
        const j = await r.json();
        const items = (j.results || []).map((x) => ({
          title: x.title || "",
          summary: x.description || x.content || "",
          url: x.link || "",
          publishedAt: x.pubDate || new Date().toISOString(),
          source: x.source_id || "newsdata",
        }));
        if (items.length) return { provider: "newsdata", items };
      }
    } catch {}
  }

  return { provider: "error", items: [] };
}

// -----------------------------
// ✅ Article → impacted tickers (OpenAI optional, heuristic fallback)
// -----------------------------
const IMPACT_TICKERS = {
  airlines: ["DAL", "UAL", "AAL", "LUV"],
  oil: ["XOM", "CVX", "OXY"],
  chips: ["NVDA", "AMD", "INTC", "AVGO"],
  cloud: ["MSFT", "AMZN", "GOOGL", "ORCL"],
  consumer: ["WMT", "COST", "PG", "KO", "PEP"],
  autos: ["TSLA", "GM", "F"],
  banks: ["JPM", "BAC", "WFC", "GS"],
  pharma: ["LLY", "PFE", "MRK", "JNJ"],
  retail: ["AMZN", "WMT", "TGT", "COST"],
  media: ["NFLX", "DIS", "PARA"],
};

function impactHeuristic(title, summary) {
  const text = `${title} ${summary}`.toLowerCase();
  const hits = [];
  const evidence = [];

  function add(bucket, why, conf) {
    const ticks = IMPACT_TICKERS[bucket] || [];
    for (const t of ticks) hits.push({ ticker: t, confidence: conf, rationale: why });
  }

  const rules = [
    { k: ["oil", "opec", "barrel", "crude", "refinery"], b: "oil", why: "Energy pricing risk / margin sensitivity", c: 76 },
    { k: ["chip", "semiconductor", "ai gpu", "foundry"], b: "chips", why: "Semis supply/demand and capex exposure", c: 74 },
    { k: ["cloud", "outage", "cyber", "breach"], b: "cloud", why: "Cloud reliability and security spending shift", c: 72 },
    { k: ["strike", "union", "labor"], b: "autos", why: "Production capacity / labor cost impact", c: 70 },
    { k: ["drug", "fda", "trial", "recall"], b: "pharma", why: "Regulatory + pipeline impact", c: 73 },
    { k: ["airline", "airport", "flight", "boeing"], b: "airlines", why: "Travel volume / fleet / disruption signal", c: 68 },
    { k: ["consumer", "inflation", "wage", "holiday"], b: "consumer", why: "Demand, pricing, and basket mix effects", c: 66 },
    { k: ["bank", "rates", "fed", "credit"], b: "banks", why: "Net interest margin / credit conditions", c: 67 },
    { k: ["streaming", "box office", "studio"], b: "media", why: "Media demand + monetization sensitivity", c: 65 },
    { k: ["retail", "ecommerce", "shipping"], b: "retail", why: "Retail volume and logistics cost sensitivity", c: 64 },
  ];

  for (const r of rules) {
    if (r.k.some((x) => text.includes(x))) {
      add(r.b, r.why, r.c);
      evidence.push(`Matched: ${r.k.find((x) => text.includes(x))}`);
    }
  }

  // De-dupe, keep top 8 by confidence
  const best = new Map();
  for (const h of hits) {
    const prev = best.get(h.ticker);
    if (!prev || h.confidence > prev.confidence) best.set(h.ticker, h);
  }

  const impacted = Array.from(best.values()).sort((a, b) => b.confidence - a.confidence).slice(0, 8);
  const horizon = impacted.length ? (impacted[0].confidence >= 73 ? "medium" : "short") : "short";

  return {
    horizon,
    confidence: impacted.length ? impacted[0].confidence : 55,
    impacted,
    evidence: evidence.slice(0, 6),
    mode: "heuristic",
  };
}

// Optional OpenAI (kept conservative; if it fails, heuristic wins)
async function impactWithOpenAI(title, summary) {
  if (!OPENAI_KEY) return null;
  try {
    const prompt = `
You are a market-impact analyst. Given a general news article (NOT finance news),
return JSON:
{
 "horizon": "short"|"medium"|"long",
 "confidence": 0-100,
 "impacted": [{"ticker":"AAPL","confidence":0-100,"rationale":"<=120 chars"}],
 "evidence": ["<=80 chars", "..."]
}
Rules:
- 3 to 8 tickers max.
- Focus on US-traded tickers.
- Avoid hallucinating. If unclear, be conservative.
Article:
TITLE: ${title}
SUMMARY: ${summary}
Return JSON only.
`.trim();

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      }),
    });

    if (!r.ok) return null;
    const j = await r.json();
    const content = j?.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(content);

    if (!parsed || !Array.isArray(parsed.impacted)) return null;
    return {
      horizon: ["short", "medium", "long"].includes(parsed.horizon) ? parsed.horizon : "short",
      confidence: Math.max(0, Math.min(100, Number(parsed.confidence || 60))),
      impacted: parsed.impacted
        .slice(0, 8)
        .map((x) => ({
          ticker: String(x.ticker || "").toUpperCase(),
          confidence: Math.max(0, Math.min(100, Number(x.confidence || 60))),
          rationale: String(x.rationale || "").slice(0, 140),
        }))
        .filter((x) => /^[A-Z.\-]{1,10}$/.test(x.ticker)),
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.slice(0, 8).map((x) => String(x).slice(0, 120)) : [],
      mode: "openai",
    };
  } catch {
    return null;
  }
}

async function analyzeArticleImpactWithEvidence({ title, summary }) {
  const cleanTitle = String(title || "").slice(0, 300);
  const cleanSummary = String(summary || "").slice(0, 1200);

  const ai = await impactWithOpenAI(cleanTitle, cleanSummary);
  if (ai && ai.impacted && ai.impacted.length) return ai;

  return impactHeuristic(cleanTitle, cleanSummary);
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

async function ensurePortfolios() {
  if (!hasDb) return;
  for (const b of BOTS) {
    await dbQuery(
      `
      INSERT INTO portfolios(bot, cash, goal, updated_at)
      VALUES ($1, 100000, 150000, NOW())
      ON CONFLICT (bot) DO NOTHING;
    `,
      [b.bot]
    );
  }
}

function decideBase({ bot, avgSent, changePercent }) {
  // Conservative base logic (learning adjusts later)
  let signal = "HOLD";
  let confidence = 52;
  let why = "No edge detected";

  if (bot === "day_trade") {
    if (Math.abs(changePercent) > 0.8) {
      signal = changePercent < 0 ? "BUY" : "SELL";
      confidence = 60;
      why = "Short-term volatility reaction";
    } else {
      why = "No volatility setup";
    }
  }

  if (bot === "market_swing") {
    if (changePercent < -1.2) {
      signal = "BUY";
      confidence = 58;
      why = "Dip-buying swing setup";
    } else if (changePercent > 1.2) {
      signal = "SELL";
      confidence = 58;
      why = "Rally fade swing setup";
    } else {
      why = "No swing setup";
    }
  }

  if (bot === "sp500_long") {
    if (avgSent > 0.15 && changePercent < 0) {
      signal = "BUY";
      confidence = 56;
      why = "Long-bias + positive narrative";
    } else {
      why = "No long-term edge detected";
    }
  }

  if (bot === "news_only") {
    if (avgSent > 0.25) {
      signal = "BUY";
      confidence = 56;
      why = "News sentiment suggests upside";
    } else if (avgSent < -0.25) {
      signal = "SELL";
      confidence = 56;
      why = "News sentiment suggests downside";
    } else {
      why = "News signal not strong enough";
    }
  }

  return { signal, confidence, why };
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

async function applyLearningAdjust(strategy, base, features) {
  if (!hasDb) {
    return { signal: base.signal, confidence: base.confidence, why: base.why, learnedP: 0.5 };
  }

  const w = await getWeights(strategy);
  const x =
    (w.bias || 0) +
    (w.avgSent || 0) * Number(features.avgSent || 0) +
    (w.changePercent || 0) * Number(features.changePercent || 0);

  const p = sigmoid(x); // “probability” of being correct
  let confidence = Math.max(40, Math.min(90, Math.round(base.confidence + (p - 0.5) * 40)));

  // Keep signal; nudge HOLD thresholds slightly
  let signal = base.signal;
  if (signal === "HOLD" && confidence >= 67) {
    // promote HOLD into action depending on direction
    if (features.avgSent > 0.2 || features.changePercent < -1.2) signal = "BUY";
    if (features.avgSent < -0.2 || features.changePercent > 1.2) signal = "SELL";
  }

  return { signal, confidence, why: base.why, learnedP: p };
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

  const pos = await dbQuery(`SELECT qty, avg_price FROM positions WHERE bot=$1 AND symbol=$2`, [bot, symbol]);
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

  const x =
    (w.bias || 0) +
    (w.avgSent || 0) * Number(features.avgSent || 0) +
    (w.changePercent || 0) * Number(features.changePercent || 0);

  const p = sigmoid(x);
  const err = y - p;

  const lr = 0.08; // stable
  const newBias = (w.bias || 0) + lr * err * 1;
  const newAvg = (w.avgSent || 0) + lr * err * Number(features.avgSent || 0);
  const newChg = (w.changePercent || 0) + lr * err * Number(features.changePercent || 0);

  await setWeight(strategy, "bias", newBias);
  await setWeight(strategy, "avgSent", newAvg);
  await setWeight(strategy, "changePercent", newChg);
}

async function evaluateLearningSamples() {
  if (!hasDb) return { evaluated: 0 };

  const r = await dbQuery(
    `
    SELECT id, strategy, symbol, signal, horizon, price_at_signal, features, created_at, eval_after_sec
    FROM learning_samples
    WHERE evaluated_at IS NULL
      AND created_at <= NOW() - (eval_after_sec || ' seconds')::interval
    ORDER BY created_at ASC
    LIMIT 50
  `
  );

  let evaluated = 0;
  for (const row of r.rows) {
    const symbol = row.symbol;
    const priceAt = Number(row.price_at_signal || 0);
    const spot = await getStockPrice(symbol);
    const priceAfter = Number(spot.price || 0);

    const outcomePct = priceAt ? ((priceAfter - priceAt) / priceAt) * 100 : 0;

    let correct = false;
    if (row.signal === "BUY") correct = outcomePct > 0;
    if (row.signal === "SELL") correct = outcomePct < 0;
    if (row.signal === "HOLD") correct = Math.abs(outcomePct) < 0.4;

    await dbQuery(
      `
      UPDATE learning_samples
      SET evaluated_at=NOW(),
          price_after=$2,
          outcome_pct=$3,
          correct=$4
      WHERE id=$1
    `,
      [row.id, priceAfter, outcomePct, correct]
    );

    await updateModelFromOutcome(row.strategy, row.features || {}, correct);
    evaluated += 1;
  }

  if (evaluated) {
    await emitEvent("learning_evaluated", { evaluated });
  }

  return { evaluated };
}

// -----------------------------
// Events → WS
// -----------------------------
const wss = new WebSocketServer({ server, path: "/ws" });

function wsBroadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

async function emitEvent(type, payload) {
  const now = new Date().toISOString();
  const obj = { type, ts: now, payload: payload || {} };

  // store to DB if possible
  if (hasDb) {
    try {
      const r = await dbQuery(
        `INSERT INTO events(type, payload) VALUES ($1, $2::jsonb) RETURNING id, ts`,
        [type, JSON.stringify(payload || {})]
      );
      obj.id = r.rows?.[0]?.id;
      obj.ts = r.rows?.[0]?.ts || now;
    } catch {}
  }

  wsBroadcast(obj);
}

// -----------------------------
// Universe
// -----------------------------
async function getUniverse() {
  const u = (hasDb ? await getSetting("universe") : null) || { mode: "any", custom: [] };
  return u;
}

function universeSymbols(universe) {
  const mode = String(universe?.mode || "any").toLowerCase();
  if (mode === "custom") {
    const c = Array.isArray(universe.custom) ? universe.custom : [];
    const clean = c.map((x) => String(x).trim().toUpperCase()).filter((x) => /^[A-Z.\-]{1,10}$/.test(x));
    if (clean.length) return clean;
  }
  if (AUTO_SYMBOLS.length) return AUTO_SYMBOLS.map((x) => x.toUpperCase());
  return SP500_MINI;
}

// -----------------------------
// Runner
// -----------------------------
let runnerTimer = null;

async function runnerTick() {
  if (!RUNNER_ENABLED) return;

  const market = isMarketOpen();
  const universe = await getUniverse();
  const symbols = universeSymbols(universe);

  const st = (hasDb ? await getRunnerState() : { idx: 0, lastTick: null, lastSymbol: symbols[0] }) || {
    idx: 0,
    lastTick: null,
    lastSymbol: symbols[0],
  };

  const idx = Number(st.idx || 0);
  const symbol = symbols[idx % symbols.length];

  const nextState = {
    idx: idx + 1,
    lastTick: new Date().toISOString(),
    lastSymbol: symbol,
  };

  if (hasDb) await setRunnerState(nextState);

  await emitEvent("runner_state", { state: nextState });
  await emitEvent("carousel_tick", { symbol, market });

  // Bot fight (always) to generate learning samples; trading gated by market open
  try {
    // call internal function directly via API logic:
    await botsFight(symbol);
  } catch (e) {
    await emitEvent("runner_error", { symbol, error: String(e?.message || e) });
  }

  // Evaluate learning periodically
  try {
    await evaluateLearningSamples();
  } catch {}
}

function startRunner() {
  if (runnerTimer) clearInterval(runnerTimer);
  if (!RUNNER_ENABLED) return;
  runnerTimer = setInterval(runnerTick, RUNNER_INTERVAL_SEC * 1000);
}

// -----------------------------
// Core bot fight
// -----------------------------
async function botsFight(symbol) {
  const symbolV = isValidTicker(symbol);
  if (!symbolV.ok) throw new Error(symbolV.reason);

  const s = symbolV.symbol;
  const market = isMarketOpen();

  const [q, newsPack, setting] = await Promise.all([
    getStockPrice(s),
    getNews(s, 8),
    hasDb ? getSetting("learning_speed") : Promise.resolve({ mode: "realtime", evalAfterSec: 3600 }),
  ]);

  const newsItems = (newsPack.items || []).map((x) => ({
    ...x,
    sentiment: sentimentScore(`${x.title} ${x.summary}`),
  }));

  const avgSent = newsItems.length ? newsItems.reduce((a, b) => a + (b.sentiment || 0), 0) / newsItems.length : 0;

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

  // Learning speed
  const evalAfterSec =
    setting?.mode === "accelerated"
      ? (Number(setting.evalAfterSec) > 0 ? Number(setting.evalAfterSec) : 30)
      : (Number(setting.evalAfterSec) > 0 ? Number(setting.evalAfterSec) : 3600);

  let logged = 0;
  let logError = null;

  if (hasDb) {
    try {
      await ensurePortfolios();
      for (const bot of bots) {
        const id = await logLearningSample({
          bot: bot.strategy,
          strategy: bot.strategy,
          symbol: s,
          signal: bot.signal,
          horizon: bot.horizon,
          priceAtSignal: q.price,
          features,
          rationale: bot.rationale,
          confidence: bot.confidence,
          evalAfterSec,
        });
        if (id) logged += 1;
      }
    } catch (e) {
      logError = String(e?.message || e);
    }
  }

  // Trades allowed?
  const tradesAllowed = market.open && !(NEWS_ONLY_WHEN_CLOSED && !market.open);

  // Execute trades for top N signals (excluding HOLD), unless market closed
  if (hasDb && tradesAllowed) {
    const actionable = bots.filter((b) => b.signal !== "HOLD").sort((a, b) => b.confidence - a.confidence).slice(0, RUNNER_TRADE_TOP);
    for (const b of actionable) {
      const qty = 5; // small conservative size (can be upgraded later)
      const trade = await recordTrade({
        bot: b.strategy,
        symbol: s,
        side: b.signal,
        qty,
        price: q.price,
        rationale: b.rationale,
        confidence: b.confidence,
        horizon: b.horizon,
        features,
      });
      if (trade) {
        await applyTradeToPortfolio({ bot: b.strategy, symbol: s, side: b.signal, qty, price: q.price });
        await emitEvent("trade_recorded", trade);
      }
    }
  }

  const payload = {
    symbol: s,
    market,
    tradesAllowed,
    logged,
    logError,
    features,
    bots,
    winner: winner?.strategy,
  };

  await emitEvent("bot_fight", payload);
  return payload;
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
    version: "arena-v4-fix-trades-news-impact",
  });
});

app.get("/api/version", (req, res) => {
  res.json({ version: "arena-v4-fix-trades-news-impact", timestamp: new Date().toISOString() });
});

// Learning speed
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

// Universe
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
      mode: ["any", "sp500", "custom"].includes(m) ? m : "any",
      custom: Array.isArray(custom) ? custom : [],
    };
    if (hasDb) await setSetting("universe", payload);
    res.json({ ok: true, universe: payload });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Runner status
app.get("/api/runner/status", async (req, res) => {
  try {
    const m = isMarketOpen();
    const universe = await getUniverse();
    const st = hasDb ? await getRunnerState() : { idx: 0, lastTick: null, lastSymbol: "AAPL" };

    const symbols = universeSymbols(universe);
    const nextSymbol = symbols[Number(st.idx || 0) % symbols.length];

    res.json({
      enabled: RUNNER_ENABLED,
      intervalSec: RUNNER_INTERVAL_SEC,
      scanBatch: RUNNER_SCAN_BATCH,
      tradeTop: RUNNER_TRADE_TOP,
      lockId: RUNNER_LOCK_ID,
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

// Market overview: prices list (what your UI expects)
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

// Recent trades (✅ fixed by db migration adding ts)
app.get("/api/trades/recent", async (req, res) => {
  try {
    if (!hasDb) return res.json({ items: [] });
    const limit = Math.min(Math.max(Number(req.query.limit || 25), 5), 500);
    const r = await dbQuery(
      `SELECT id, ts, bot, symbol, side, qty, price, rationale, confidence, horizon, features
       FROM trades
       ORDER BY ts DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ items: r.rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trades by bot
app.get("/api/trades/bot/:bot", async (req, res) => {
  try {
    if (!hasDb) return res.json({ items: [] });
    const bot = String(req.params.bot || "");
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 5), 2000);

    const r = await dbQuery(
      `SELECT id, ts, bot, symbol, side, qty, price, rationale, confidence, horizon, features
       FROM trades
       WHERE bot=$1
       ORDER BY ts DESC
       LIMIT $2`,
      [bot, limit]
    );
    res.json({ items: r.rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Portfolios
app.get("/api/portfolios", async (req, res) => {
  try {
    if (!hasDb) return res.json({ items: [] });
    const p = await dbQuery(`SELECT bot, cash, goal, updated_at FROM portfolios ORDER BY bot ASC`);
    res.json({ items: p.rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Learning impact
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
    for (const row of r.rows || []) {
      const day = new Date(row.day).toISOString().slice(0, 10);
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

// Events recent (War Room hydration)
app.get("/api/events/recent", async (req, res) => {
  try {
    if (!hasDb) return res.json({ items: [] });
    const limit = Math.min(Math.max(Number(req.query.limit || 160), 20), 500);
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

// Symbol news
app.get("/api/news/:symbol", async (req, res) => {
  try {
    const v = isValidTicker(req.params.symbol);
    if (!v.ok) return res.status(400).json({ error: v.reason });
    const pack = await getNews(v.symbol, 8);
    const items = (pack.items || []).map((x) => ({ ...x, sentiment: sentimentScore(`${x.title} ${x.summary}`) }));
    const avgSent = items.length ? items.reduce((a, b) => a + (b.sentiment || 0), 0) / items.length : 0;
    res.json({ symbol: v.symbol, provider: pack.provider, avgSent, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ General news
app.get("/api/news/general", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 8), 1), 20);
    const pack = await getGeneralNews(limit);
    res.json(pack);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ Impact mapping (multi-ticker)
app.post("/api/news/impact", async (req, res) => {
  try {
    const { title, summary } = req.body || {};
    const out = await analyzeArticleImpactWithEvidence({
      title: String(title || ""),
      summary: String(summary || ""),
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bots endpoint (supports your /api/bots/KO test)
app.get("/api/bots/:symbol", async (req, res) => {
  try {
    const v = isValidTicker(req.params.symbol);
    if (!v.ok) return res.status(400).json({ error: v.reason });
    const out = await botsFight(v.symbol);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------
// Boot
// -----------------------------
(async function boot() {
  try {
    await dbInit();
    if (hasDb) await ensurePortfolios();
  } catch {}

  await emitEvent("server_booted", { version: "arena-v4-fix-trades-news-impact" });

  startRunner();

  server.listen(PORT, () => {
    console.log(`Server listening on :${PORT}`);
  });
})();
