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

const NEWSDATA_KEY = process.env.NEWS_API_KEY || ""; // newsdata.io primary
const NEWSAPI_KEY = process.env.NEWSAPI_BACKUP_KEY || ""; // newsapi.org backup

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

// AUTO_SYMBOLS (comma-separated tickers)
function parseAutoSymbols() {
  const raw = String(process.env.AUTO_SYMBOLS || "").trim();
  if (!raw) return null;
  const arr = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return arr.length ? arr : null;
}

const DEFAULT_UNIVERSE = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA",
  "JPM", "XOM", "UNH", "KO", "PEP", "WMT", "BA", "INTC"
];

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
  return { weekday: get("weekday"), hour: Number(get("hour")), minute: Number(get("minute")) };
}

function isMarketOpen() {
  const { weekday, hour, minute } = getNowInTZ(MARKET_TZ);
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  if (!isWeekday) return { open: false, reason: "Weekend", tz: MARKET_TZ };

  const mins = hour * 60 + minute;
  const openMins = 9 * 60 + 30;
  const closeMins = 16 * 60;

  if (mins < openMins) return { open: false, reason: "Pre-market", tz: MARKET_TZ };
  if (mins >= closeMins) return { open: false, reason: "After-hours", tz: MARKET_TZ };
  return { open: true, reason: "Open", tz: MARKET_TZ };
}

function isValidTicker(raw) {
  const s = String(raw || "").toUpperCase().trim();
  if (!s) return { ok: false, reason: "Missing symbol" };
  if (!/^[A-Z.\-]{1,10}$/.test(s)) return { ok: false, reason: "Invalid ticker format" };
  return { ok: true, symbol: s };
}

async function getUniverseConfig() {
  // from DB setting + AUTO_SYMBOLS override
  const auto = parseAutoSymbols();
  if (auto) return { mode: "auto", custom: auto };

  const u = (await getSetting("universe")) || { mode: "any", custom: [] };
  if (u.mode === "custom" && Array.isArray(u.custom) && u.custom.length) return u;
  return { mode: "any", custom: [] };
}

async function getUniverseSymbols() {
  const u = await getUniverseConfig();
  if (u.mode === "custom" && Array.isArray(u.custom) && u.custom.length) return u.custom;
  if (u.mode === "auto" && Array.isArray(u.custom) && u.custom.length) return u.custom;
  return DEFAULT_UNIVERSE;
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
        return { provider: "finnhub", symbol: s, price: Number(parsed.json.c), changePercent: Number(parsed.json.dp ?? 0) };
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
// WebSocket (FIXED PATH: /ws)
// -----------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const wsClients = new Set();
wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
});

function wsBroadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wsClients) {
    try { ws.send(msg); } catch {}
  }
}

async function emitEvent(type, payload) {
  const ts = new Date().toISOString();
  let id = null;

  if (hasDb) {
    const r = await dbQuery(
      `INSERT INTO events(type, payload) VALUES ($1, $2::jsonb) RETURNING id`,
      [type, JSON.stringify(payload || {})]
    );
    id = Number(r.rows?.[0]?.id || 0) || null;
  }

  wsBroadcast({ id, type, payload, ts });
}

// -----------------------------
// API
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
    market,
  });
});

app.get("/api/version", (req, res) => {
  res.json({ version: "arena-server", ts: new Date().toISOString() });
});

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

app.get("/api/settings/universe", async (req, res) => {
  try {
    const v = await getSetting("universe");
    res.json(v || { mode: "any", custom: [] });
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

/**
 * ✅ FIXED: runner/status now returns what war-room.js expects:
 * - newsOnlyWhenClosed
 * - universe (config object)
 * - nextSymbol
 * - state includes lastSymbol (compat)
 */
app.get("/api/runner/status", async (req, res) => {
  try {
    const state = await getRunnerState(); // {idx,lastTick,lastSymbol}
    const market = isMarketOpen();
    const universe = await getUniverseConfig();
    const symbols = await getUniverseSymbols();

    const idx = Number(state?.idx || 0) % symbols.length;
    const nextSymbol = symbols[(idx + 1) % symbols.length];

    res.json({
      enabled: RUNNER_ENABLED,
      intervalSec: RUNNER_INTERVAL_SEC,
      scanBatch: RUNNER_SCAN_BATCH,
      tradeTop: RUNNER_TRADE_TOP,
      lockId: RUNNER_LOCK_ID,
      market,
      newsOnlyWhenClosed: NEWS_ONLY_WHEN_CLOSED,
      universe,
      nextSymbol,
      state: {
        ...state,
        lastSymbol: state?.lastSymbol || state?.last_symbol || null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// war-room.js uses these
app.get("/api/portfolios", async (req, res) => {
  try {
    const r = await dbQuery(`SELECT bot, cash, goal, updated_at FROM portfolios ORDER BY bot ASC`);
    res.json({ items: r.rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/trades/recent", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 25), 5), 200);
    const r = await dbQuery(
      `SELECT id, ts, bot, symbol, side, qty, price, rationale, confidence, horizon
       FROM trades ORDER BY ts DESC LIMIT $1`,
      [limit]
    );
    res.json({ items: r.rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ war-room.js backfills events on refresh
app.get("/api/events/recent", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 160), 10), 500);
    const afterId = Number(req.query.afterId || 0);

    const r = await dbQuery(
      `SELECT id, ts, type, payload
       FROM events
       WHERE id > $2
       ORDER BY id ASC
       LIMIT $1`,
      [limit, afterId]
    );

    res.json({
      items: (r.rows || []).map((x) => ({
        id: Number(x.id),
        ts: x.ts,
        type: x.type,
        payload: x.payload || {},
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// minimal bots endpoint (kept safe)
app.get("/api/bots/:symbol", async (req, res) => {
  try {
    const v = isValidTicker(req.params.symbol);
    if (!v.ok) return res.status(400).json({ error: v.reason });

    const symbol = v.symbol;
    const market = isMarketOpen();
    const q = await getStockPrice(symbol);

    res.json({
      symbol,
      market,
      price: q.price,
      provider: q.provider,
      note: "Bot engine is handled by your existing runner pipeline.",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------
// Lightweight event emitter (mirrors runner_state so WS stream is alive)
// -----------------------------
let lastIdx = null;
let lastSymbol = null;

async function pulseRunnerEvents() {
  if (!hasDb) return;
  try {
    const st = await getRunnerState();
    const idx = Number(st?.idx || 0);
    const sym = st?.lastSymbol || st?.last_symbol || null;

    if (idx !== lastIdx || sym !== lastSymbol) {
      lastIdx = idx;
      lastSymbol = sym;

      await emitEvent("carousel_tick", { symbol: sym, idx });
      await emitEvent("runner_state", { state: st });
    }
  } catch {}
}

// -----------------------------
// Boot
// -----------------------------
(async function boot() {
  try { await dbInit(); } catch {}

  // emit boot event (helps war-room show activity)
  try { await emitEvent("server_boot", { ts: new Date().toISOString() }); } catch {}

  // keep WS alive with runner-state pulses
  setInterval(() => pulseRunnerEvents().catch(() => {}), 2000);

  server.listen(PORT, () => {
    console.log(`Server listening on :${PORT}`);
  });
})();
