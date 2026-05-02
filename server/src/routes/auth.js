import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, now, getBalance } from '../db.js';
import { signToken, requireAuth } from '../middleware/auth.js';

const router = Router();

router.post('/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'password_too_short' });
  const norm = String(email).trim().toLowerCase();
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(norm);
  if (exists) return res.status(409).json({ error: 'email_taken' });

  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare(
    `INSERT INTO users (email, password_hash, name, created_at) VALUES (?, ?, ?, ?)`
  ).run(norm, hash, String(name).trim(), now());

  const user = { id: info.lastInsertRowid, email: norm, name: String(name).trim() };
  db.prepare(
    `INSERT INTO transactions (user_id, type, amount, status, description, created_at)
     VALUES (?, 'system', 0, 'done', 'Регистрация аккаунта', ?)`
  ).run(user.id, now());

  const token = signToken(user);
  res.json({ token, user });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
  const norm = String(email).trim().toLowerCase();
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(norm);
  if (!row) return res.status(401).json({ error: 'invalid_credentials' });
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const user = { id: row.id, email: row.email, name: row.name };
  const token = signToken(user);
  res.json({ token, user });
});

router.get('/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?')
    .get(req.user.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json({ user: row, balance: getBalance(row.id) });
});

export default router;
