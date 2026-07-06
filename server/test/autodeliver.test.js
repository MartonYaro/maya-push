import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB BEFORE db.js is imported (it opens the file at import time).
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'maya-ad-')), 'test.db');
process.env.REFERRAL_RATE = '0.05';
delete process.env.ADMIN_EMAILS;

const { db, now } = await import('../src/db.js');
const { runAutoDeliver, deliverDelayMs, deliverAtFor } = await import('../src/services/autoDeliver.js');

let seq = 0;
function seed() {
  const t = now();
  const n = ++seq;
  const ref = db.prepare('INSERT INTO users (email,password_hash,name,created_at) VALUES (?,?,?,?)')
    .run(`ref${n}@x.com`, 'x', 'Ref', t).lastInsertRowid;
  const buyer = db.prepare('INSERT INTO users (email,password_hash,name,created_at,referred_by) VALUES (?,?,?,?,?)')
    .run(`buyer${n}@x.com`, 'x', 'Buyer', t, ref).lastInsertRowid;
  const app = db.prepare('INSERT INTO apps (user_id,name,country,created_at) VALUES (?,?,?,?)')
    .run(buyer, 'App', 'us', t).lastInsertRowid;
  const kw = db.prepare('INSERT INTO keywords (app_id,term,plan,created_at) VALUES (?,?,?,?)')
    .run(app, `kw${n}`, 'standard', t).lastInsertRowid;
  return { ref, buyer, app, kw, t };
}

test('deliverDelayMs stays within the 3–8h window', () => {
  for (let i = 0; i < 1000; i++) {
    const ms = deliverDelayMs();
    assert.ok(ms >= 3 * 3600_000 && ms <= 8 * 3600_000, `delay out of range: ${ms}`);
  }
});

test('deliverAtFor keeps delivery inside the POOL day', () => {
  const H = 3600_000;
  const t = now();
  // Order placed now for TOMORROW: delivery must land tomorrow 14:00–22:00 UTC,
  // never today — this is the "заказ на завтра не готов сегодня" rule.
  const tomorrow = new Date(t + 24 * H).toISOString().slice(0, 10);
  const tomorrowStart = Date.parse(tomorrow + 'T00:00:00Z');
  for (let i = 0; i < 300; i++) {
    const at = deliverAtFor(tomorrow, t);
    assert.ok(at >= tomorrowStart + 14 * H, `delivered before the pool day window: ${at}`);
    assert.ok(at <= tomorrowStart + 22 * H, `delivered after the pool day window: ${at}`);
  }
  // Same-day order placed late at night: 3h minimum from creation still holds.
  const today = new Date(t).toISOString().slice(0, 10);
  for (let i = 0; i < 300; i++) {
    const at = deliverAtFor(today, t);
    assert.ok(at >= t + 3 * H, `same-day order delivered sooner than 3h: ${at - t}`);
  }
  // Garbage date falls back to creation-based delay.
  const fb = deliverAtFor('not-a-date', t);
  assert.ok(fb >= t + 3 * H && fb <= t + 8 * H);
});

test('flips due orders to delivered (full count) and pays the referrer; leaves future ones', () => {
  const { ref, kw, t } = seed();
  const due = db.prepare(
    'INSERT INTO installs (keyword_id,date,count,status,cost,created_at,deliver_at) VALUES (?,?,?,?,?,?,?)'
  ).run(kw, '2026-06-20', 10, 'scheduled', 3, t, t - 1000).lastInsertRowid;
  const future = db.prepare(
    'INSERT INTO installs (keyword_id,date,count,status,cost,created_at,deliver_at) VALUES (?,?,?,?,?,?,?)'
  ).run(kw, '2026-06-21', 5, 'scheduled', 1.5, t, t + 5 * 3600_000).lastInsertRowid;

  const res = runAutoDeliver();
  assert.ok(res.delivered >= 1);

  const d = db.prepare('SELECT status, delivered FROM installs WHERE id=?').get(due);
  assert.equal(d.status, 'delivered');
  assert.equal(d.delivered, 10);

  // Its pool day (a past date) has begun but deliver_at is still in the future →
  // the order is being worked, not delivered.
  const f = db.prepare('SELECT status, delivered FROM installs WHERE id=?').get(future);
  assert.equal(f.status, 'in_progress');
  assert.equal(f.delivered, 0);

  const tx = db.prepare("SELECT amount FROM transactions WHERE user_id=? AND type='referral'").get(ref);
  assert.ok(tx && tx.amount > 0, 'referrer was credited');
});

test('backfills deliver_at for legacy orders and delivers overdue ones', () => {
  const { kw, t } = seed();
  const legacy = db.prepare(
    'INSERT INTO installs (keyword_id,date,count,status,cost,created_at) VALUES (?,?,?,?,?,?)'  // no deliver_at
  ).run(kw, '2026-06-19', 8, 'in_progress', 2.4, t - 12 * 3600_000).lastInsertRowid;

  // before: deliver_at is NULL
  assert.equal(db.prepare('SELECT deliver_at FROM installs WHERE id=?').get(legacy).deliver_at, null);

  runAutoDeliver();

  const row = db.prepare('SELECT status, delivered, deliver_at FROM installs WHERE id=?').get(legacy);
  assert.ok(row.deliver_at != null, 'deliver_at got assigned from created_at');
  // created 12h ago + (3–8h) window → already overdue → delivered this run
  assert.equal(row.status, 'delivered');
  assert.equal(row.delivered, 8);
});

test('does not touch cancelled / failed / already-delivered orders', () => {
  const { kw, t } = seed();
  const cancelled = db.prepare(
    'INSERT INTO installs (keyword_id,date,count,status,cost,created_at,deliver_at) VALUES (?,?,?,?,?,?,?)'
  ).run(kw, '2026-06-18', 4, 'cancelled', 0, t, t - 1000).lastInsertRowid;

  runAutoDeliver();
  assert.equal(db.prepare('SELECT status FROM installs WHERE id=?').get(cancelled).status, 'cancelled');
});

test('an order for a FUTURE pool day stays scheduled', () => {
  const { kw, t } = seed();
  const H = 3600_000;
  const tomorrow = new Date(t + 24 * H).toISOString().slice(0, 10);
  const id = db.prepare(
    'INSERT INTO installs (keyword_id,date,count,status,cost,created_at,deliver_at) VALUES (?,?,?,?,?,?,?)'
  ).run(kw, tomorrow, 7, 'scheduled', 2.1, t, deliverAtFor(tomorrow, t)).lastInsertRowid;

  runAutoDeliver();
  const row = db.prepare('SELECT status, delivered FROM installs WHERE id=?').get(id);
  assert.equal(row.status, 'scheduled', 'tomorrow order must not start or deliver today');
  assert.equal(row.delivered, 0);
});
