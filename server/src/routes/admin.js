import { Router } from 'express';
import { db, getBalance, now } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { broadcast } from '../sse.js';

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
  res.json({ transaction: row, balance: getBalance(tx.user_id) });
});

router.post('/transactions/:id/reject', (req, res) => {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'not_found' });
  if (tx.status !== 'pending') return res.status(400).json({ error: 'not_pending' });
  db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('rejected', tx.id);
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
  broadcast(tx.user_id, 'transaction.updated', row);
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
