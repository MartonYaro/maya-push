import { Router } from 'express';
import { db, now, getBalance } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { broadcast } from '../sse.js';
import { notifyAdmin, tgInstallOrder, tgInstallCancelled } from '../services/telegram.js';
import { audit } from '../services/audit.js';
import { LIMITS } from '../config/limits.js';
import { maybeEmailLowBalance } from '../services/notifications.js';
import { priceFor, installCost } from '../lib/pricing.js';
import { deliverAtFor } from '../services/autoDeliver.js';

const router = Router();
router.use(requireAuth);

function ownsApp(userId, appId) {
  return db.prepare('SELECT id FROM apps WHERE id = ? AND user_id = ?').get(appId, userId);
}

function ownsKeyword(userId, keywordId) {
  return db.prepare(
    `SELECT k.* FROM keywords k
     JOIN apps a ON a.id = k.app_id
     WHERE k.id = ? AND a.user_id = ?`
  ).get(keywordId, userId);
}

/**
 * Create keyword(s).
 * Body:
 *   { app_id, term: "messenger" }                    — single
 *   { app_id, term: "messenger,chat,signal" }        — comma/newline separated
 *   { app_id, terms: ["messenger","chat"] }          — array
 * Optional: target_pos, plan, daily_cap, country
 *
 * Always returns { keywords: [...] }.
 */
router.post('/', (req, res) => {
  const { app_id, term, terms, target_pos = 10, plan = 'standard', daily_cap = 100, country } = req.body || {};
  if (!app_id) return res.status(400).json({ error: 'missing_fields' });
  const app = ownsApp(req.user.id, app_id);
  if (!app) return res.status(404).json({ error: 'app_not_found' });

  // Normalise terms list
  let rawList = [];
  if (Array.isArray(terms)) rawList = terms;
  else if (term) rawList = String(term).split(/[\n,;]+/);
  const list = rawList
    .map(s => String(s || '').trim())
    .filter(Boolean)
    .filter((v, i, a) => a.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i);

  if (!list.length) return res.status(400).json({ error: 'missing_fields' });

  // Per-app keyword limit
  const kwCount = db.prepare('SELECT COUNT(*) AS n FROM keywords WHERE app_id = ?').get(app_id).n;
  const remaining = LIMITS.maxKeywordsPerApp - kwCount;
  if (remaining <= 0) {
    return res.status(403).json({
      error: 'keywords_limit_reached',
      limit: LIMITS.maxKeywordsPerApp,
      message: `Лимит ${LIMITS.maxKeywordsPerApp} ключей на приложение. Удали ненужные или обратись к менеджеру.`,
    });
  }
  if (list.length > remaining) {
    list.length = remaining; // truncate, don't fail
  }

  const ctry = country || db.prepare('SELECT country FROM apps WHERE id = ?').get(app_id).country;
  // Skip terms that already exist for this app (case-insensitive)
  const existing = new Set(
    db.prepare('SELECT term FROM keywords WHERE app_id = ?').all(app_id)
      .map(r => r.term.toLowerCase())
  );
  const fresh = list.filter(t => !existing.has(t.toLowerCase()));

  const stmt = db.prepare(
    `INSERT INTO keywords (app_id, term, country, target_pos, plan, daily_cap, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const ids = [];
  const tx = db.transaction(() => {
    for (const t of fresh) {
      const r = stmt.run(app_id, t, ctry, +target_pos || 10, plan, +daily_cap || 100, now());
      ids.push(r.lastInsertRowid);
    }
  });
  tx();

  const created = ids.length
    ? db.prepare(`SELECT * FROM keywords WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids)
    : [];
  for (const kw of created) broadcast(req.user.id, 'keyword.created', kw);

  res.json({
    keywords: created,
    skipped: list.length - fresh.length,
  });
});

router.get('/by-app/:appId', (req, res) => {
  const app = ownsApp(req.user.id, req.params.appId);
  if (!app) return res.status(404).json({ error: 'not_found' });
  const rows = db.prepare(
    `SELECT k.*,
       COALESCE((SELECT SUM(count) FROM installs WHERE keyword_id = k.id), 0) AS total_installed,
       COALESCE((SELECT SUM(delivered) FROM installs WHERE keyword_id = k.id AND status = 'delivered'), 0) AS total_delivered,
       (SELECT status FROM installs WHERE keyword_id = k.id AND status IN ('scheduled','in_progress','delivered')
          ORDER BY date DESC LIMIT 1) AS last_order_status,
       (SELECT date FROM installs WHERE keyword_id = k.id AND status IN ('scheduled','in_progress','delivered')
          ORDER BY date DESC LIMIT 1) AS last_order_date
     FROM keywords k WHERE k.app_id = ? ORDER BY k.created_at DESC`
  ).all(app.id);
  res.json({ keywords: rows });
});

