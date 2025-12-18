// db.js (ESM)
import pg from "pg";
const { Pool } = pg;

function buildPoolConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;

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

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS runner_state (
      id TEXT PRIMARY KEY,
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

  // Add features column to trades (for “why” + bot history insight)
  await dbQuery(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{}'::jsonb;`);

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

  // Online learning model weights (simple logistic regression)
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS model_weights (
      strategy TEXT NOT NULL,
      feature TEXT NOT NULL,
      weight NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(strategy, feature)
    );
  `);

  // Defaults
  await dbQuery(`
    INSERT INTO settings(key, value)
    VALUES ('learning_speed', '{"mode":"realtime","evalAfterSec":3600}'::jsonb)
    ON CONFLICT (key) DO NOTHING;
  `);

  await dbQuery(`
    INSERT INTO settings(key, value)
    VALUES ('universe', '{"mode":"any","custom":[]}'::jsonb)
    ON CONFLICT (key) DO NOTHING;
  `);

  await dbQuery(`
    INSERT INTO runner_state(id, value)
    VALUES ('main', '{"idx":0,"lastTick":null,"lastSymbol":"AAPL"}'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  `);

  // Initialize weights for all strategies and base features (bias, avgSent, changePercent)
  const strategies = ["sp500_long", "market_swing", "day_trade", "news_only"];
  const features = ["bias", "avgSent", "changePercent"];

  for (const s of strategies) {
    for (const f of features) {
      await dbQuery(
        `
        INSERT INTO model_weights(strategy, feature, weight)
        VALUES ($1,$2,0)
        ON CONFLICT (strategy, feature) DO NOTHING
      `,
        [s, f]
      );
    }
  }
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

export async function getRunnerState() {
  if (!hasDb) return { idx: 0, lastTick: null, lastSymbol: "AAPL" };
  const r = await dbQuery(`SELECT value FROM runner_state WHERE id='main'`);
  return r.rows?.[0]?.value ?? { idx: 0, lastTick: null, lastSymbol: "AAPL" };
}

export async function setRunnerState(valueObj) {
  if (!hasDb) return valueObj;
  await dbQuery(
    `
    INSERT INTO runner_state(id, value, updated_at)
    VALUES ('main', $1::jsonb, NOW())
    ON CONFLICT (id)
    DO UPDATE SET value=$1::jsonb, updated_at=NOW();
  `,
    [JSON.stringify(valueObj)]
  );
  return valueObj;
}

export async function getWeights(strategy) {
  if (!hasDb) return { bias: 0, avgSent: 0, changePercent: 0 };
  const r = await dbQuery(
    `SELECT feature, weight FROM model_weights WHERE strategy=$1`,
    [strategy]
  );
  const w = { bias: 0, avgSent: 0, changePercent: 0 };
  for (const row of r.rows) w[row.feature] = Number(row.weight);
  return w;
}

export async function setWeight(strategy, feature, weight) {
  if (!hasDb) return;
  await dbQuery(
    `
    INSERT INTO model_weights(strategy, feature, weight, updated_at)
    VALUES ($1,$2,$3,NOW())
    ON CONFLICT (strategy, feature)
    DO UPDATE SET weight=$3, updated_at=NOW()
  `,
    [strategy, feature, weight]
  );
}
