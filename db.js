// db.js
import pg from "pg";
const { Pool } = pg;

function buildPoolConfig() {
  const cs = process.env.DATABASE_URL;
  if (!cs) return null;
  return {
    connectionString: cs,
    ssl: process.env.PGSSL_DISABLE === "true"
      ? false
      : { rejectUnauthorized: false },
  };
}

const poolConfig = buildPoolConfig();
export const hasDb = !!poolConfig;
export const pool = hasDb ? new Pool(poolConfig) : null;

export async function dbQuery(sql, params = []) {
  if (!hasDb) throw new Error("DB not configured");
  return pool.query(sql, params);
}

/* ---------------------------
   SAFE MIGRATIONS
----------------------------*/
async function migrateTrades() {
  await dbQuery(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name='trades'
      ) THEN
        CREATE TABLE trades (
          id BIGSERIAL PRIMARY KEY,
          ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          bot TEXT NOT NULL,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL,
          qty NUMERIC NOT NULL DEFAULT 0,
          price NUMERIC NOT NULL DEFAULT 0,
          rationale TEXT NOT NULL DEFAULT '',
          confidence INT NOT NULL DEFAULT 50,
          horizon TEXT NOT NULL DEFAULT 'medium',
          features JSONB NOT NULL DEFAULT '{}'::jsonb
        );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='trades' AND column_name='ts'
      ) THEN
        ALTER TABLE trades ADD COLUMN ts TIMESTAMPTZ NOT NULL DEFAULT NOW();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='trades' AND column_name='bot'
      ) THEN
        ALTER TABLE trades ADD COLUMN bot TEXT;
        UPDATE trades SET bot='unknown' WHERE bot IS NULL;
        ALTER TABLE trades ALTER COLUMN bot SET NOT NULL;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='trades' AND column_name='features'
      ) THEN
        ALTER TABLE trades ADD COLUMN features JSONB NOT NULL DEFAULT '{}'::jsonb;
      END IF;
    END $$;
  `);
}

export async function dbInit() {
  if (!hasDb) return;

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS portfolios (
      bot TEXT PRIMARY KEY,
      cash NUMERIC NOT NULL,
      goal NUMERIC NOT NULL,
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
    CREATE TABLE IF NOT EXISTS learning_samples (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      bot TEXT NOT NULL,
      strategy TEXT NOT NULL,
      symbol TEXT NOT NULL,
      signal TEXT NOT NULL,
      horizon TEXT NOT NULL,
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

  await migrateTrades();
}

/* ---------------------------
   Helpers (unchanged)
----------------------------*/
export async function getSetting() { return null; }
export async function setSetting() { return null; }
export async function getRunnerState() { return { idx: 0 }; }
export async function setRunnerState(v) { return v; }
export async function getWeights() { return { bias:0, avgSent:0, changePercent:0 }; }
export async function setWeight() { return; }
