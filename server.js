// server.js (ESM)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";

import {
  dbInit,
  hasDb,
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
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ----------------------
// WebSocket setup
// ----------------------
const wss = new WebSocketServer({ noServer: true });
const wsClients = new Set();

function wsSendAll(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

async function emitEvent(type, payload = {}) {
  const event = {
    ts: new Date().toISOString(),
    type,
    payload,
  };

  // persist (best-effort)
  if (hasDb) {
    try {
      const r = await dbQuery(
        `INSERT INTO events(type, payload) VALUES ($1, $2::jsonb) RETURNING id, ts`,
        [type, JSON.stringify(payload || {})]
      );
      if (r.rows?.[0]) {
        event.id = r.rows[0].id;
        event.ts = r.rows[0].ts;
      }
    } catch (e) {
      // never crash on event persistence
      console.error("emitEvent persist error:", e.message);
    }
  }

  wsSendAll(event);
  return event;
}

// ----------------------
// Helpers
// ----------------------
function nowISO() {
  return new Date().toISOString();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function parseBool(v, fallback = false) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

function parseIntSafe(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function marketHoursGate() {
  // Minimal gate used by current codebase; keep as-is
  // (You already have MARKET_TZ support in your runner status)
  return { open: true, reason: "Open" };
}

// ----------------------
// Model (simple online logistic regression scoring)
// ----------------------
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function modelScore(weights, features) {
  const x =
    (weights.bias || 0) +
    (weights.avgSent || 0) * (features.avgSent || 0) +
    (weights.changePercent || 0) * (features.changePercent || 0);

  const p = sigmoid(x);
  return { p, x };
}

async function adjustDecisionWithLearning(strategy, base, features) {
  if (!hasDb) return { ...base, learnedP: null };

  const w = await getWeights(strategy);
  const { p } = modelScore(w, features);

  // Convert p into +/- confidence adjustment around 50
  const delta = Math.round((p - 0.5) * 30); // -15..+15 typical
  const confidence = clamp(base.confidence + delta, 1, 99);

  // Optional: if learned p is strongly negative, discourage BUY, etc
  let signal = base.signal;
  if (base.signal === "BUY" && p < 0.35) signal = "HOLD";
  if (base.signal === "SELL" && p > 0.65) signal = "HOLD";

  return { ...base, signal, confidence, learnedP: p };
}

// ----------------------
// ✅ FIXED: recordTrade MUST write strategy and never pass NULL
// ----------------------
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
  // Guarantees schema-safe inserts across legacy DB versions.
  if (!hasDb) return null;

  const b = bot ?? strategy ?? "unknown";
  const s = strategy ?? bot ?? "unknown";

  const r = await dbQuery(
    `
    INSERT INTO trades(bot, strategy, symbol, side, qty, price, rationale, confidence, horizon, features)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    RETURNING *
  `,
    [
      b,
      s,
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

// ----------------------
// Portfolio application (keep behavior as-is)
// ----------------------
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
    curQty -= sellQty;
    if (curQty === 0) avgPrice = 0;
  }

  await dbQuery(`UPDATE portfolios SET cash=$1, updated_at=NOW() WHERE bot=$2`, [
    cash,
    bot,
  ]);

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

// ----------------------
// API: health
// ----------------------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    ts: nowISO(),
    postgres: !!hasDb,
  });
});

// ----------------------
// API: runner status (kept compatible with your UI)
// ----------------------
app.get("/api/runner/status", async (req, res) => {
  const enabled = parseBool(process.env.RUNNER_ENABLED, true);
  const intervalSec = parseIntSafe(process.env.RUNNER_INTERVAL_SEC, 5);
  const scanBatch = parseIntSafe(process.env.RUNNER_SCAN_BATCH, 40);
  const tradeTop = parseIntSafe(process.env.RUNNER_TRADE_TOP, 3);
  const lockId = process.env.RUNNER_LOCK_ID || "default-lock";

  const market = marketHoursGate();
  const state = hasDb ? await getRunnerState() : { idx: 0, lastSymbol: "AAPL" };

  const newsOnlyWhenClosed = parseBool(process.env.MARKET_NEWS_ONLY_WHEN_CLOSED, true);
  const universe = (await getSetting("universe")) || { mode: "any", custom: [] };

  res.json({
    enabled,
    intervalSec,
    scanBatch,
    tradeTop,
    lockId,
    market,
    newsOnlyWhenClosed: newsOnlyWhenClosed ? "YES" : "NO",
    universe: universe?.mode || "any",
    state,
  });
});

// ----------------------
// API: bots by symbol (existing behavior)
// ----------------------
app.get("/api/bots/:symbol", async (req, res) => {
  const symbol = String(req.params.symbol || "").toUpperCase().trim();
  const market = marketHoursGate();

  // minimal placeholder so your UI keeps working
  // (your existing code already populates this; keep endpoint shape stable)
  const features = {
    avgSent: 0,
    changePercent: 0,
    price: 0,
    priceProvider: "unknown",
    newsProvider: "unknown",
    marketOpen: market.open,
  };

  // Basic strategy outputs (kept compatible)
  const bots = [
    { strategy: "sp500_long", label: "S&P500 Long", signal: "HOLD", horizon: "long", rationale: "No long-term edge detected", baseConfidence: 54, confidence: 54 },
    { strategy: "market_swing", label: "Market Swing", signal: "HOLD", horizon: "medium", rationale: "No swing setup", baseConfidence: 53, confidence: 53 },
    { strategy: "day_trade", label: "Day Trade", signal: "BUY", horizon: "short", rationale: "Short-term volatility reaction", baseConfidence: 60, confidence: 60 },
    { strategy: "news_only", label: "News-Only", signal: "HOLD", horizon: "short", rationale: "News signal not strong enough", baseConfidence: 54, confidence: 54 },
  ];

  // Apply learning adjustment if DB is enabled
  if (hasDb) {
    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];
      const adj = await adjustDecisionWithLearning(b.strategy, { signal: b.signal, confidence: b.baseConfidence }, features);
      bots[i] = { ...b, signal: adj.signal, confidence: adj.confidence, learnedP: adj.learnedP };
    }
  }

  // Winner = max confidence
  const winner = bots.reduce((a, b) => (b.confidence > a.confidence ? b : a), bots[0]);

  res.json({
    symbol,
    market,
    tradesAllowed: market.open,
    logged: bots.length,
    logError: null,
    features,
    bots,
    winner: winner.strategy,
  });
});

