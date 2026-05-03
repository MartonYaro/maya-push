import { Router } from 'express';
import { db, getBalance, now } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { broadcast } from '../sse.js';
import { notifyAdmin, tgTopupConfirmed } from '../services/telegram.js';
import { audit } from '../services/audit.js';

const router = Router();

function requireAdmin(req, res, next) {
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (!u || u.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}

router.use(requireAuth, requireAdmin);

router.get('/users', (_req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.created_at,
      COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id = u.id AND status = 'done'), 0) AS balance,
      (SELECT COUNT(*) FROM apps WHERE user_id = u.id) AS apps_count
    FROM users u ORDER BY u.created_at DESC
  `).all();
  res.json({ users: rows });
});

router.get('/transactions', (req, res) => {
  const status = req.query.status || null;
  const sql = status
    ? `SELECT t.*, u.email, u.name FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.status = ? ORDER BY t.created_at DESC LIMIT 200`
    : `SELECT t.*, u.email, u.name FROM transactions t JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC LIMIT 200`;
  const rows = status ? db.prepare(sql).all(status) : db.prepare(sql).all();
  res.json({ transactions: rows });
});

router.post('/transactions/:id/confirm', (req, res) => {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'not_found' });
  if (tx.status !== 'pending') return res.status(400).json({ error: 'not_pending' });
  db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('done', tx.id);
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
  broadcast(tx.user_id, 'transaction.updated', row);

  try {
    const userRow = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(tx.user_id);
    notifyAdmin(tgTopupConfirmed({
      user: userRow, amount: row.amount, txId: row.id, balance: getBalance(tx.user_id),
    })).catch(() => {});
    audit(req, {
      userId: tx.user_id, actorId: req.user.id, action: 'admin.tx_confirm',
      meta: { tx_id: row.id, amount: row.amount },
    });
  } catch {}

  res.json({ transaction: row, balance: getBalance(tx.user_id) });
});

router.post('/transactions/:id/reject', (req, res) => {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'not_found' });
  if (tx.status !== 'pending') return res.status(400).json({ error: 'not_pending' });
  db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('rejected', tx.id);
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
  broadcast(tx.user_id, 'transaction.updated', row);

  try {
    audit(req, {
      userId: tx.user_id, actorId: req.user.id, action: 'admin.tx_reject',
      meta: { tx_id: row.id, amount: row.amount },
    });
  } catch {}

  res.json({ transaction: row });
});

/** Audit log — last N events, optional filter by user_id / action. */
router.get('/audit-log', (req, res) => {
  const userId = req.query.user_id || null;
  const action = req.query.action || null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const where = [];
  const args = [];
  if (userId) { where.push('a.user_id = ?'); args.push(userId); }
  if (action) { where.push('a.action = ?'); args.push(action); }
  const sql = `
    SELECT a.id, a.user_id, a.actor_id, a.action, a.meta, a.ip, a.user_agent, a.created_at,
           u.email, u.name
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.created_at DESC
    LIMIT ?`;
  args.push(limit);
  const rows = db.prepare(sql).all(...args);
  res.json({ events: rows });
});

/* ─────────────── ORDERS (install jobs) ───────────────
 * Statuses lifecycle:
 *   scheduled   — user paid, waiting to be picked up by supplier
 *   in_progress — sent to supplier (Chinese sheet)
 *   delivered   — done, delivered_count == count
 *   partial     — done, delivered_count <  count (auto-refund difference)
 *   failed      — supplier failed, full refund
 *   cancelled   — user cancelled before supply
 */

router.get('/orders', (req, res) => {
  const status = req.query.status || null;
  const fromDate = req.query.from || null;   // YYYY-MM-DD
  const toDate   = req.query.to   || null;
  const where = [];
  const args = [];
  if (status)   { where.push('i.status = ?'); args.push(status); }
  if (fromDate) { where.push('i.date >= ?');  args.push(fromDate); }
  if (toDate)   { where.push('i.date <= ?');  args.push(toDate); }

  const rows = db.prepare(`
    SELECT i.id, i.keyword_id, i.date, i.count, i.delivered, i.cost, i.status,
           i.note, i.created_at, i.updated_at,
           k.term      AS keyword,
           k.plan      AS plan,
           a.id        AS app_id,
           a.name      AS app_name,
           a.url       AS app_url,
           a.store_id  AS store_id,
           a.country   AS country,
           u.id        AS user_id,
           u.email     AS user_email,
           u.name      AS user_name
    FROM installs i
    JOIN keywords k ON k.id = i.keyword_id
    JOIN apps a     ON a.id = k.app_id
    JOIN users u    ON u.id = a.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY i.date ASC, i.created_at ASC
    LIMIT 1000
  `).all(...args);
  res.json({ orders: rows });
});

/** CSV export tailored for the supplier sheet.
 *  Columns: date, country, app_url, store_id, keyword, count, plan, order_id
 */
router.get('/orders.csv', (req, res) => {
  const status = req.query.status || 'scheduled';
  const fromDate = req.query.from || null;
  const toDate   = req.query.to   || null;
  const where = ['i.status = ?'];
  const args = [status];
  if (fromDate) { where.push('i.date >= ?'); args.push(fromDate); }
  if (toDate)   { where.push('i.date <= ?'); args.push(toDate); }

  const rows = db.prepare(`
    SELECT i.id, i.date, i.count, k.term AS keyword, k.plan,
           a.url AS app_url, a.store_id, a.country, a.name AS app_name
    FROM installs i
    JOIN keywords k ON k.id = i.keyword_id
    JOIN apps a     ON a.id = k.app_id
    WHERE ${where.join(' AND ')}
    ORDER BY i.date ASC, a.country ASC, k.term ASC
  `).all(...args);

  function csvCell(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const header = ['order_id','date','country','app_name','app_url','store_id','keyword','count','plan'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.id, r.date, (r.country || '').toUpperCase(), r.app_name,
      r.app_url, r.store_id, r.keyword, r.count, r.plan,
    ].map(csvCell).join(','));
  }
  const csv = '﻿' + lines.join('\n');   // BOM for Excel
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="maya-orders-${status}-${Date.now()}.csv"`);
  res.send(csv);
});

