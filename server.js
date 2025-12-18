// server.js (ESM)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import http from "http";
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
const RUNNER_SCAN_BATCH = Number(process.env.RUNNER_SCAN_BATCH || 1);
const RUNNER_TRADE_TOP = Number(process.env.RUNNER_TRADE_TOP || 1);
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
    price: Math.round((100 + Math.random() * 400) * 100) / 100,
    changePercent: 0,
  };
}

// -----------------------------
// Symbol News: NewsData -> NewsAPI -> Mock
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

  return {
    provider: "mock",
    items: [
      {
        title: `${s} news placeholder`,
        url: "#",
        source: "mock",
        publishedAt: new Date().toISOString(),
        summary: "Configure a news provider to enable real headlines.",
      },
    ],
  };
}

// -----------------------------
// General (non stock-market) news stream (keeps UI alive)
// -----------------------------
const FALLBACK_GENERAL_NEWS = [
  {
    title:
      "City rolls out ‘green wave’ traffic lights to reduce congestion and emissions",
    url: "#",
    source: "fallback",
    publishedAt: new Date().toISOString(),
    summary:
      "A major city deploys synchronized smart traffic signals and connected intersection upgrades across key corridors.",
  },
  {
    title:
      "Airline industry warns of new maintenance bottlenecks amid supply chain disruption",
    url: "#",
    source: "fallback",
    publishedAt: new Date().toISOString(),
    summary:
      "Parts availability and repair capacity constraints could affect flight schedules and operating costs.",
  },
  {
    title:
      "Hospitals expand AI-assisted scheduling to reduce waiting times and staffing gaps",
    url: "#",
    source: "fallback",
    publishedAt: new Date().toISOString(),
    summary:
      "A healthcare network deploys new optimization software for workforce planning and patient flow.",
  },
];

