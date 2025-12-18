import pg from "pg";
const { Pool } = pg;

let pool = null;

export function hasDb() {
  return !!process.env.DATABASE_URL;
}

export function getPool() {
  if (!hasDb()) return null;
  if (pool) return pool;

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });

  return pool;
}

export async function initDb() {
  const p = getPool();
  if (!p) {
    console.log("⚠️ DATABASE_URL not set — running without persistent DB");
    return;
  }

  // Bots bankroll
  await p.query(`
    CREATE TABLE IF NOT EXISTS bot_accounts (
      strategy TEXT PRIMARY KEY,
      cash DOUBLE PRECISION NOT NULL DEFAULT 100000,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Positions
  await p.query(`
    CREATE TABLE IF NOT EXISTS bot_positions (
      id BIGSERIAL PRIMARY KEY,
      strategy TEXT NOT NULL,
      symbol TEXT NOT NULL,
      qty DOUBLE PRECISION NOT NULL DEFAULT 0,
      avg_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(strategy, symbol)
    );
  `);

  // Trades ledger
  await p.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      strategy TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL, -- BUY | SELL
      qty DOUBLE PRECISION NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      note TEXT NOT NULL DEFAULT ''
    );
  `);

  await p.query(`CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol, created_at DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy, created_at DESC);`);

  // Learning events (impact over time)
  await p.query(`
    CREATE TABLE IF NOT EXISTS learning_events (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      symbol TEXT NOT NULL,
      strategy TEXT NOT NULL DEFAULT 'global',
      signal TEXT NOT NULL,     -- BUY | SELL | HOLD
      horizon TEXT NOT NULL DEFAULT 'medium',
      price_at_signal DOUBLE PRECISION NOT NULL,
      price_after DOUBLE PRECISION NOT NULL,
      outcome_pct DOUBLE PRECISION NOT NULL
    );
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_learning_events_symbol_created
    ON learning_events(symbol, created_at DESC);
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_learning_events_strategy_created
    ON learning_events(strategy, created_at DESC);
  `);

  // Ensure 4 bots exist
  const bots = ["sp500_long", "market_swing", "day_trade", "news_only"];
  for (const b of bots) {
    await p.query(
      `INSERT INTO bot_accounts(strategy, cash) VALUES ($1, 100000)
       ON CONFLICT(strategy) DO NOTHING;`,
      [b]
    );
  }

  console.log("✅ DB ready (bot_accounts, bot_positions, trades, learning_events)");
}

// ---- Accounts / Positions / Trades ----

export async function getBotAccounts() {
  const p = getPool();
  if (!p) return [
    { strategy: "sp500_long", cash: 100000 },
    { strategy: "market_swing", cash: 100000 },
    { strategy: "day_trade", cash: 100000 },
    { strategy: "news_only", cash: 100000 }
  ];

  const r = await p.query(`SELECT strategy, cash FROM bot_accounts ORDER BY strategy ASC;`);
  return r.rows;
}

export async function getBotPositions(strategy) {
  const p = getPool();
  if (!p) return [];
  const r = await p.query(
    `SELECT symbol, qty, avg_cost FROM bot_positions WHERE strategy=$1 ORDER BY symbol ASC;`,
    [strategy]
  );
  return r.rows.map(x => ({ symbol: x.symbol, qty: Number(x.qty), avgCost: Number(x.avg_cost) }));
}

async function updateCash(p, strategy, delta) {
  await p.query(
    `UPDATE bot_accounts SET cash = cash + $2, updated_at=NOW() WHERE strategy=$1;`,
    [strategy, delta]
  );
}

async function upsertPosition(p, strategy, symbol, qtyDelta, price) {
  const existing = await p.query(
    `SELECT qty, avg_cost FROM bot_positions WHERE strategy=$1 AND symbol=$2;`,
    [strategy, symbol]
  );

  if (existing.rows.length === 0) {
    const newQty = qtyDelta;
    const avgCost = qtyDelta > 0 ? price : 0;
    await p.query(
      `INSERT INTO bot_positions(strategy, symbol, qty, avg_cost, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT(strategy, symbol) DO UPDATE SET qty=EXCLUDED.qty, avg_cost=EXCLUDED.avg_cost, updated_at=NOW();`,
      [strategy, symbol, newQty, avgCost]
    );
    return;
  }

  const { qty, avg_cost } = existing.rows[0];
  const curQty = Number(qty);
  const curAvg = Number(avg_cost);

  const newQty = curQty + qtyDelta;

  // If buying more, adjust avg cost; if selling, keep avg cost unless fully closed.
  let newAvg = curAvg;
  if (qtyDelta > 0) {
    const totalCost = curQty * curAvg + qtyDelta * price;
    newAvg = totalCost / Math.max(newQty, 1e-9);
  }
  if (newQty <= 1e-9) {
    newAvg = 0;
  }

  await p.query(
    `UPDATE bot_positions SET qty=$3, avg_cost=$4, updated_at=NOW()
     WHERE strategy=$1 AND symbol=$2;`,
    [strategy, symbol, newQty, newAvg]
  );
}