/** Update order status (manual operator action).
 *  Body: { status, delivered?, note? }
 *  - status = 'in_progress' : just mark as sent to supplier
 *  - status = 'delivered'   : mark fully delivered
 *  - status = 'partial'     : delivered = N, refund (count - N) * unit_price
 *  - status = 'failed'      : full refund
 *  - status = 'cancelled'   : full refund (only if not yet in_progress)
 */
router.post('/orders/:id/status', (req, res) => {
  const order = db.prepare(`
    SELECT i.*, k.app_id, a.user_id, k.plan, k.term, a.name AS app_name, a.country
    FROM installs i
    JOIN keywords k ON k.id = i.keyword_id
    JOIN apps a     ON a.id = k.app_id
    WHERE i.id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'not_found' });

  const { status, delivered, note } = req.body || {};
  const validStatuses = ['scheduled', 'in_progress', 'delivered', 'partial', 'failed', 'cancelled'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'bad_status' });

  // Compute refund (positive number = how much to credit back)
  let refund = 0;
  let deliveredCount = order.delivered || 0;
  if (status === 'delivered') {
    deliveredCount = order.count;
  } else if (status === 'partial') {
    deliveredCount = Math.max(0, Math.min(parseInt(delivered, 10) || 0, order.count));
    const undelivered = order.count - deliveredCount;
    refund = +(undelivered / order.count * order.cost).toFixed(2);
  } else if (status === 'failed' || status === 'cancelled') {
    deliveredCount = 0;
    // Refund whatever wasn't already refunded
    const already = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS bal FROM transactions
       WHERE user_id = ? AND ref_id = ? AND type = 'topup' AND status = 'done'`
    ).get(order.user_id, `refund:${order.id}`).bal || 0;
    refund = +(order.cost - already).toFixed(2);
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE installs
         SET status = ?, delivered = ?, note = COALESCE(?, note), updated_at = ?
       WHERE id = ?`
    ).run(status, deliveredCount, note ?? null, now(), order.id);

    if (refund > 0) {
      db.prepare(
        `INSERT INTO transactions (user_id, type, amount, status, description, ref_id, created_at)
         VALUES (?, 'topup', ?, 'done', ?, ?, ?)`
      ).run(
        order.user_id,
        refund,
        `Возврат: ${order.term} · ${order.date} · ${status === 'partial' ? 'частичная доставка' : (status === 'failed' ? 'не доставлено' : 'отмена')}`,
        `refund:${order.id}`,
        now()
      );
    }
  });
  tx();

  const fresh = db.prepare('SELECT * FROM installs WHERE id = ?').get(order.id);
  broadcast(order.user_id, 'install.updated', fresh);
  if (refund > 0) {
    broadcast(order.user_id, 'transaction.created', {
      kind: 'refund', amount: refund, install_id: order.id,
    });
  }
  audit(req, {
    userId: order.user_id, actorId: req.user.id, action: 'admin.order_status',
    meta: { order_id: order.id, status, delivered: deliveredCount, refund },
  });

  res.json({ order: fresh, refund, balance: getBalance(order.user_id) });
});

/** Bulk: mark all `scheduled` orders matching filter as `in_progress`.
 *  Use after exporting CSV to supplier. */
router.post('/orders/mark-in-progress', (req, res) => {
  const { ids, from, to } = req.body || {};
  let rows;
  if (Array.isArray(ids) && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    rows = db.prepare(
      `SELECT id, keyword_id FROM installs WHERE status = 'scheduled' AND id IN (${placeholders})`
    ).all(...ids);
  } else {
    const where = ["status = 'scheduled'"];
    const args = [];
    if (from) { where.push('date >= ?'); args.push(from); }
    if (to)   { where.push('date <= ?'); args.push(to); }
    rows = db.prepare(`SELECT id, keyword_id FROM installs WHERE ${where.join(' AND ')}`).all(...args);
  }
  const ts = now();
  const upd = db.prepare(`UPDATE installs SET status = 'in_progress', updated_at = ? WHERE id = ?`);
  const tx = db.transaction(() => { for (const r of rows) upd.run(ts, r.id); });
  tx();
  audit(req, {
    userId: null, actorId: req.user.id, action: 'admin.orders_dispatched',
    meta: { count: rows.length },
  });
  res.json({ updated: rows.length });
});

/** Manual credit/debit by admin. Body: { user_id, amount, description } */
router.post('/credit', (req, res) => {
  const { user_id, amount, description } = req.body || {};
  if (!user_id || !amount) return res.status(400).json({ error: 'missing_fields' });
  const a = parseFloat(amount);
  db.prepare(
    `INSERT INTO transactions (user_id, type, amount, status, description, created_at)
     VALUES (?, ?, ?, 'done', ?, ?)`
  ).run(user_id, a > 0 ? 'topup' : 'spend', a, description || 'Manual adjustment by admin', now());
  res.json({ ok: true, balance: getBalance(user_id) });
});

export default router;