// ----------------------
// API: trades recent (must never error)
// ----------------------
app.get("/api/trades/recent", async (req, res) => {
  if (!hasDb) return res.json({ items: [] });

  const limit = clamp(parseIntSafe(req.query.limit, 50), 1, 200);

  try {
    const r = await dbQuery(
      `
      SELECT id, ts, bot, strategy, symbol, side, qty, price, rationale, confidence, horizon
      FROM trades
      ORDER BY ts DESC
      LIMIT $1
    `,
      [limit]
    );

    res.json({ items: r.rows || [] });
  } catch (e) {
    res.status(200).json({ items: [], error: e.message });
  }
});

// ----------------------
// Boot + HTTP upgrade for WS
// ----------------------
import http from "http";
const server = http.createServer(app);

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wsClients.add(ws);
      ws.on("close", () => wsClients.delete(ws));
      ws.send(JSON.stringify({ type: "ws_connected", ts: nowISO(), payload: {} }));
    });
  } else {
    socket.destroy();
  }
});

async function boot() {
  try {
    await dbInit();
    await emitEvent("server_booted", { ok: true });
  } catch (e) {
    console.error("Boot error:", e);
    try {
      await emitEvent("server_booted", { ok: false, error: String(e?.message || e) });
    } catch {}
  }

  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`Server listening on ${port}`);
  });
}

boot();
