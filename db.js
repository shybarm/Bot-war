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
    // Railway Postgres typically needs SSL in production containers
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

  // Learning events (persistent outcomes)
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

  console.log("✅ Database initialized (tables ready)");
}

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

  const result = await p.query(
    `
    SELECT signal, outcome_pct, created_at
    FROM learning_events
    WHERE symbol = $1
    ORDER BY created_at DESC
    LIMIT $2;
    `,
    [symbol, limit]
  );

  return result.rows.map((r) => ({
    signal: r.signal,
    outcome: r.outcome_pct,
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

  return (correct / arr.length * 100).toFixed(1);
}