router.patch('/:id', (req, res) => {
  const kw = ownsKeyword(req.user.id, req.params.id);
  if (!kw) return res.status(404).json({ error: 'not_found' });
  const { target_pos, plan, daily_cap, status, term } = req.body || {};
  db.prepare(
    `UPDATE keywords SET
      target_pos = COALESCE(?, target_pos),
      plan = COALESCE(?, plan),
      daily_cap = COALESCE(?, daily_cap),
      status = COALESCE(?, status),
      term = COALESCE(?, term)
     WHERE id = ?`
  ).run(
    target_pos ?? null, plan ?? null, daily_cap ?? null, status ?? null, term ?? null, kw.id
  );
  const row = db.prepare('SELECT * FROM keywords WHERE id = ?').get(kw.id);
  broadcast(req.user.id, 'keyword.updated', row);
  res.json({ keyword: row });
});

router.delete('/:id', (req, res) => {
  const kw = ownsKeyword(req.user.id, req.params.id);
  if (!kw) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM keywords WHERE id = ?').run(kw.id);
  broadcast(req.user.id, 'keyword.deleted', { id: kw.id });
  res.json({ ok: true });
});

/** Position time-series for chart. */
router.get('/:id/positions', (req, res) => {
  const kw = ownsKeyword(req.user.id, req.params.id);
  if (!kw) return res.status(404).json({ error: 'not_found' });
  const days = Math.min(+req.query.days || 30, 180);
  const since = Date.now() - days * 86400_000;
  const rows = db.prepare(
    `SELECT position, checked_at FROM keyword_positions
     WHERE keyword_id = ? AND checked_at >= ? ORDER BY checked_at ASC`
  ).all(kw.id, since);
  res.json({ positions: rows });
});

/** Daily installs (used by chart + table). */
router.get('/:id/installs', (req, res) => {
  const kw = ownsKeyword(req.user.id, req.params.id);
  if (!kw) return res.status(404).json({ error: 'not_found' });
  const rows = db.prepare(
    `SELECT date, count, status, cost, delivered, deliver_at FROM installs WHERE keyword_id = ? ORDER BY date ASC`
  ).all(kw.id);
  res.json({ installs: rows });
});

/**
 * Manually order installs for a day. This deducts balance via a transaction.
 * Body: { date: "YYYY-MM-DD", count: number }
 */
