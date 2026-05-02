import { Router } from 'express';
import { db, now, getBalance } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { broadcast } from '../sse.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const limit = Math.min(+req.query.limit || 100, 500);
  const rows = db.prepare(
    `SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(req.user.id, limit);
  res.json({ transactions: rows, balance: getBalance(req.user.id) });
});

/** Top-up request (pending — confirmed by manager via /confirm). */
router.post('/topup', (req, res) => {
  const { amount, method } = req.body || {};
  const a = Math.max(0, parseFloat(amount) || 0);
  if (a <= 0) return res.status(400).json({ error: 'bad_amount' });
  const info = db.prepare(
    `INSERT INTO transactions (user_id, type, amount, status, description, created_at)
     VALUES (?, 'topup', ?, 'pending', ?, ?)`
  ).run(req.user.id, a, `Пополнение через ${method || 'manager'}`, now());
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(info.lastInsertRowid);
  broadcast(req.user.id, 'transaction.created', row);
  res.json({ transaction: row });
});

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
  res.json({ transaction: row, balance: getBalance(req.user.id) });
});

export default router;