async function getGeneralNews(limit = 10) {
  const q =
    "(traffic OR infrastructure OR regulation OR energy OR healthcare OR retail OR airline OR automotive OR semiconductors OR technology OR manufacturing) " +
    "-stock -stocks -shares -earnings -nasdaq -nyse -dow -s&p -sp500 -investor -ipo";

  if (NEWSDATA_KEY) {
    try {
      const r = await fetch(
        `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(
          NEWSDATA_KEY
        )}&q=${encodeURIComponent(q)}&language=en`,
        { timeout: 15000 }
      );
      const parsed = await safeJson(r);
      if (
        parsed.ok &&
        Array.isArray(parsed.json?.results) &&
        parsed.json.results.length
      ) {
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
          q
        )}&language=en&pageSize=${limit}&sortBy=publishedAt`,
        { timeout: 15000, headers: { "X-Api-Key": NEWSAPI_KEY } }
      );
      const parsed = await safeJson(r);
      if (
        parsed.ok &&
        Array.isArray(parsed.json?.articles) &&
        parsed.json.articles.length
      ) {
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

  return {
    provider: "fallback",
    items: FALLBACK_GENERAL_NEWS.slice(
      0,
      Math.max(1, Math.min(limit, FALLBACK_GENERAL_NEWS.length))
    ),
  };
}

// -----------------------------
// Article -> impacted stocks (Evidence Drawer)
// -----------------------------
const IMPACT_MAP = [
  {
    bucket: "Smart traffic signals / Green wave / V2X infrastructure",
    keywords: [
      "traffic light",
      "green wave",
      "green band",
      "traffic signal",
      "smart intersection",
      "signal timing",
      "adaptive signal",
      "v2x",
      "v2i",
      "vehicle-to-infrastructure",
      "connected roadways",
      "smart city traffic",
      "intersection upgrades",
    ],
    candidates: [
      {
        ticker: "SIEGY",
        company: "Siemens AG (ADR)",
        direction: "benefit",
        why: "Traffic control platforms & signal coordination deployments.",
      },
      {
        ticker: "IBM",
        company: "IBM",
        direction: "benefit",
        why: "Smart city analytics + traffic management integration.",
      },
      {
        ticker: "CSCO",
        company: "Cisco",
        direction: "benefit",
        why: "Networking backbone for connected intersections & telemetry.",
      },
      {
        ticker: "QCOM",
        company: "Qualcomm",
        direction: "benefit",
        why: "Connectivity enabling V2X/V2I communications.",
      },
    ],
  },
];

function extractMatchedKeywords(text, keywordList) {
  const t = (text || "").toLowerCase();
  const hits = [];
  for (const k of keywordList) {
    if (t.includes(String(k).toLowerCase())) hits.push(k);
  }
  return hits;
}

function heuristicImpact(title, summary) {
  const text = `${title || ""} ${summary || ""}`.trim();
  const out = [];
  const evidence = {
    provider: "heuristic",
    matchedBuckets: [],
    matchedKeywords: [],
    matchedByBucket: [],
  };

  for (const rule of IMPACT_MAP) {
    const hits = extractMatchedKeywords(text, rule.keywords);
    if (hits.length) {
      evidence.matchedBuckets.push(rule.bucket);
      evidence.matchedKeywords.push(...hits);
      evidence.matchedByBucket.push({ bucket: rule.bucket, keywords: hits });

      for (const c of rule.candidates) {
        out.push({
          ticker: c.ticker,
          company: c.company,
          direction: c.direction,
          horizon: "medium",
          confidence: 62,
          why: `${c.why} (${rule.bucket})`,
        });
      }
    }
  }

  evidence.matchedKeywords = Array.from(new Set(evidence.matchedKeywords));
  const seen = new Set();
  const items = out.filter((x) =>
    seen.has(x.ticker) ? false : (seen.add(x.ticker), true)
  );
  return { items, evidence };
}

async function analyzeArticleImpactWithEvidence({ title, summary }) {
  const heuristic = heuristicImpact(title, summary);
  if (!OPENAI_KEY) return { items: heuristic.items, evidence: heuristic.evidence };

  try {
    const prompt = `
Given a general news article (not stock-market news), identify up to 6 US-traded public tickers likely to be impacted.
Return STRICT JSON:
{
  "items":[
    {"ticker":"", "company":"", "direction":"benefit|risk|mixed", "horizon":"short|medium|long", "confidence":0-100, "why":"1 short causal line"}
  ],
  "evidence":{"keywords":["..."], "notes":"short justification"}
}
Article title: ${String(title || "")}
Article summary: ${String(summary || "")}
`;
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
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
    });

    const parsed = await safeJson(r);
    const content = parsed.json?.choices?.[0]?.message?.content || "{}";
    const ai = JSON.parse(content);

    if (ai?.items && Array.isArray(ai.items) && ai.items.length) {
      const items = ai.items
        .slice(0, 6)
        .map((x) => ({
          ticker: String(x.ticker || "").toUpperCase().trim(),
          company: String(x.company || "").trim(),
          direction: ["benefit", "risk", "mixed"].includes(x.direction)
            ? x.direction
            : "mixed",
          horizon: ["short", "medium", "long"].includes(x.horizon)
            ? x.horizon
            : "medium",
          confidence: Number.isFinite(Number(x.confidence))
            ? Math.max(0, Math.min(100, Number(x.confidence)))
            : 55,
          why: String(x.why || "").slice(0, 220),
        }))
        .filter((x) => x.ticker);

      return {
        items,
        evidence: {
          provider: "openai",
          aiEvidence: {
            keywords: Array.isArray(ai?.evidence?.keywords)
              ? ai.evidence.keywords.slice(0, 30)
              : [],
            notes: String(ai?.evidence?.notes || "").slice(0, 260),
          },
          heuristicEvidence: heuristic.evidence,
        },
      };
    }
  } catch {}

  return { items: heuristic.items, evidence: heuristic.evidence };
}

// -----------------------------
// WebSocket (ESM-safe)  ✅ FIXED
// -----------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const wsClients = new Set();
wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
});

function wsBroadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wsClients) {
    try {
      ws.send(msg);
    } catch {}
  }
}

// -----------------------------
// Existing API routes (from your original file)
// -----------------------------
app.get("/api/health", async (req, res) => {
  const market = isMarketOpen();
  res.json({
    ok: true,
    apis: {
      finnhub: !!FINNHUB_KEY,
      twelvedata: !!TWELVEDATA_KEY,
      newsData: !!NEWSDATA_KEY,
      newsApi: !!NEWSAPI_KEY,
      openai: !!OPENAI_KEY,
      postgres: !!hasDb,
    },
    market: { ...market, tz: MARKET_TZ },
  });
});

app.get("/api/version", (req, res) => {
  res.json({ version: "server-esm", ts: new Date().toISOString() });
});

// learning speed settings
app.get("/api/settings/learning-speed", async (req, res) => {
  try {
    const v = await getSetting("learning_speed");
    res.json(v || { mode: "realtime", evalAfterSec: 3600 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/settings/learning-speed", async (req, res) => {
  try {
    await setSetting("learning_speed", req.body || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// universe settings
app.get("/api/settings/universe", async (req, res) => {
  try {
    const v = await getSetting("universe");
    res.json(v || { mode: "default", custom: [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/settings/universe", async (req, res) => {
  try {
    await setSetting("universe", req.body || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/runner/status", async (req, res) => {
  try {
    const state = await getRunnerState();
    const market = isMarketOpen();
    res.json({
      enabled: RUNNER_ENABLED,
      intervalSec: RUNNER_INTERVAL_SEC,
      scanBatch: RUNNER_SCAN_BATCH,
      tradeTop: RUNNER_TRADE_TOP,
      lockId: RUNNER_LOCK_ID,
      market,
      state,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// price history (existing)
app.get("/api/price/history", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").toUpperCase();
    const limit = Math.min(Math.max(Number(req.query.limit || 60), 10), 500);
    const rows = await dbQuery(
      `SELECT ts, price FROM price_history WHERE symbol=$1 ORDER BY ts DESC LIMIT $2`,
      [symbol, limit]
    );
    res.json({ items: rows.rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// symbol news (existing)
app.get("/api/news/:symbol", async (req, res) => {
  try {
    const v = isValidTicker(req.params.symbol);
    if (!v.ok) return res.status(400).json({ error: v.reason });
    const pack = await getNews(v.symbol, 8);
    res.json(pack);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ general news (new)
app.get("/api/news/general", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 30);
    const pack = await getGeneralNews(limit);
    res.json(pack);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ article -> impacted tickers (new)
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

// existing explain route (kept)
app.post("/api/news/explain", async (req, res) => {
  try {
    res.json({
      ok: true,
      note: "Use /api/news/impact for multi-ticker impact + evidence.",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// market overview (existing)
app.get("/api/market-overview", async (req, res) => {
  try {
    const market = isMarketOpen();
    res.json({ market });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// trades / portfolios / learning / bots (existing)
app.get("/api/trades/recent", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 25), 5), 200);
    const rows = await dbQuery(
      `SELECT id, ts, bot, symbol, side, qty, price, rationale, confidence, horizon
       FROM trades ORDER BY ts DESC LIMIT $1`,
      [limit]
    );
    res.json({ items: rows.rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/trades/bot/:bot", async (req, res) => {
  try {
    const bot = String(req.params.bot || "");
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 5), 500);
    const rows = await dbQuery(
      `SELECT id, ts, bot, symbol, side, qty, price, rationale, confidence, horizon, features
       FROM trades WHERE bot=$1 ORDER BY ts DESC LIMIT $2`,
      [bot, limit]
    );
    res.json({ items: rows.rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/portfolios", async (req, res) => {
  try {
    const rows = await dbQuery(
      `SELECT bot, cash, goal, updated_at FROM portfolios ORDER BY bot ASC`
    );
    res.json({ items: rows.rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/learning/impact", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days || 14), 3), 60);
    const rows = await dbQuery(
      `
      SELECT date_trunc('day', COALESCE(evaluated_at, created_at)) AS day, strategy,
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
    for (const row of rows.rows || []) {
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

app.get("/api/bots/:symbol", async (req, res) => {
  try {
    const v = isValidTicker(req.params.symbol);
    if (!v.ok) return res.status(400).json({ error: v.reason });

    // Minimal safe response (kept exactly as in your file)
    const symbol = v.symbol;
    const market = isMarketOpen();
    const q = await getStockPrice(symbol);
    const pack = await getNews(symbol, 8);

    res.json({
      symbol,
      market,
      price: q.price,
      provider: q.provider,
      news: pack,
      note: "Bot engine implementation lives in your existing codebase.",
    });
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
  } catch {}

  server.listen(PORT, () => {
    console.log(`Server listening on :${PORT}`);
  });
})();
