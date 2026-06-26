import { Router } from 'express';
import { db, getBalance, now, userInstallPrice, REFERRAL_RATE } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { broadcast } from '../sse.js';
import { notifyAdmin, tgTopupConfirmed } from '../services/telegram.js';
import { audit } from '../services/audit.js';
import { runBackup } from '../services/backup.js';
import { emailTopupConfirmed } from '../services/notifications.js';
import { runPositionDigest } from '../services/positionDigest.js';

const router = Router();

function requireAdmin(req, res, next) {
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (!u || u.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}

router.use(requireAuth, requireAdmin);

function tierName(dep) {
  return dep >= 50000 ? 'Enterprise' : dep >= 15000 ? 'Scale ($0.12)'
       : dep >= 5000 ? 'Volume ($0.20)' : 'Standard ($0.30)';
}

router.get('/users', (_req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.provider, u.telegram, u.created_at, u.last_login_at,
      u.blocked, u.custom_install_price,
      COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id = u.id AND status = 'done'), 0) AS balance,
      COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id = u.id AND status = 'done' AND type = 'topup' AND amount > 0), 0) AS total_deposited,
      (SELECT COUNT(*) FROM apps WHERE user_id = u.id) AS apps_count,
      (SELECT COUNT(*) FROM keywords k JOIN apps a ON a.id = k.app_id WHERE a.user_id = u.id) AS keywords_count,
      COALESCE((SELECT SUM(i.cost) FROM installs i JOIN keywords k ON k.id = i.keyword_id JOIN apps a ON a.id = k.app_id WHERE a.user_id = u.id), 0) AS spent_on_installs,
      u.ref_code, u.referred_by, u.ref_rate,
      (SELECT email FROM users ru WHERE ru.id = u.referred_by) AS referrer_email,
      (SELECT COUNT(*) FROM users cu WHERE cu.referred_by = u.id) AS referral_count,
      COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id = u.id AND type = 'referral' AND status = 'done'), 0) AS ref_earned
    FROM users u ORDER BY u.created_at DESC
  `).all();
  for (const r of rows) r.tariff = tierName(r.total_deposited);
  res.json({ users: rows, defaultRefRate: REFERRAL_RATE() });
});

/** Full detail for one client. */
router.get('/users/:id', (req, res) => {
  const u = db.prepare(`
    SELECT id, email, name, role, provider, telegram, avatar_url, blocked, custom_install_price,
           email_verified, created_at, last_login_at, ref_code, referred_by, ref_rate
    FROM users WHERE id = ?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  u.balance = getBalance(u.id);
  u.total_deposited = db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE user_id=? AND status='done' AND type='topup' AND amount>0`
  ).get(u.id).s;
  u.tariff = tierName(u.total_deposited);
  u.apps = db.prepare(`
    SELECT a.id, a.name, a.country, a.status, a.store, a.url,
      (SELECT COUNT(*) FROM keywords k WHERE k.app_id = a.id) AS keywords_count
    FROM apps a WHERE a.user_id = ? ORDER BY a.created_at DESC`).all(u.id);
  for (const app of u.apps) {
    app.keywords = db.prepare(
      `SELECT term, current_pos, target_pos, status FROM keywords
       WHERE app_id = ? ORDER BY (current_pos IS NULL), current_pos ASC LIMIT 50`
    ).all(app.id);
  }
  u.transactions = db.prepare(
    `SELECT id, type, amount, status, description, created_at FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 30`
  ).all(u.id);
  u.activity = db.prepare(
    `SELECT action, meta, ip, created_at FROM audit_log WHERE user_id=? ORDER BY created_at DESC LIMIT 30`
  ).all(u.id);
  u.orders = db.prepare(`
    SELECT i.id, i.date, i.count, i.delivered, i.cost, i.status, k.term AS keyword, a.name AS app_name
    FROM installs i JOIN keywords k ON k.id=i.keyword_id JOIN apps a ON a.id=k.app_id
    WHERE a.user_id=? ORDER BY i.created_at DESC LIMIT 30`).all(u.id);
  // Referral relationships: who referred this user + everyone they referred.
  u.referrer = u.referred_by
    ? db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(u.referred_by)
    : null;
  u.referred = db.prepare(
    `SELECT id, email, name, created_at FROM users WHERE referred_by = ? ORDER BY created_at DESC`
  ).all(u.id);
  u.ref_earned = db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE user_id=? AND type='referral' AND status='done'`
  ).get(u.id).s;
  u.default_ref_rate = REFERRAL_RATE();
  res.json({ user: u });
});

