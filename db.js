// db.js (ESM)
import pg from "pg";
const { Pool } = pg;

function buildPoolConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;

  // Railway Postgres typically requires SSL in production.
  // If your DATABASE_URL already includes sslmode=require it's fine; this is extra safety.
  const ssl =
    process.env.PGSSL_DISABLE === "true"
      ? false
      : { rejectUnauthorized: false };

  return { connectionString, ssl };
}

const poolConfig = buildPoolConfig();
export const hasDb = !!poolConfig;

export const pool = hasDb ? new Pool(poolConfig) : null;

export async function dbQuery(sql, params = []) {
  if (!hasDb) throw new Error("DB not configured (DATABASE_URL missing)");
  return pool.query(sql, params);
}

export async function dbInit() {
  if (!hasDb) return;

  // Core tables:
  // - settings: store learning speed etc
  // - portfolios: bot cash + goal
  // - positions: holdings per bot+symbol
  // - trades: executed trades ledger
  // - learning_samples: what bots predicted vs what happened later
  // - events: war room event stream
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS portfolios (
      bot TEXT PRIMARY KEY,
      cash NUMERIC NOT NULL,
      goal NUMERIC NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS positions (
      bot TEXT NOT NULL,
      symbol TEXT NOT NULL,
      qty NUMERIC NOT NULL DEFAULT 0,
      avg_price NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (bot, symbol)
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS trades (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      bot TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('BUY','SELL','HOLD')),
      qty NUMERIC NOT NULL DEFAULT 0,
      price NUMERIC NOT NULL DEFAULT 0,
      rationale TEXT NOT NULL DEFAULT '',
      confidence INT NOT NULL DEFAULT 50,
      horizon TEXT NOT NULL DEFAULT 'medium'
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS learning_samples (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      bot TEXT NOT NULL,
      strategy TEXT NOT NULL,
      symbol TEXT NOT NULL,
      signal TEXT NOT NULL CHECK (signal IN ('BUY','SELL','HOLD')),
      horizon TEXT NOT NULL DEFAULT 'medium',
      price_at_signal NUMERIC NOT NULL,
      features JSONB NOT NULL DEFAULT '{}'::jsonb,
      rationale TEXT NOT NULL DEFAULT '',
      confidence INT NOT NULL DEFAULT 50,
      eval_after_sec INT NOT NULL DEFAULT 3600,
      evaluated_at TIMESTAMPTZ,
      price_after NUMERIC,
      outcome_pct NUMERIC,
      correct BOOLEAN
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

  // Default settings
  await dbQuery(
    `
    INSERT INTO settings(key, value)
    VALUES ('learning_speed', '{"mode":"realtime","evalAfterSec":3600}'::jsonb)
    ON CONFLICT (key) DO NOTHING;
  `
  );
}

export async function getSetting(key) {
  if (!hasDb) return null;
  const r = await dbQuery(`SELECT value FROM settings WHERE key=$1`, [key]);
  return r.rows?.[0]?.value ?? null;
}

export async function setSetting(key, valueObj) {
  if (!hasDb) return null;
  await dbQuery(
    `
    INSERT INTO settings(key, value, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (key)
    DO UPDATE SET value=$2::jsonb, updated_at=NOW();
  `,
    [key, JSON.stringify(valueObj)]
  );
  return valueObj;
}
