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

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_learning_events_strategy_created
    ON learning_events(strategy, created_at DESC);
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
    // HOLD: consider "correct" if it didn't move much
    return Math.abs(p.outcome) < 2;
  }).length;

  return ((correct / arr.length) * 100).toFixed(1);
}

/**
 * Learning impact buckets over time:
 * - bucket: 'hour' or 'day'
 * - limit: number of buckets (e.g. 72 hours)
 * - strategy: optional filter
 */
export async function getLearningImpact({ symbol, strategy = null, bucket = "hour", limit = 72 }) {
  const p = getPool();
  if (!p) return { buckets: [], cumulative: [] };

  const safeBucket = bucket === "day" ? "day" : "hour";
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Number(limit))) : 72;

  // Compute correctness in SQL to keep it fast.
  // BUY correct if outcome_pct > 0
  // SELL correct if outcome_pct < 0
  // HOLD correct if abs(outcome_pct) < 2
  const params = [symbol];
  let where = `WHERE symbol = $1`;

  if (strategy) {
    params.push(strategy);
    where += ` AND strategy = $${params.length}`;
  }

  // We pick recent buckets by time window using LIMIT after grouping.
  // This yields sparse buckets only where events exist (which is what we want for MVP).
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

  // Reverse to chronological
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

  // Cumulative rolling accuracy
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