/** Update a client: blocked / custom_install_price / role. */
router.patch('/users/:id', (req, res) => {
  const u = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  const { blocked, custom_install_price, role, ref_rate } = req.body || {};

  if (blocked !== undefined) {
    db.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(blocked ? 1 : 0, u.id);
  }
  if (custom_install_price !== undefined) {
    const p = custom_install_price === null || custom_install_price === ''
      ? null : Math.max(0, parseFloat(custom_install_price));
    db.prepare('UPDATE users SET custom_install_price = ? WHERE id = ?').run(p, u.id);
  }
  if (role !== undefined && (role === 'admin' || role === 'user')) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
  }
  if (ref_rate !== undefined) {
    // null/'' resets to the global default; accept either a fraction (0.07) or a
    // percent the admin typed (7 → 0.07). Clamp to a sane 0–100% range.
    let rr = (ref_rate === null || ref_rate === '') ? null : parseFloat(ref_rate);
    if (rr != null && !Number.isNaN(rr)) { if (rr > 1) rr = rr / 100; rr = Math.max(0, Math.min(1, rr)); }
    else if (Number.isNaN(rr)) rr = null;
    db.prepare('UPDATE users SET ref_rate = ? WHERE id = ?').run(rr, u.id);
  }
  audit(req, { userId: u.id, actorId: req.user.id, action: 'admin.user_update', meta: { blocked, custom_install_price, role, ref_rate } });
  const row = db.prepare('SELECT id, blocked, custom_install_price, role, ref_rate FROM users WHERE id = ?').get(u.id);
  res.json({ ok: true, user: row });
});

// Permanently delete a user and everything tied to them. Guards: no self, no admins.
router.delete('/users/:id', (req, res) => {
  const u = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'cannot_delete_self' });
  if (u.role === 'admin') return res.status(400).json({ error: 'cannot_delete_admin' });

  const wipe = db.transaction((uid) => {
    const kwScope = `SELECT k.id FROM keywords k JOIN apps a ON a.id = k.app_id WHERE a.user_id = ?`;
    db.prepare(`DELETE FROM keyword_positions WHERE keyword_id IN (${kwScope})`).run(uid);
    db.prepare(`DELETE FROM installs          WHERE keyword_id IN (${kwScope})`).run(uid);
    db.prepare(`DELETE FROM keywords WHERE app_id IN (SELECT id FROM apps WHERE user_id = ?)`).run(uid);
    db.prepare(`DELETE FROM apps               WHERE user_id = ?`).run(uid);
    db.prepare(`DELETE FROM transactions       WHERE user_id = ?`).run(uid);
    db.prepare(`DELETE FROM email_verifications WHERE user_id = ?`).run(uid);
    db.prepare(`DELETE FROM password_resets    WHERE user_id = ?`).run(uid);
    db.prepare(`DELETE FROM users              WHERE id = ?`).run(uid);
  });
  wipe(u.id);
  audit(req, { userId: u.id, actorId: req.user.id, action: 'admin.user_delete', meta: { email: u.email } });
  res.json({ ok: true, deleted: u.id });
});

/**
 * Finance / P&L. Revenue is recognised on DELIVERED installs (pro-rated per
 * order), cost-of-goods = delivered × supplier cost. Supplier cost is applied
 * client-side so the admin can change it and recompute instantly; the server
 * returns raw delivered/revenue per client + totals. Optional ?from&to filter
 * by install date (YYYY-MM-DD).
 */
