// db.js (ESM) — Phase A FINAL
import pg from "pg";
const { Pool } = pg;

function buildPoolConfig() {
  const cs = process.env.DATABASE_URL;
  if (!cs) return null;
  return {
    connectionString: cs,
    ssl:
      process.env.PGSSL_DISABLE === "true"
        ? false
        : { rejectUnauthorized: false },
  };
}

const poolConfig = buildPoolConfig();
export const hasDb = !!poolConfig;
export const pool = hasDb ? new Pool(poolConfig) : null;

export async function dbQuery(sql, params = []) {
  if (!hasDb) throw new Error("DATABASE_URL not set");
  return pool.query(sql, params);
}

export async function dbInit() {
  if (!hasDb) return;

  // ---------- CORE TABLES ----------
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS trades (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      bot TEXT NOT NULL,
      strategy TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('BUY','SELL','HOLD')),
      qty NUMERIC NOT NULL DEFAULT 0,
      price NUMERIC NOT NULL DEFAULT 0,
      rationale TEXT NOT NULL DEFAULT '',
      confidence INT NOT NULL DEFAULT 50,
      horizon TEXT NOT NULL DEFAULT 'medium',
      features JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  // ---------- SAFE MIGRATIONS ----------
  await dbQuery(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS ts TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await dbQuery(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS bot TEXT;`);
  await dbQuery(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS strategy TEXT;`);
  await dbQuery(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS rationale TEXT NOT NULL DEFAULT '';`);
  await dbQuery(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS confidence INT NOT NULL DEFAULT 50;`);
  await dbQuery(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS horizon TEXT NOT NULL DEFAULT 'medium';`);
  await dbQuery(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{}'::jsonb;`);

  // ---------- BACKFILL ----------
  await dbQuery(`
    UPDATE trades
    SET bot = COALESCE(bot, 'unknown')
    WHERE bot IS NULL;
  `);

  await dbQuery(`
    UPDATE trades
    SET strategy = COALESCE(strategy, bot, 'unknown')
    WHERE strategy IS NULL;
  `);

  // ---------- ENFORCE (SAFE) ----------
  await dbQuery(`
    DO $$
    BEGIN
      BEGIN
        ALTER TABLE trades ALTER COLUMN bot SET NOT NULL;
      EXCEPTION WHEN others THEN NULL;
      END;

      BEGIN
        ALTER TABLE trades ALTER COLUMN strategy SET NOT NULL;
      EXCEPTION WHEN others THEN NULL;
      END;
    END $$;
  `);

  // ---------- EVENTS ----------
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  // ---------- LEARNING ----------
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
}
