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

  // Lifetime confirmed deposits — drives the pricing-tier progress bar.
  const totalDeposited = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
      WHERE user_id = ? AND type = 'topup' AND status = 'done' AND amount > 0`
  ).get(uid).s;

  res.json({
    apps_count: apps.length,
    active_apps: apps.filter(a => a.status === 'active').length,
    keywords_count: totalKeywords,
    installs_total: totalInstalls,
    balance: getBalance(uid),
    total_deposited: totalDeposited,
    recent_transactions: recentTx,
  });
});

/**
 * Store Pulse — a platform-wide trust widget for the dashboard home. Global
 * (same for every client, anonymised), computed from the position history.
 * Cached 5 min. Shows: apps grown today, anonymous top climber, per-store
 * status (active / slowed / frozen) with freshness, and an install-elasticity
 * reference. No app or keyword names are ever returned.
 */
let _pulseCache = { at: 0, data: null };
// Installs needed per +1 rank by keyword popularity — derived from the supplier
// outcome dataset (see analysis). Becomes dynamic once xlsx ingestion ships.
const ELASTICITY = [
  { band: 'low',     per: 7 },
  { band: 'mid_low', per: 14 },
  { band: 'mid',     per: 24 },
  { band: 'high',    per: 49 },
];
router.get('/store-pulse', (req, res) => {
  const nowMs = Date.now();
  if (_pulseCache.data && nowMs - _pulseCache.at < 5 * 60_000) return res.json(_pulseCache.data);

  const dayAgo = nowMs - 24 * 3600_000;
  const rows = db.prepare(`
    SELECT k.id AS kw, k.app_id AS app, a.store AS store,
      (SELECT position   FROM keyword_positions WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1) AS cur,
      (SELECT checked_at FROM keyword_positions WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1) AS cur_at,
      (SELECT position   FROM keyword_positions WHERE keyword_id = k.id AND checked_at <= ? ORDER BY checked_at DESC LIMIT 1) AS base
    FROM keywords k JOIN apps a ON a.id = k.app_id
    WHERE k.status = 'active'
      AND EXISTS (SELECT 1 FROM keyword_positions p WHERE p.keyword_id = k.id AND p.checked_at > ?)
  `).all(dayAgo, nowMs - 3 * 24 * 3600_000);

  const appNet = new Map();            // app_id → net improvement
  let up = 0, down = 0, best = null;
  const store = { appstore: { fresh: 0, moved: 0, total: 0 }, googleplay: { fresh: 0, moved: 0, total: 0 } };

  for (const r of rows) {
    const st = store[r.store] || store.appstore;
    if (r.cur_at && r.cur_at > st.fresh) st.fresh = r.cur_at;
    if (r.cur != null && r.base != null) {
      st.total++;
      const delta = r.base - r.cur;        // >0 = climbed (lower rank number is better)
      if (delta !== 0) st.moved++;
      if (delta > 0) up++; else if (delta < 0) down++;
      appNet.set(r.app, (appNet.get(r.app) || 0) + delta);
      if (delta > 0 && (!best || delta > best.delta)) best = { delta, from: r.base, to: r.cur };
    }
  }

  const appsTotal = appNet.size;
  const appsGrown = [...appNet.values()].filter(v => v > 0).length;

  function statusOf(s) {
    if (!s.fresh || s.fresh < nowMs - 18 * 3600_000) return 'stale';   // our tracker lagging
    const rate = s.total ? s.moved / s.total : 0;
    if (rate < 0.05) return 'frozen';                                   // checked, but nothing re-ranks
    if (rate < 0.15) return 'slowed';
    return 'active';
  }

  const out = {
    ready: appsTotal > 0,
    apps_total: appsTotal,
    apps_grown: appsGrown,
    keywords_up: up,
    keywords_down: down,
    top_climber: best,                 // anonymous: { delta, from, to } or null
    stores: {
      appstore:   { status: statusOf(store.appstore),   last_check: store.appstore.fresh || null },
      googleplay: { status: statusOf(store.googleplay), last_check: store.googleplay.fresh || null },
    },
    elasticity: ELASTICITY,
    generated_at: nowMs,
  };
  _pulseCache = { at: nowMs, data: out };
  res.json(out);
});

/** Manual trigger of position tick — handy for ops & smoke tests. */
router.post('/tick', async (req, res) => {
  const out = await runPositionTick();
  res.json(out);
});

export default router;
