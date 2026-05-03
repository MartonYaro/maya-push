import { Router } from 'express';
import { db, now, getBalance } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { broadcast } from '../sse.js';
import { notifyAdmin, tgNewTopup, tgTopupConfirmed } from '../services/telegram.js';
import { audit } from '../services/audit.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();
router.use(requireAuth);

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
    const { amount, method, comment } = req.body || {};
    const a = Math.max(0, parseFloat(amount) || 0);
    if (a < 1500) return res.status(400).json({ error: 'min_topup_1500' });
    if (a > 1_000_000) return res.status(400).json({ error: 'max_topup_exceeded' });

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
      const userRow = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(req.user.id);
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
