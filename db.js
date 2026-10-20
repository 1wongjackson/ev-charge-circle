import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH || path.join(import.meta.dirname, 'data', 'evcircle.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    car_model     TEXT NOT NULL,
    full_range_mi REAL NOT NULL,
    charge_level  REAL NOT NULL DEFAULT 50,
    daily_miles   REAL NOT NULL DEFAULT 30,
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
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at       TEXT NOT NULL,
    expected_end     TEXT NOT NULL,
    ended_at         TEXT,
    start_level      REAL,
    end_level        REAL,
    overdue_notified INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_charge ON charge_sessions((1)) WHERE ended_at IS NULL;
  CREATE INDEX IF NOT EXISTS charge_sessions_started ON charge_sessions(started_at);

  CREATE TABLE IF NOT EXISTS queue (
    user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL,
    note      TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    type           TEXT NOT NULL,
    user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    data           TEXT NOT NULL DEFAULT '{}',
    created_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

const getMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
const setMetaStmt = db.prepare(
  'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

export const getMeta = (key) => getMetaStmt.get(key)?.value ?? null;
export const setMeta = (key, value) => setMetaStmt.run(key, value == null ? null : String(value));
