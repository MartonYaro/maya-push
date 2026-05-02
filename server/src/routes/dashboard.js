import { Router } from 'express';
import { db, getBalance } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { runPositionTick } from '../services/positionWorker.js';

const router = Router();
router.use(requireAuth);

router.get('/summary', (req, res) => {
  const uid = req.user.id;
  const apps = db.prepare(
    `SELECT id, name, status FROM apps WHERE user_id = ?`
  ).all(uid);

  const appIds = apps.map(a => a.id);
  let totalKeywords = 0, totalInstalls = 0;
  if (appIds.length) {
    const placeholders = appIds.map(() => '?').join(',');
    totalKeywords = db.prepare(
      `SELECT COUNT(*) AS c FROM keywords WHERE app_id IN (${placeholders})`
    ).get(...appIds).c;
    totalInstalls = db.prepare(
      `SELECT COALESCE(SUM(count), 0) AS c FROM installs
       WHERE keyword_id IN (SELECT id FROM keywords WHERE app_id IN (${placeholders}))`
    ).get(...appIds).c;
  }

  const recentTx = db.prepare(
    `SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`
  ).all(uid);

  res.json({
    apps_count: apps.length,
    active_apps: apps.filter(a => a.status === 'active').length,
    keywords_count: totalKeywords,
    installs_total: totalInstalls,
    balance: getBalance(uid),
    recent_transactions: recentTx,
  });
});

/** Manual trigger of position tick — handy for ops & smoke tests. */
router.post('/tick', async (req, res) => {
  const out = await runPositionTick();
  res.json(out);
});

export default router;
