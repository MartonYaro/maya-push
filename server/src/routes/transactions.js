import { Router } from 'express';
import { db, now, getBalance } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { broadcast } from '../sse.js';
import { notifyAdmin, tgNewTopup, tgTopupConfirmed } from '../services/telegram.js';
import { audit } from '../services/audit.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { nowpayments } from '../services/nowpayments.js';

const router = Router();
router.use(requireAuth);

// Absolute, public base URL for callbacks/redirects (app host preferred).
function publicBase() {
  if (process.env.APP_PUBLIC_URL) return process.env.APP_PUBLIC_URL.replace(/\/$/, '');
  if (process.env.APP_HOST) return `https://${process.env.APP_HOST}`;
  return (process.env.PUBLIC_URL || '').replace(/\/$/, '');
}

router.get('/', (req, res) => {
  const limit = Math.min(+req.query.limit || 100, 500);
  const rows = db.prepare(
    `SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(req.user.id, limit);
  res.json({ transactions: rows, balance: getBalance(req.user.id) });
});

/**
 * Top-up request. Goes into status='pending' and waits for manager confirmation.
 * Body: { amount, method?, comment? }
 * Rate-limited: 10 per hour per user.
 */
router.post('/topup',
  rateLimit({ windowMs: 60 * 60_000, max: 10, keyName: 'user' }),
  async (req, res) => {
    const { amount, method, comment, telegram } = req.body || {};
    const a = Math.max(0, parseFloat(amount) || 0);
    if (a <= 0) return res.status(400).json({ error: 'invalid_amount' });
    if (a > 1_000_000) return res.status(400).json({ error: 'max_topup_exceeded' });

    // Require a Telegram contact — manager DMs the user with payment details
    let userRow = db.prepare('SELECT id, email, name, telegram FROM users WHERE id = ?').get(req.user.id);
    if (telegram) {
      let tg = String(telegram).trim().replace(/^@/, '').replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '');
      if (!/^[a-zA-Z0-9_]{4,32}$/.test(tg)) {
        return res.status(400).json({ error: 'invalid_telegram' });
      }
      if (tg !== userRow.telegram) {
        db.prepare('UPDATE users SET telegram = ? WHERE id = ?').run(tg, req.user.id);
        userRow = { ...userRow, telegram: tg };
      }
    }
    if (!userRow.telegram) {
      return res.status(400).json({ error: 'telegram_required' });
    }

    const desc = comment
      ? `Пополнение через ${method || 'manager'} — ${String(comment).slice(0, 200)}`
      : `Пополнение через ${method || 'manager'}`;

    const info = db.prepare(
      `INSERT INTO transactions (user_id, type, amount, status, description, created_at)
       VALUES (?, 'topup', ?, 'pending', ?, ?)`
    ).run(req.user.id, a, desc, now());
    const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(info.lastInsertRowid);
    broadcast(req.user.id, 'transaction.created', row);

    // Telegram notify (fire-and-forget)
    try {
      notifyAdmin(tgNewTopup({
        user: userRow, amount: a, method, comment, txId: row.id,
      })).catch(() => {});
      audit(req, {
        userId: req.user.id, action: 'transaction.topup_requested',
        meta: { tx_id: row.id, amount: a, method },
      });
    } catch {}

    res.json({ transaction: row });
  }
);

/**
 * Crypto top-up via NOWPayments. Creates a pending transaction and a hosted
 * invoice; the balance is credited only when the IPN webhook reports success.
 * Body: { amount }. Returns { invoice_url } to redirect the user to.
 */
router.post('/crypto',
  rateLimit({ windowMs: 60 * 60_000, max: 20, keyName: 'user' }),
  async (req, res) => {
    if (!nowpayments.isConfigured) return res.status(503).json({ error: 'crypto_unavailable' });
    const a = Math.max(0, parseFloat((req.body || {}).amount) || 0);
    if (a <= 0) return res.status(400).json({ error: 'invalid_amount' });
    if (a > 1_000_000) return res.status(400).json({ error: 'max_topup_exceeded' });

    const info = db.prepare(
      `INSERT INTO transactions (user_id, type, amount, status, description, created_at)
       VALUES (?, 'topup', ?, 'pending', ?, ?)`
    ).run(req.user.id, a, 'Crypto top-up (NOWPayments)', now());
    const txId = info.lastInsertRowid;

    try {
      const base = publicBase();
      const inv = await nowpayments.createInvoice({
        amount: a,
        orderId: `maya_${txId}`,
        description: `MAYA Push top-up #${txId}`,
        ipnUrl: `${base}/api/payments/nowpayments/ipn`,
        successUrl: `${base}/dashboard#billing`,
        cancelUrl: `${base}/dashboard#billing`,
      });
      db.prepare('UPDATE transactions SET description = ? WHERE id = ?')
        .run(`Crypto top-up (NOWPayments) · invoice ${inv.id}`, txId);
      const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
      broadcast(req.user.id, 'transaction.created', row);
      audit(req, { userId: req.user.id, action: 'transaction.crypto_invoice', meta: { tx_id: txId, amount: a, invoice: inv.id } });
      res.json({ invoice_url: inv.invoice_url, transaction: row });
    } catch (e) {
      // Roll back the placeholder so we don't leave a dangling pending row.
      db.prepare("DELETE FROM transactions WHERE id = ? AND status = 'pending'").run(txId);
      res.status(502).json({ error: 'crypto_create_failed' });
    }
  }
);

/** Demo confirm endpoint — in real life manager triggers from admin panel. */
router.post('/:id/confirm', (req, res) => {
  const tx = db.prepare(
    'SELECT * FROM transactions WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!tx) return res.status(404).json({ error: 'not_found' });
  if (tx.status !== 'pending') return res.status(400).json({ error: 'not_pending' });
  db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('done', tx.id);
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
  broadcast(req.user.id, 'transaction.updated', row);

  // Notify admin chat that topup was confirmed (helpful for ops audit)
  try {
    const userRow = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(req.user.id);
    notifyAdmin(tgTopupConfirmed({
      user: userRow, amount: row.amount, txId: row.id, balance: getBalance(req.user.id),
    })).catch(() => {});
    audit(req, {
      userId: req.user.id, action: 'transaction.confirmed',
      meta: { tx_id: row.id, amount: row.amount },
    });
  } catch {}

  res.json({ transaction: row, balance: getBalance(req.user.id) });
});

export default router;
