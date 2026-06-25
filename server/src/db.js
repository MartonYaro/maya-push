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
  source       TEXT NOT NULL DEFAULT 'store'
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
addColumnIfMissing('apps', 'store', "TEXT NOT NULL DEFAULT 'appstore'");   // 'appstore' | 'googleplay'
addColumnIfMissing('keywords', 'frequency', 'INTEGER');
addColumnIfMissing('keywords', 'popularity', 'INTEGER');

// Auth & ops tables (added in v0.2)
addColumnIfMissing('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'last_login_at', 'INTEGER');
addColumnIfMissing('users', 'telegram', 'TEXT');

// Order workflow (v0.3) — tracks supplier delivery
addColumnIfMissing('installs', 'delivered',  'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('installs', 'updated_at', 'INTEGER');
addColumnIfMissing('installs', 'note',       'TEXT');

// Social login (v0.4) — Google + Telegram
addColumnIfMissing('users', 'google_id',   'TEXT');
addColumnIfMissing('users', 'telegram_id', 'TEXT');
addColumnIfMissing('users', 'avatar_url',  'TEXT');
addColumnIfMissing('users', 'provider',    "TEXT NOT NULL DEFAULT 'email'");
db.exec(`CREATE INDEX IF NOT EXISTS idx_users_google   ON users(google_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id);`);

// Admin controls (v0.5) — manual per-user price + blocking
addColumnIfMissing('users', 'blocked', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'custom_install_price', 'REAL');   // overrides plan price when set

// Referral code generator — defined before the backfill below uses it.
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
export function makeRefCode(len = 7) {
  let s = '';
  for (let i = 0; i < len; i++) s += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  return s;
}

// Referral program (v0.6) — each user has a code; referred users earn the
// referrer a % of delivered installs, valued at the REFERRER's own price.
addColumnIfMissing('users', 'ref_code',    'TEXT');
addColumnIfMissing('users', 'referred_by', 'INTEGER');
addColumnIfMissing('users', 'ref_rate',    'REAL');   // per-user override; null = global default
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_refcode ON users(ref_code) WHERE ref_code IS NOT NULL;`);

// Email lifecycle (v0.7) — low-balance flag (reset on top-up) + marketing opt-out.
addColumnIfMissing('users', 'low_balance_notified', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'email_optout',         'INTEGER NOT NULL DEFAULT 0');
db.exec(`CREATE INDEX IF NOT EXISTS idx_users_referredby ON users(referred_by);`);
// Backfill ref_code for any user that doesn't have one yet.
(() => {
  const rows = db.prepare('SELECT id FROM users WHERE ref_code IS NULL').all();
  const set = db.prepare('UPDATE users SET ref_code = ? WHERE id = ?');
  for (const r of rows) {
    let code;
    do { code = makeRefCode(); } while (db.prepare('SELECT 1 FROM users WHERE ref_code = ?').get(code));
    set.run(code, r.id);
  }
})();

db.exec(`
CREATE TABLE IF NOT EXISTS email_verifications (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  meta        TEXT,
  ip          TEXT,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user_time   ON audit_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action_time ON audit_log(action, created_at);

-- Support relay: maps a message the bot posted in the admin chat back to the
-- user's chat, so an admin reply (reply-to that message) reaches the right user.
CREATE TABLE IF NOT EXISTS support_map (
  admin_msg_id INTEGER PRIMARY KEY,
  user_chat_id INTEGER NOT NULL,
  user_name    TEXT,
  created_at   INTEGER NOT NULL
);
`);

// Admins from ADMIN_EMAILS (comma-separated).
const ADMIN_SET = new Set(
  (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

// Promote a single user if their email is in ADMIN_EMAILS. Called on every login
// so accounts created AFTER boot (e.g. first Google sign-in) still get admin.
export function maybePromoteAdmin(email) {
  if (!email || !ADMIN_SET.has(String(email).toLowerCase())) return;
  try {
    db.prepare("UPDATE users SET role = 'admin' WHERE LOWER(email) = ? AND role != 'admin'")
      .run(String(email).toLowerCase());
  } catch (e) { console.warn('[admin] promote failed:', e.message); }
}

// Promote any existing matching users at boot too.
(function syncAdminRoles() {
  if (!ADMIN_SET.size) return;
  const upd = db.prepare('UPDATE users SET role = ? WHERE LOWER(email) = ?');
  const tx = db.transaction(() => { for (const e of ADMIN_SET) upd.run('admin', e); });
  try { tx(); console.log(`[boot] admin roles synced for: ${[...ADMIN_SET].join(', ')}`); }
  catch (e) { console.warn('[boot] admin sync failed:', e.message); }
})();

export function getBalance(userId) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS bal
     FROM transactions
     WHERE user_id = ? AND status = 'done'`
  ).get(userId);
  return row.bal || 0;
}

export function now() { return Date.now(); }

// Referral helpers ---------------------------------------------------------
export function totalDeposited(userId) {
  return db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS s FROM transactions
     WHERE user_id = ? AND status = 'done' AND type = 'topup' AND amount > 0`
  ).get(userId).s || 0;
}

/** A user's effective per-install price: custom override, else volume tier. */
export function userInstallPrice(userId) {
  const u = db.prepare('SELECT custom_install_price FROM users WHERE id = ?').get(userId);
  if (u && u.custom_install_price != null) return Number(u.custom_install_price);
  const dep = totalDeposited(userId);
  return dep >= 15000 ? 0.12 : dep >= 5000 ? 0.20 : 0.30;
}

export const REFERRAL_RATE = () => Number(process.env.REFERRAL_RATE) || 0.05;
