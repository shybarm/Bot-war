import pg from "pg";
const { Pool } = pg;

let pool = null;

export function hasDb() {
  return !!process.env.DATABASE_URL;
}

function getPool() {
  if (!hasDb()) return null;
  if (pool) return pool;

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 7000,
    idleTimeoutMillis: 30000,
    max: 5,
  });

  return pool;
}

export async function initDb() {
  const p = getPool();
  if (!p) {
    console.log("⚠️ DATABASE_URL not set — running WITHOUT DB (still works)");
    return;
  }

  await p.query("SELECT 1;");

  // Stores evaluated learning outcomes used for accuracy
  await p.query(`
    CREATE TABLE IF NOT EXISTS learning_events (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      symbol TEXT NOT NULL,
      strategy TEXT NOT NULL,
      horizon TEXT NOT NULL,
      signal TEXT NOT NULL,
      price_at_signal DOUBLE PRECISION NOT NULL,
      price_after DOUBLE PRECISION NOT NULL,
      outcome_pct DOUBLE PRECISION NOT NULL
    );
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_learning_symbol_strategy_horizon_created
    ON learning_events(symbol, strategy, horizon, created_at DESC);
  `);

  // Stores bot decisions before evaluation
  await p.query(`
    CREATE TABLE IF NOT EXISTS bot_decisions (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      symbol TEXT NOT NULL,
      strategy TEXT NOT NULL,
      horizon TEXT NOT NULL,
      signal TEXT NOT NULL,
      price_at_signal DOUBLE PRECISION NOT NULL,

      eval_after_sec INTEGER NOT NULL,
      due_at TIMESTAMPTZ NOT NULL,

      evaluated_at TIMESTAMPTZ,
      price_after DOUBLE PRECISION,
      outcome_pct DOUBLE PRECISION
    );
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_bot_decisions_due
    ON bot_decisions(due_at)
    WHERE evaluated_at IS NULL;
  `);

  console.log("✅ DB ready (tables: learning_events, bot_decisions)");
}

export async function insertLearningEvent({ symbol, strategy, horizon, signal, priceAtSignal, priceAfter }) {
  const p = getPool();
  if (!p) return null;

  const outcomePct = ((priceAfter - priceAtSignal) / priceAtSignal) * 100;

  const r = await p.query(
    `
    INSERT INTO learning_events
      (symbol, strategy, horizon, signal, price_at_signal, price_after, outcome_pct)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *;
    `,
    [symbol, strategy, horizon, signal, priceAtSignal, priceAfter, outcomePct]
  );

  return r.rows[0];
}

export async function getStrategyAccuracy({ symbol, strategy, horizon, limit = 50 }) {
  const p = getPool();
  if (!p) return { samples: 0, accuracy: 0 };

  const r = await p.query(
    `
    SELECT signal, outcome_pct
    FROM learning_events
    WHERE symbol=$1 AND strategy=$2 AND horizon=$3
    ORDER BY created_at DESC
    LIMIT $4;
    `,
    [symbol, strategy, horizon, limit]
  );

  const rows = r.rows;
  if (!rows.length) return { samples: 0, accuracy: 0 };

  const correct = rows.filter((x) => {
    if (x.signal === "BUY") return x.outcome_pct > 0;
    if (x.signal === "SELL") return x.outcome_pct < 0;
    return Math.abs(x.outcome_pct) < 2;
  }).length;

  return { samples: rows.length, accuracy: Number(((correct / rows.length) * 100).toFixed(1)) };
}

export async function logBotDecision({ symbol, strategy, horizon, signal, priceAtSignal, evalAfterSec }) {
  const p = getPool();
  if (!p) return null;

  const r = await p.query(
    `
    INSERT INTO bot_decisions
      (symbol, strategy, horizon, signal, price_at_signal, eval_after_sec, due_at)
    VALUES
      ($1,$2,$3,$4,$5,$6, NOW() + ($6 || ' seconds')::interval)
    RETURNING *;
    `,
    [symbol, strategy, horizon, signal, priceAtSignal, evalAfterSec]
  );

  return r.rows[0];
}

export async function getDueDecisions(limit = 20) {
  const p = getPool();
  if (!p) return [];

  const r = await p.query(
    `
    SELECT *
    FROM bot_decisions
    WHERE evaluated_at IS NULL
      AND due_at <= NOW()
    ORDER BY due_at ASC
    LIMIT $1;
    `,
    [limit]
  );

  return r.rows;
}

export async function markDecisionEvaluated({ id, priceAfter }) {
  const p = getPool();
  if (!p) return null;

  // Get decision to compute outcome
  const d = await p.query(`SELECT * FROM bot_decisions WHERE id=$1`, [id]);
  const row = d.rows[0];
  if (!row) return null;

  const outcomePct = ((priceAfter - row.price_at_signal) / row.price_at_signal) * 100;

  const upd = await p.query(
    `
    UPDATE bot_decisions
    SET evaluated_at = NOW(),
        price_after = $2,
        outcome_pct = $3
    WHERE id = $1
    RETURNING *;
    `,
    [id, priceAfter, outcomePct]
  );

  return upd.rows[0];
}