router.get('/finance', (req, res) => {
  const from = req.query.from || null;
  const to = req.query.to || null;
  const useDate = !!(from || to);
  const dateOn = useDate ? 'AND i.date BETWEEN ? AND ?' : '';
  const params = useDate ? [from || '0000-00-00', to || '9999-12-31'] : [];

  const clients = db.prepare(`
    SELECT u.id, u.email, u.name,
      COALESCE((SELECT SUM(amount) FROM transactions t
                WHERE t.user_id = u.id AND t.status = 'done' AND t.type = 'topup' AND t.amount > 0), 0) AS deposited,
      COALESCE(SUM(i.count), 0)     AS ordered,
      COALESCE(SUM(i.delivered), 0) AS delivered,
      COALESCE(SUM(i.cost), 0)      AS sold,
      COALESCE(SUM((CAST(i.delivered AS REAL) / NULLIF(i.count, 0)) * i.cost), 0) AS revenue
    FROM users u
    LEFT JOIN apps a     ON a.user_id = u.id
    LEFT JOIN keywords k ON k.app_id = a.id
    LEFT JOIN installs i ON i.keyword_id = k.id ${dateOn}
    GROUP BY u.id
    HAVING deposited > 0
    ORDER BY sold DESC, deposited DESC
  `).all(...params);

  const totals = clients.reduce((t, c) => ({
    deposited: t.deposited + c.deposited,
    ordered: t.ordered + c.ordered,
    delivered: t.delivered + c.delivered,
    sold: t.sold + c.sold,
    revenue: t.revenue + c.revenue,
  }), { deposited: 0, ordered: 0, delivered: 0, sold: 0, revenue: 0 });

  res.json({
    clients,
    totals,
    supplierCost: Number(process.env.SUPPLIER_COST_PER_INSTALL) || 0.04,
  });
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
  if (row.amount > 0) emailTopupConfirmed(tx.user_id, row.amount);

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

const COUNTRY_NAMES = {
  us: 'USA', gb: 'United Kingdom', uk: 'United Kingdom', ca: 'Canada', au: 'Australia',
  de: 'Germany', fr: 'France', it: 'Italy', es: 'Spain', nl: 'Netherlands', se: 'Sweden',
  no: 'Norway', fi: 'Finland', dk: 'Denmark', ie: 'Ireland', be: 'Belgium', ch: 'Switzerland',
  at: 'Austria', pt: 'Portugal', pl: 'Poland', cz: 'Czechia', ua: 'Ukraine', ru: 'Russia',
  tr: 'Turkey', br: 'Brazil', mx: 'Mexico', ar: 'Argentina', cl: 'Chile', co: 'Colombia',
  in: 'India', jp: 'Japan', kr: 'South Korea', cn: 'China', sg: 'Singapore', nz: 'New Zealand',
  sa: 'Saudi Arabia', ae: 'UAE', za: 'South Africa', id: 'Indonesia', my: 'Malaysia',
  vn: 'Vietnam', th: 'Thailand', ph: 'Philippines', hk: 'Hong Kong', tw: 'Taiwan',
};
const countryName = (c) => COUNTRY_NAMES[String(c || '').toLowerCase()] || String(c || '').toUpperCase();
const ddmmyyyy = (d) => { const [y, m, da] = String(d).split('-'); return `${da}.${m}.${y}`; };

/** CSV export in the supplier's matrix format:
 *  rows = app → country → keyword, columns = dates, cells = install count.
 *  Top: supported countries, date row, daily totals. ?status optional.
 */
router.get('/orders.csv', (req, res) => {
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null;
  const fromDate = req.query.from || null;
  const toDate   = req.query.to   || null;
  const where = [];
  const args = [];
  if (status)   { where.push('i.status = ?'); args.push(status); }
  if (fromDate) { where.push('i.date >= ?');  args.push(fromDate); }
  if (toDate)   { where.push('i.date <= ?');  args.push(toDate); }

  const rows = db.prepare(`
    SELECT i.date, i.count, k.term AS keyword,
           a.url AS app_url, a.name AS app_name, a.store, a.country
    FROM installs i
    JOIN keywords k ON k.id = i.keyword_id
    JOIN apps a     ON a.id = k.app_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.name ASC, a.country ASC, k.term ASC, i.date ASC
  `).all(...args);

  // Build the continuous date axis (min→max), capped to avoid runaway width.
  const present = [...new Set(rows.map(r => r.date))].filter(Boolean).sort();
  let dates = present;
  if (present.length) {
    const span = (new Date(present[present.length - 1]) - new Date(present[0])) / 86400000;
    if (span <= 92) {
      dates = [];
      const cur = new Date(present[0] + 'T00:00:00Z');
      const end = new Date(present[present.length - 1] + 'T00:00:00Z');
      while (cur <= end) { dates.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); }
    }
  }

  // Pivot: app(url) → country → keyword → { date: count }, plus per-day totals.
  const apps = new Map();
  const dayTotal = {};
  for (const r of rows) {
    const key = r.app_url || r.app_name || '—';
    if (!apps.has(key)) apps.set(key, { label: r.app_url || r.app_name, name: r.app_name, store: r.store, countries: new Map() });
    const app = apps.get(key);
    if (!app.countries.has(r.country || '')) app.countries.set(r.country || '', new Map());
    const kwMap = app.countries.get(r.country || '');
    if (!kwMap.has(r.keyword)) kwMap.set(r.keyword, {});
    kwMap.get(r.keyword)[r.date] = (kwMap.get(r.keyword)[r.date] || 0) + r.count;
    dayTotal[r.date] = (dayTotal[r.date] || 0) + r.count;
  }

  const csvCell = (v) => {
    if (v == null || v === '') return '';
    const s = String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const row = (cells) => cells.map(csvCell).join(',');

  const allCountries = [...new Set(rows.map(r => r.country))].map(countryName).sort();
  const lines = [];
  lines.push(row(['Supported Countries: ' + allCountries.join(', ')]));
  lines.push(row(['', ...dates.map(ddmmyyyy)]));
  lines.push(row(['Σ / day', ...dates.map(d => dayTotal[d] || 0)]));
  lines.push(row(['']));
  for (const [, app] of [...apps].sort((a, b) => String(a[1].name).localeCompare(String(b[1].name)))) {
    lines.push(row([app.label]));
    const countries = [...app.countries].sort((a, b) => countryName(a[0]).localeCompare(countryName(b[0])));
    for (const [cc, kwMap] of countries) {
      lines.push(row([countryName(cc)]));
      const kws = [...kwMap].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      for (const [term, dMap] of kws) {
        lines.push(row([term, ...dates.map(d => dMap[d] || '')]));
      }
    }
    lines.push(row(['']));
  }

  const csv = '﻿' + lines.join('\n');   // BOM for Excel
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="maya-supplier-${status || 'all'}-${new Date().toISOString().slice(0, 10)}.csv"`);
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

  let refPayout = null; // { userId, amount }
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

    // Referral payout: when installs are actually delivered, credit the buyer's
    // referrer with a % of the delivered COUNT, valued at the REFERRER's price.
    if ((status === 'delivered' || status === 'partial') && deliveredCount > 0) {
      const buyer = db.prepare('SELECT referred_by FROM users WHERE id = ?').get(order.user_id);
      const already = db.prepare(`SELECT 1 FROM transactions WHERE ref_id = ? AND type = 'referral'`).get(`ref:${order.id}`);
      if (buyer && buyer.referred_by && !already) {
        // Use the referrer's manual ref_rate if set, otherwise the global default.
        const refRow = db.prepare('SELECT ref_rate FROM users WHERE id = ?').get(buyer.referred_by);
        const rate = (refRow && refRow.ref_rate != null) ? refRow.ref_rate : REFERRAL_RATE();
        const reward = +(deliveredCount * rate * userInstallPrice(buyer.referred_by)).toFixed(2);
        if (reward > 0) {
          db.prepare(
            `INSERT INTO transactions (user_id, type, amount, status, description, ref_id, created_at)
             VALUES (?, 'referral', ?, 'done', ?, ?, ?)`
          ).run(buyer.referred_by, reward,
            `Реферальный бонус: ${deliveredCount} установок · ${Math.round(rate * 100)}% по вашему тарифу`,
            `ref:${order.id}`, now());
          refPayout = { userId: buyer.referred_by, amount: reward };
        }
      }
    }
  });
  tx();

  if (refPayout) {
    broadcast(refPayout.userId, 'transaction.created', { kind: 'referral', amount: refPayout.amount });
    broadcast(refPayout.userId, 'balance.updated', { balance: getBalance(refPayout.userId) });
  }

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

/** Trigger an on-demand DB backup. Returns the file path on the server. */
router.post('/backup', async (req, res) => {
  try {
    const r = await runBackup();
    audit(req, { actorId: req.user.id, action: 'admin.backup', meta: { path: r.path } });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: 'backup_failed', message: e.message });
  }
});

// Manually trigger the position-rise digest (the cron runs it every 3 days).
router.post('/run-digest', async (req, res) => {
  try {
    const r = await runPositionDigest();
    audit(req, { actorId: req.user.id, action: 'admin.run_digest', meta: r });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: 'digest_failed', message: e.message });
  }
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