export async function recordTrade({ strategy, symbol, side, qty, price, note }) {
  const p = getPool();
  if (!p) return null;

  const s = String(side).toUpperCase();
  if (s !== "BUY" && s !== "SELL") throw new Error("Invalid trade side");

  // BUY reduces cash; SELL increases cash
  const cashDelta = s === "BUY" ? -(qty * price) : +(qty * price);
  const qtyDelta = s === "BUY" ? +qty : -qty;

  await p.query("BEGIN");
  try {
    await p.query(
      `INSERT INTO trades(strategy, symbol, side, qty, price, note)
       VALUES ($1,$2,$3,$4,$5,$6);`,
      [strategy, symbol, s, qty, price, note || ""]
    );

    await updateCash(p, strategy, cashDelta);
    await upsertPosition(p, strategy, symbol, qtyDelta, price);

    await p.query("COMMIT");
  } catch (e) {
    await p.query("ROLLBACK");
    throw e;
  }

  return true;
}

export async function getRecentTrades({ limit = 50 } = {}) {
  const p = getPool();
  if (!p) return [];
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  const r = await p.query(
    `SELECT created_at, strategy, symbol, side, qty, price, note
     FROM trades
     ORDER BY created_at DESC
     LIMIT ${lim};`
  );

  return r.rows.map(x => ({
    time: x.created_at,
    strategy: x.strategy,
    symbol: x.symbol,
    side: x.side,
    qty: Number(x.qty),
    price: Number(x.price),
    note: x.note || ""
  }));
}

// ---- Learning (impact over time) ----

export async function insertLearningEvent({
  symbol,
  strategy = "global",
  signal,
  horizon = "medium",
  priceAtSignal,
  priceAfter,
}) {
  const p = getPool();
  if (!p) return null;

  const outcomePct = ((priceAfter - priceAtSignal) / priceAtSignal) * 100;

  const result = await p.query(
    `
    INSERT INTO learning_events
      (symbol, strategy, signal, horizon, price_at_signal, price_after, outcome_pct)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *;
    `,
    [symbol, strategy, signal, horizon, priceAtSignal, priceAfter, outcomePct]
  );

  return result.rows[0];
}

export async function getHistoricalPatterns(symbol, limit = 50) {
  const p = getPool();
  if (!p) return [];
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));

  const result = await p.query(
    `
    SELECT signal, outcome_pct, created_at
    FROM learning_events
    WHERE symbol = $1
    ORDER BY created_at DESC
    LIMIT $2;
    `,
    [symbol, lim]
  );

  return result.rows.map((r) => ({
    signal: r.signal,
    outcome: Number(r.outcome_pct),
    timestamp: new Date(r.created_at).getTime(),
  }));
}

export function calculateAccuracyFromPatterns(arr) {
  if (!arr || arr.length === 0) return "0.0";
  const correct = arr.filter((p) => {
    if (p.signal === "BUY") return p.outcome > 0;
    if (p.signal === "SELL") return p.outcome < 0;
    return Math.abs(p.outcome) < 2;
  }).length;
  return ((correct / arr.length) * 100).toFixed(1);
}

export async function getLearningImpact({ symbol, strategy = null, bucket = "hour", limit = 72 }) {
  const p = getPool();
  if (!p) return { buckets: [], cumulative: [] };

  const safeBucket = bucket === "day" ? "day" : "hour";
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 72));

  const params = [symbol];
  let where = `WHERE symbol = $1`;

  if (strategy) {
    params.push(strategy);
    where += ` AND strategy = $${params.length}`;
  }

  const q = `
    SELECT
      date_trunc('${safeBucket}', created_at) AS bucket_ts,
      COUNT(*)::int AS total,
      AVG(outcome_pct)::double precision AS avg_outcome,
      SUM(
        CASE
          WHEN signal = 'BUY'  AND outcome_pct > 0 THEN 1
          WHEN signal = 'SELL' AND outcome_pct < 0 THEN 1
          WHEN signal = 'HOLD' AND ABS(outcome_pct) < 2 THEN 1
          ELSE 0
        END
      )::int AS correct
    FROM learning_events
    ${where}
    GROUP BY bucket_ts
    ORDER BY bucket_ts DESC
    LIMIT ${safeLimit};
  `;

  const result = await p.query(q, params);
  const rows = result.rows.reverse();

  const buckets = rows.map((r) => {
    const total = r.total || 0;
    const correct = r.correct || 0;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;
    return {
      t: new Date(r.bucket_ts).getTime(),
      total,
      correct,
      accuracy: Number(accuracy.toFixed(2)),
      avgOutcomePct: Number((r.avg_outcome ?? 0).toFixed(3)),
    };
  });

  let cumTotal = 0;
  let cumCorrect = 0;
  const cumulative = buckets.map((b) => {
    cumTotal += b.total;
    cumCorrect += b.correct;
    const acc = cumTotal > 0 ? (cumCorrect / cumTotal) * 100 : 0;
    return {
      t: b.t,
      cumulativeTotal: cumTotal,
      cumulativeCorrect: cumCorrect,
      cumulativeAccuracy: Number(acc.toFixed(2)),
    };
  });

  return { buckets, cumulative };
}
