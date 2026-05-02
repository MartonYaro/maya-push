import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const dbPath = resolve(process.env.DB_PATH || './data/maya.db');
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'user',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS apps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id     TEXT,
  bundle_id    TEXT,
  name         TEXT NOT NULL,
  icon_url     TEXT,
  category     TEXT,
  country      TEXT NOT NULL DEFAULT 'us',
  url          TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apps_user ON apps(user_id);

CREATE TABLE IF NOT EXISTS keywords (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  term         TEXT NOT NULL,
  country      TEXT NOT NULL DEFAULT 'us',
  target_pos   INTEGER NOT NULL DEFAULT 10,
  current_pos  INTEGER,
  plan         TEXT NOT NULL DEFAULT 'standard',
  daily_cap    INTEGER NOT NULL DEFAULT 100,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   INTEGER NOT NULL,
  last_checked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_keywords_app ON keywords(app_id);

CREATE TABLE IF NOT EXISTS keyword_positions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword_id   INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  position     INTEGER,
  checked_at   INTEGER NOT NULL,
  source       TEXT NOT NULL DEFAULT 'apptweak'
);
CREATE INDEX IF NOT EXISTS idx_positions_keyword_time ON keyword_positions(keyword_id, checked_at);

CREATE TABLE IF NOT EXISTS installs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword_id   INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'done',
  cost         REAL NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  UNIQUE(keyword_id, date)
);
CREATE INDEX IF NOT EXISTS idx_installs_keyword_date ON installs(keyword_id, date);

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  amount       REAL NOT NULL,
  status       TEXT NOT NULL DEFAULT 'done',
  description  TEXT,
  ref_id       TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user_time ON transactions(user_id, created_at);
`);

// Soft migrations: add columns to existing tables if missing.
function addColumnIfMissing(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
addColumnIfMissing('apps', 'rating', 'REAL');
addColumnIfMissing('apps', 'rating_count', 'INTEGER');
addColumnIfMissing('apps', 'developer', 'TEXT');
addColumnIfMissing('apps', 'subtitle', 'TEXT');
addColumnIfMissing('keywords', 'frequency', 'INTEGER');
addColumnIfMissing('keywords', 'popularity', 'INTEGER');

export function getBalance(userId) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS bal
     FROM transactions
     WHERE user_id = ? AND status = 'done'`
  ).get(userId);
  return row.bal || 0;
}

export function now() { return Date.now(); }