router.post('/:id/installs', (req, res) => {
  const kw = ownsKeyword(req.user.id, req.params.id);
  if (!kw) return res.status(404).json({ error: 'not_found' });
  const { date, count } = req.body || {};
  if (!date || count == null) return res.status(400).json({ error: 'missing_fields' });
  const c = Math.max(0, parseInt(count, 10) || 0);

  // Daily anti-fraud cap: hard server-side cap regardless of balance.
  // Per-keyword daily_cap (set by user) wins if it's lower than global ceiling.
  const ceiling = Math.min(LIMITS.maxInstallsPerKwDay, kw.daily_cap || LIMITS.maxInstallsPerKwDay);
  if (c > ceiling) {
    return res.status(400).json({
      error: 'daily_cap_exceeded',
      cap: ceiling,
      message: `Лимит ${ceiling} установок в день на ключ. Это анти-фрод защита Apple — выше ставить рискованно.`,
    });
  }

  // Admin can set a custom per-install price for a client; it overrides the plan price.
  const u = db.prepare('SELECT custom_install_price FROM users WHERE id = ?').get(req.user.id);
  const price = priceFor({ plan: kw.plan, customPrice: u ? u.custom_install_price : null });
  const cost = installCost(c, price);

  // An order for this (keyword, day) may already exist. Once it's being worked
  // or delivered it's locked — you can't un-deliver installs. Only a still-
  // 'scheduled' day can be edited or cancelled, and money moves as a DELTA so
  // reducing/cancelling refunds the difference and editing never double-charges.
  const prev = db.prepare('SELECT count, cost, status FROM installs WHERE keyword_id = ? AND date = ?').get(kw.id, date);
  if (prev && prev.status !== 'scheduled') {
    return res.status(409).json({
      error: 'order_locked',
      status: prev.status,
      message: prev.status === 'delivered'
        ? 'Этот день уже доставлен — установки нельзя отменить или перенести.'
        : 'Этот день уже в работе — изменить его нельзя. Напишите в поддержку.',
    });
  }
  const prevCost = prev ? prev.cost : 0;
  const delta = +(cost - prevCost).toFixed(2);   // >0 charge more, <0 refund

  const balance = getBalance(req.user.id);
  if (delta > balance) return res.status(402).json({ error: 'insufficient_balance', balance });

  // Delivery lives inside the POOL DAY of the order: an order for tomorrow is
  // worked tomorrow and completes within that day (14:00–22:00 UTC), never
  // earlier than 3–8h after creation for same-day orders.
  const ts = now();
  const deliverAt = deliverAtFor(date, ts);
  const tx = db.transaction(() => {
    if (c > 0) {
      db.prepare(
        `INSERT INTO installs (keyword_id, date, count, status, cost, created_at, deliver_at)
         VALUES (?, ?, ?, 'scheduled', ?, ?, ?)
         ON CONFLICT(keyword_id, date) DO UPDATE SET
           count = excluded.count,
           cost  = excluded.cost,
           status = 'scheduled',
           deliver_at = excluded.deliver_at`
      ).run(kw.id, date, c, cost, ts, deliverAt);
    } else if (prev) {
      // Cancel: drop the scheduled row entirely so the day is free to re-plan.
      db.prepare('DELETE FROM installs WHERE keyword_id = ? AND date = ?').run(kw.id, date);
    }

    // Money delta: charge the extra, or refund what was released (cancel / reduce).
    if (delta > 0) {
      db.prepare(
        `INSERT INTO transactions (user_id, type, amount, status, description, ref_id, created_at)
         VALUES (?, 'spend', ?, 'done', ?, ?, ?)`
      ).run(req.user.id, -delta, `Установки «${kw.term}» × ${c} (${date})`, `kw:${kw.id}:${date}`, now());
    } else if (delta < 0) {
      const backCount = prev ? prev.count : 0;
      db.prepare(
        `INSERT INTO transactions (user_id, type, amount, status, description, ref_id, created_at)
         VALUES (?, 'refund', ?, 'done', ?, ?, ?)`
      ).run(req.user.id, -delta, c > 0
          ? `Возврат за изменение «${kw.term}» (${date}): ${backCount} → ${c}`
          : `Возврат за отмену «${kw.term}» × ${backCount} (${date})`,
        `kw:${kw.id}:${date}:refund:${ts}`, now());
    }
  });
  tx();

  const row = db.prepare('SELECT * FROM installs WHERE keyword_id = ? AND date = ?').get(kw.id, date);
  broadcast(req.user.id, 'install.scheduled', { keyword_id: kw.id, date, install: row || null });
  if (delta > 0) maybeEmailLowBalance(req.user.id);

  // Telegram notification (fire-and-forget)
  try {
    const userRow = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(req.user.id);
    const appRow  = db.prepare('SELECT id, name, country FROM apps WHERE id = ?').get(kw.app_id);
    if (c > 0) {
      notifyAdmin(tgInstallOrder({
        user: userRow, app: appRow, keyword: kw,
        date, count: c, cost, balance: getBalance(req.user.id),
      })).catch(() => {});
      audit(req, {
        userId: req.user.id, action: 'install.scheduled',
        meta: { keyword_id: kw.id, app_id: kw.app_id, date, count: c, cost },
      });
    } else {
      const refunded = delta < 0 ? +(-delta).toFixed(2) : 0;
      notifyAdmin(tgInstallCancelled({
        user: userRow, app: appRow, keyword: kw,
        date, refund: refunded, balance: getBalance(req.user.id),
      })).catch(() => {});
      audit(req, {
        userId: req.user.id, action: 'install.cancelled',
        meta: { keyword_id: kw.id, app_id: kw.app_id, date, refund: refunded },
      });
    }
  } catch {}

  res.json({ install: row, balance: getBalance(req.user.id) });
});

export default router;
