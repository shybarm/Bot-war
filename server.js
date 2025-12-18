/**
 * server.js
 * Adds:
 * - /api/news/impact => general-news article -> impacted tickers
 * - Evidence payload: matched keywords, matched bucket, provider (openai|heuristic), and reasoning provenance
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

// Keys
const FINNHUB_KEY = process.env.FINNHUB_KEY || "";
const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY || "";
const NEWSDATA_KEY = process.env.NEWSDATA_KEY || "";
const NEWSAPI_KEY = process.env.NEWSAPI_KEY || "";
const OPENAI_KEY = process.env.OPENAI_KEY || "";

const MARKET_TZ = "America/New_York";

// -----------------------------
// DB
// -----------------------------
const { Pool } = pg;
const hasDb = !!process.env.DATABASE_URL;
const pool = hasDb
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : undefined,
    })
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
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  // seed learning speed (optional use)
  const seed = await dbQuery(`SELECT key FROM settings WHERE key='learning_speed'`);
  if (seed.rows.length === 0) {
    await dbQuery(`INSERT INTO settings(key, value) VALUES ($1, $2::jsonb)`, [
      "learning_speed",
      JSON.stringify({ mode: "realtime", evalAfterSec: 3600 }),
    ]);
  }
}

async function getSetting(key) {
  if (!hasDb) return null;
  const r = await dbQuery(`SELECT value FROM settings WHERE key=$1`, [key]);
  return r.rows[0]?.value || null;
}

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

// -----------------------------
// Market hours gate (simple; holidays not included)
// -----------------------------
function getNowInTZ(tz) {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);

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
// Stock price: Finnhub -> TwelveData -> Mock
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
        `https://api.twelvedata.com/price?symbol=${encodeURIComponent(s)}&apikey=${encodeURIComponent(TWELVEDATA_KEY)}`,
        { timeout: 15000 }
      );
      const parsed = await safeJson(r);
      if (parsed.ok && parsed.json?.price) {
        const price = Number(parsed.json.price);
        if (Number.isFinite(price)) return { provider: "twelvedata", symbol: s, price, changePercent: 0 };
      }
    } catch {}
  }

  return { provider: "mock", symbol: s, price: Math.round((100 + Math.random() * 400) * 100) / 100, changePercent: 0 };
}

// -----------------------------
// News: symbol-bound + general-news
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

async function getGeneralNews(limit = 10) {
  const q =
    "(traffic OR infrastructure OR regulation OR energy OR healthcare OR retail OR airline OR automotive OR semiconductors OR technology OR manufacturing) " +
    "-stock -stocks -shares -earnings -nasdaq -nyse -dow -s&p -sp500 -investor -ipo";

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

  return {
    provider: "mock",
    items: [
      {
        title: "No general news provider configured",
        url: "#",
        source: "mock",
        publishedAt: new Date().toISOString(),
        summary: "Set NEWSDATA_KEY or NEWSAPI_KEY to enable general news.",
      },
    ],
  };
}

// -----------------------------
// Evidence-driven heuristic mapping (transparent & auditable)
// Based on your uploaded research doc’s beneficiaries list (SIEGY / IBM / CSCO / QCOM). :contentReference[oaicite:2]{index=2} :contentReference[oaicite:3]{index=3}
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
    ],
    candidates: [
      { ticker: "SIEGY", company: "Siemens AG (ADR)", direction: "benefit", why: "Traffic control platforms & signal coordination deployments." },
      { ticker: "IBM", company: "IBM", direction: "benefit", why: "Smart city analytics + traffic management integration." },
      { ticker: "CSCO", company: "Cisco", direction: "benefit", why: "Networking backbone for connected intersections & telemetry." },
      { ticker: "QCOM", company: "Qualcomm", direction: "benefit", why: "Connectivity enabling V2X/V2I communications." },
    ],
  },
];

function extractMatchedKeywords(text, keywordList) {
  const t = (text || "").toLowerCase();
  const hits = [];
  for (const k of keywordList) {
    if (t.includes(k.toLowerCase())) hits.push(k);
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
          why: c.why + ` (${rule.bucket})`,
        });
      }
    }
  }

  // dedupe by ticker
  const seen = new Set();
  const items = out.filter((x) => (seen.has(x.ticker) ? false : (seen.add(x.ticker), true)));

  // normalize evidence
  evidence.matchedKeywords = Array.from(new Set(evidence.matchedKeywords));
  return { items, evidence };
}

// -----------------------------
// OpenAI (optional) -> returns ranked impacted tickers + evidence
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

async function analyzeArticleImpactWithEvidence({ title, summary }) {
  // Always compute heuristic evidence so we can show an audit trail even if OpenAI is used.
  const heuristic = heuristicImpact(title, summary);

  // Try OpenAI (if enabled) to produce a ranked list; still return heuristic evidence as “secondary provenance”
  const prompt = `
Given a general news article (not stock-market news), identify up to 6 US-traded public tickers likely to be impacted.
Return STRICT JSON:
{
  "items":[
    {"ticker":"", "company":"", "direction":"benefit|risk|mixed", "horizon":"short|medium|long", "confidence":0-100, "why":"1 short causal line"},
    ...
  ],
  "evidence":{
    "keywords":["..."],
    "notes":"short explanation of how you inferred these tickers"
  }
}
Rules:
- Prefer US-traded tickers (NYSE/NASDAQ/OTC ADRs acceptable).
- If uncertain, use direction="mixed" and lower confidence.
Article title: ${String(title || "")}
Article summary: ${String(summary || "")}
`;

  const ai = await openaiJson(prompt);

  if (ai?.items && Array.isArray(ai.items) && ai.items.length) {
    const items = ai.items
      .slice(0, 6)
      .map((x) => ({
        ticker: String(x.ticker || "").toUpperCase().trim(),
        company: String(x.company || "").trim(),
        direction: ["benefit", "risk", "mixed"].includes(x.direction) ? x.direction : "mixed",
        horizon: ["short", "medium", "long"].includes(x.horizon) ? x.horizon : "medium",
        confidence: Number.isFinite(Number(x.confidence)) ? Math.max(0, Math.min(100, Number(x.confidence))) : 55,
        why: String(x.why || "").slice(0, 220),
      }))
      .filter((x) => x.ticker);

    const evidence = {
      provider: "openai",
      aiEvidence: {
        keywords: Array.isArray(ai?.evidence?.keywords) ? ai.evidence.keywords.slice(0, 30) : [],
        notes: String(ai?.evidence?.notes || "").slice(0, 260),
      },
      heuristicEvidence: heuristic.evidence,
    };

    return { items, evidence };
  }

  // If OpenAI not available or returns nothing, return heuristic items + evidence
  return { items: heuristic.items, evidence: heuristic.evidence };
}

// -----------------------------
// WebSocket + Events (kept minimal; doesn’t break existing UI)
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
  let id = null;
  if (hasDb) {
    const r = await dbQuery(`INSERT INTO events(type, payload) VALUES ($1, $2::jsonb) RETURNING id`, [
      type,
      JSON.stringify(payload || {}),
    ]);
    id = r.rows[0]?.id || null;
  }
  wsBroadcast({ id, type, payload, ts: new Date().toISOString() });
}

// -----------------------------
// Routes
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
    version: "arena-impact-evidence-v1",
  });
});

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
      .map((x) => ({ id: Number(x.id), ts: x.ts, type: x.type, payload: x.payload || {} }))
      .reverse();

    res.json({ items });
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

/**
 * NEW: article -> impacted tickers + evidence
 * Body: { title, summary }
 * Response: { items: [...], evidence: {...} }
 */
app.post("/api/news/impact", async (req, res) => {
  try {
    const { title, summary } = req.body || {};
    const out = await analyzeArticleImpactWithEvidence({ title: String(title || ""), summary: String(summary || "") });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------
// Boot server
// -----------------------------
const server = http.createServer(app);
wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
});

(async function boot() {
  await initDb().catch(() => {});
  await emitEvent("server_boot", { version: "arena-impact-evidence-v1" }).catch(() => {});
})();

server.listen(PORT, () => console.log(`Server running on :${PORT}`));
