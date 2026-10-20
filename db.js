import path from 'node:path';

// Postgres in production (DATABASE_URL, e.g. Neon). Without it, fall back to
// PGlite - an embedded Postgres - so local dev needs no database server.
let rawQuery;
let rawExec;

if (process.env.DATABASE_URL) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  pool.on('error', (err) => console.error('Postgres pool error', err));
  rawQuery = async (sql, params) => (await pool.query(sql, params)).rows;
  rawExec = (sql) => pool.query(sql);
  console.log('Using Postgres from DATABASE_URL');
} else {
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = process.env.PGLITE_DIR || path.join(import.meta.dirname, 'data', 'pglite');
  const lite = new PGlite(dir);
  rawQuery = async (sql, params) => (await lite.query(sql, params)).rows;
  rawExec = (sql) => lite.exec(sql);
  console.log(`Using embedded PGlite database at ${dir}`);
}

/** Run a query and return all rows. */
export const all = (sql, params = []) => rawQuery(sql, params);
/** Run a query and return the first row (or undefined). */
export const one = async (sql, params = []) => (await rawQuery(sql, params))[0];

await rawExec(`
  CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    car_model     TEXT NOT NULL,
    full_range_mi DOUBLE PRECISION NOT NULL,
    charge_level  DOUBLE PRECISION NOT NULL DEFAULT 50,
    daily_miles   DOUBLE PRECISION NOT NULL DEFAULT 30,
    updated_at    TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );

  -- One row per use of the shared charger. ended_at IS NULL = currently charging.
  CREATE TABLE IF NOT EXISTS charge_sessions (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at       TEXT NOT NULL,
    expected_end     TEXT NOT NULL,
    ended_at         TEXT,
    start_level      DOUBLE PRECISION,
    end_level        DOUBLE PRECISION,
    overdue_notified BOOLEAN NOT NULL DEFAULT FALSE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_charge ON charge_sessions ((ended_at IS NULL)) WHERE ended_at IS NULL;
  CREATE INDEX IF NOT EXISTS charge_sessions_started ON charge_sessions(started_at);

  CREATE TABLE IF NOT EXISTS queue (
    user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL,
    note      TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id             SERIAL PRIMARY KEY,
    type           TEXT NOT NULL,
    user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    data           TEXT NOT NULL DEFAULT '{}',
    created_at     TEXT NOT NULL
  );

  -- Display preference only; distances are always stored in miles.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS units TEXT NOT NULL DEFAULT 'imperial';

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

export const getMeta = async (key) => (await one('SELECT value FROM meta WHERE key = $1', [key]))?.value ?? null;
export const setMeta = (key, value) =>
  all(
    'INSERT INTO meta(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [key, value == null ? null : String(value)]
  );
