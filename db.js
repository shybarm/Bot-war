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

/**
 * Safe migration helper: add a column if missing.
 * Works even if the table exists already.
 */
async function addColumnIfMissing(p, table, col, typeSql) {
  await p.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${typeSql};`);
}

export async function initDb() {
  const p = getPool();
  if (!p) {
    console.log("⚠️ DATABASE_URL not set — running WITHOUT DB");
    return;
  }

  await p.query("SELECT 1;");

  await p.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

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
    CREATE INDEX IF NOT EXISTS idx_bot_decisions_symbol_created
    ON bot_decisions(symbol, created_at DESC);
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_bot_decisions_due
    ON bot_decisions(due_at)
    WHERE evaluated_at IS NULL;
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS bot_accounts (
      strategy TEXT PRIMARY KEY,
      cash DOUBLE PRECISION NOT NULL,
      starting_cash DOUBLE PRECISION NOT NULL,
      target_cash DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS bot_positions (
      strategy TEXT NOT NULL,
      symbol TEXT NOT NULL,
      qty DOUBLE PRECISION NOT NULL,
      avg_price DOUBLE PRECISION NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (strategy, symbol)
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS bot_trades (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      strategy TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      qty DOUBLE PRECISION NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      notional DOUBLE PRECISION NOT NULL
      -- note column may be added later by migration
    );
  `);

  // ✅ SAFE MIGRATION: ensure note exists (fix your current error)
  await addColumnIfMissing(p, "bot_trades", "note", "TEXT");

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_bot_trades_created
    ON bot_trades(created_at DESC);
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_bot_trades_strategy_created
    ON bot_trades(strategy, created_at DESC);
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS symbol_universe (
      symbol TEXT PRIMARY KEY,
      description TEXT,
      type TEXT,
      currency TEXT,
      mic TEXT,
      exchange TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_symbol_universe_exchange
    ON symbol_universe(exchange);
  `);

  console.log("✅ DB ready (with migrations)");
}

/* ---------------- Settings ---------------- */

export async function getSetting(key, fallback = null) {
  const p = getPool();
  if (!p) return fallback;

  const r = await p.query(`SELECT value FROM app_settings WHERE key=$1`, [key]);
  return r.rows[0]?.value ?? fallback;
}

export async function setSetting(key, value) {
  const p = getPool();
  if (!p) return null;

  const r = await p.query(
    `
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ($1,$2,NOW())
    ON CONFLICT (key)
    DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
    RETURNING key, value, updated_at;
    `,
    [key, String(value)]
  );

  return r.rows[0];
}

/* ---------------- Advisory Lock ---------------- */

export async function tryAdvisoryLock(lockId) {
  const p = getPool();
  if (!p) return { hasDb: false, locked: false };

  const r = await p.query(`SELECT pg_try_advisory_lock($1) AS locked;`, [lockId]);
  return { hasDb: true, locked: !!r.rows[0]?.locked };
}

/* ---------------- Learning ---------------- */

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

/* ---------------- Decisions ---------------- */

export async function logBotDecision({ symbol, strategy, horizon, signal, priceAtSignal, evalAfterSec }) {
  const p = getPool();
  if (!p) return null;

  const r = await p.query(
    `
    INSERT INTO bot_decisions
      (symbol, strategy, horizon, signal, price_at_signal, eval_after_sec, due_at)
    VALUES
      ($1,$2,$3,$4,$5, $6::int, NOW() + (($6::int) * INTERVAL '1 second'))
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

export async function getLearningSummary({ symbol, limit = 200 }) {
  const p = getPool();
  if (!p) {
    return { hasDb: false, symbol, pending: 0, evaluated: 0, samplesByStrategy: {}, accuracyByStrategy: {} };
  }

  const sym = symbol.toUpperCase();

  const pendingQ = await p.query(
    `SELECT COUNT(*)::int AS n FROM bot_decisions WHERE symbol=$1 AND evaluated_at IS NULL;`,
    [sym]
  );

  const evaluatedQ = await p.query(
    `SELECT COUNT(*)::int AS n FROM bot_decisions WHERE symbol=$1 AND evaluated_at IS NOT NULL;`,
    [sym]
  );

  const eventsQ = await p.query(
    `SELECT strategy, signal, outcome_pct
     FROM learning_events
     WHERE symbol=$1
     ORDER BY created_at DESC
     LIMIT $2;`,
    [sym, limit]
  );

  const rows = eventsQ.rows || [];
  const samplesByStrategy = {};
  const correctByStrategy = {};

  for (const r of rows) {
    const st = r.strategy || "unknown";
    samplesByStrategy[st] = (samplesByStrategy[st] || 0) + 1;

    const ok =
      (r.signal === "BUY" && r.outcome_pct > 0) ||
      (r.signal === "SELL" && r.outcome_pct < 0) ||
      (r.signal === "HOLD" && Math.abs(r.outcome_pct) < 2);

    if (ok) correctByStrategy[st] = (correctByStrategy[st] || 0) + 1;
  }

  const accuracyByStrategy = {};
  for (const st of Object.keys(samplesByStrategy)) {
    const s = samplesByStrategy[st];
    const c = correctByStrategy[st] || 0;
    accuracyByStrategy[st] = s ? Number(((c / s) * 100).toFixed(1)) : 0;
  }

  return {
    hasDb: true,
    symbol: sym,
    pending: pendingQ.rows[0]?.n || 0,
    evaluated: evaluatedQ.rows[0]?.n || 0,
    samplesByStrategy,
    accuracyByStrategy
  };
}

/* ---------------- Bot Accounts / Trades ---------------- */

export async function ensureBotAccounts({ startingCash = 100000, targetCash = 150000 }) {
  const p = getPool();
  if (!p) return null;

  const strategies = ["sp500_long", "market_swing", "day_trade"];
  for (const s of strategies) {
    await p.query(
      `
      INSERT INTO bot_accounts (strategy, cash, starting_cash, target_cash)
      VALUES ($1,$2,$2,$3)
      ON CONFLICT (strategy) DO NOTHING;
      `,
      [s, startingCash, targetCash]
    );
  }
  return true;
}

export async function getBotAccounts() {
  const p = getPool();
  if (!p) return [];

  const r = await p.query(
    `SELECT strategy, cash, starting_cash, target_cash, updated_at
     FROM bot_accounts
     ORDER BY strategy;`
  );
  return r.rows;
}

export async function getBotPositions(strategy) {
  const p = getPool();
  if (!p) return [];

  const r = await p.query(
    `SELECT symbol, qty, avg_price, updated_at
     FROM bot_positions
     WHERE strategy=$1
     ORDER BY symbol;`,
    [strategy]
  );
  return r.rows;
}

export async function recordTrade({ strategy, symbol, side, qty, price, note = null }) {
  const p = getPool();
  if (!p) return null;

  const notional = qty * price;

  await p.query(
    `INSERT INTO bot_trades (strategy, symbol, side, qty, price, notional, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7);`,
    [strategy, symbol, side, qty, price, notional, note]
  );

  if (side === "BUY") {
    await p.query(
      `UPDATE bot_accounts SET cash = cash - $2, updated_at=NOW()
       WHERE strategy=$1;`,
      [strategy, notional]
    );

    await p.query(
      `
      INSERT INTO bot_positions (strategy, symbol, qty, avg_price)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (strategy, symbol) DO UPDATE
      SET
        avg_price = ((bot_positions.qty * bot_positions.avg_price) + (EXCLUDED.qty * EXCLUDED.avg_price)) / (bot_positions.qty + EXCLUDED.qty),
        qty = bot_positions.qty + EXCLUDED.qty,
        updated_at = NOW();
      `,
      [strategy, symbol, qty, price]
    );
  }

  if (side === "SELL") {
    await p.query(
      `UPDATE bot_accounts SET cash = cash + $2, updated_at=NOW()
       WHERE strategy=$1;`,
      [strategy, notional]
    );

    const pos = await p.query(
      `SELECT qty FROM bot_positions WHERE strategy=$1 AND symbol=$2;`,
      [strategy, symbol]
    );
    const currentQty = pos.rows[0]?.qty ?? 0;
    const newQty = currentQty - qty;

    if (newQty <= 0.0000001) {
      await p.query(
        `DELETE FROM bot_positions WHERE strategy=$1 AND symbol=$2;`,
        [strategy, symbol]
      );
    } else {
      await p.query(
        `UPDATE bot_positions SET qty=$3, updated_at=NOW() WHERE strategy=$1 AND symbol=$2;`,
        [strategy, symbol, newQty]
      );
    }
  }

  return { ok: true };
}

export async function getRecentTrades({ limit = 50 }) {
  const p = getPool();
  if (!p) return [];

  const r = await p.query(
    `
    SELECT id, created_at, strategy, symbol, side, qty, price, notional, note
    FROM bot_trades
    ORDER BY created_at DESC
    LIMIT $1;
    `,
    [limit]
  );
  return r.rows;
}

export async function getStrategyTrades({ strategy, limit = 50 }) {
  const p = getPool();
  if (!p) return [];

  const r = await p.query(
    `
    SELECT id, created_at, strategy, symbol, side, qty, price, notional, note
    FROM bot_trades
    WHERE strategy=$1
    ORDER BY created_at DESC
    LIMIT $2;
    `,
    [strategy, limit]
  );
  return r.rows;
}

/* ---------------- Universe Cache (used later) ---------------- */

export async function upsertUniverseSymbols(exchange, symbols) {
  const p = getPool();
  if (!p) return { ok: false, error: "no_db" };

  const chunkSize = 500;
  let upserted = 0;

  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize);
    const values = [];
    const params = [];

    let idx = 1;
    for (const s of chunk) {
      params.push(s.symbol, s.description || null, s.type || null, s.currency || null, s.mic || null, exchange);
      values.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++}, NOW())`);
    }

    await p.query(
      `
      INSERT INTO symbol_universe (symbol, description, type, currency, mic, exchange, updated_at)
      VALUES ${values.join(",")}
      ON CONFLICT (symbol) DO UPDATE
      SET
        description = EXCLUDED.description,
        type = EXCLUDED.type,
        currency = EXCLUDED.currency,
        mic = EXCLUDED.mic,
        exchange = EXCLUDED.exchange,
        updated_at = NOW();
      `,
      params
    );

    upserted += chunk.length;
  }

  return { ok: true, upserted };
}

export async function universeCount(exchange = null) {
  const p = getPool();
  if (!p) return { hasDb: false, count: 0 };

  if (!exchange) {
    const r = await p.query(`SELECT COUNT(*)::int AS n FROM symbol_universe;`);
    return { hasDb: true, count: r.rows[0]?.n || 0 };
  }

  const r = await p.query(`SELECT COUNT(*)::int AS n FROM symbol_universe WHERE exchange=$1;`, [exchange]);
  return { hasDb: true, count: r.rows[0]?.n || 0 };
}

export async function universeSample({ exchange = null, limit = 50 }) {
  const p = getPool();
  if (!p) return [];

  if (exchange) {
    const r = await p.query(
      `SELECT symbol, description, type
       FROM symbol_universe
       WHERE exchange=$1
       ORDER BY random()
       LIMIT $2;`,
      [exchange, limit]
    );
    return r.rows;
  }

  const r = await p.query(
    `SELECT symbol, description, type
     FROM symbol_universe
     ORDER BY random()
     LIMIT $1;`,
    [limit]
  );
  return r.rows;
}

/* ---------------- Debug ---------------- */

export async function dbListTables() {
  const p = getPool();
  if (!p) return { hasDb: false, tables: [] };

  const r = await p.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename;
  `);

  return { hasDb: true, tables: r.rows.map(x => x.tablename) };
}

