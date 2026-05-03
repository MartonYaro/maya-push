import { Router } from 'express';
import { db, now, getBalance } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { broadcast } from '../sse.js';

const router = Router();
router.use(requireAuth);

const PRICE_PER_INSTALL = { standard: 0.35, fast: 0.55, premium: 0.85 };

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
    `SELECT k.*, COALESCE((SELECT SUM(count) FROM installs WHERE keyword_id = k.id), 0) AS total_installed
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
    `SELECT date, count, status, cost FROM installs WHERE keyword_id = ? ORDER BY date ASC`
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
  const price = PRICE_PER_INSTALL[kw.plan] || PRICE_PER_INSTALL.standard;
  const cost = +(c * price).toFixed(2);

  const balance = getBalance(req.user.id);
  if (cost > balance) return res.status(402).json({ error: 'insufficient_balance', balance });

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO installs (keyword_id, date, count, status, cost, created_at)
       VALUES (?, ?, ?, 'scheduled', ?, ?)
       ON CONFLICT(keyword_id, date) DO UPDATE SET
         count = excluded.count,
         cost  = excluded.cost,
         status = 'scheduled'`
    ).run(kw.id, date, c, cost, now());

    if (cost > 0) {
      db.prepare(
        `INSERT INTO transactions (user_id, type, amount, status, description, ref_id, created_at)
         VALUES (?, 'spend', ?, 'done', ?, ?, ?)`
      ).run(req.user.id, -cost, `Установки «${kw.term}» × ${c} (${date})`, `kw:${kw.id}:${date}`, now());
    }
  });
  tx();

  const row = db.prepare('SELECT * FROM installs WHERE keyword_id = ? AND date = ?').get(kw.id, date);
  broadcast(req.user.id, 'install.scheduled', { keyword_id: kw.id, install: row });
  res.json({ install: row, balance: getBalance(req.user.id) });
});

export default router;