export async function dbDecisionCounts(symbol) {
  const p = getPool();
  if (!p) return { hasDb: false, symbol, total: 0, pending: 0, evaluated: 0 };

  const sym = symbol.toUpperCase();

  const totalQ = await p.query(`SELECT COUNT(*)::int AS n FROM bot_decisions WHERE symbol=$1;`, [sym]);
  const pendingQ = await p.query(`SELECT COUNT(*)::int AS n FROM bot_decisions WHERE symbol=$1 AND evaluated_at IS NULL;`, [sym]);
  const evaluatedQ = await p.query(`SELECT COUNT(*)::int AS n FROM bot_decisions WHERE symbol=$1 AND evaluated_at IS NOT NULL;`, [sym]);

  return {
    hasDb: true,
    symbol: sym,
    total: totalQ.rows[0]?.n || 0,
    pending: pendingQ.rows[0]?.n || 0,
    evaluated: evaluatedQ.rows[0]?.n || 0
  };
}

export async function dbRecentDecisions(symbol, limit = 10) {
  const p = getPool();
  if (!p) return { hasDb: false, symbol, rows: [] };

  const sym = symbol.toUpperCase();
  const r = await p.query(
    `
    SELECT id, created_at, symbol, strategy, horizon, signal, price_at_signal, due_at, evaluated_at
    FROM bot_decisions
    WHERE symbol=$1
    ORDER BY created_at DESC
    LIMIT $2;
    `,
    [sym, limit]
  );

  return { hasDb: true, symbol: sym, rows: r.rows };
}
