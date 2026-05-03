import { Router } from 'express';
import { db, now } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { appTweak, parseAppleAppId } from '../services/apptweak.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM apps WHERE user_id = ? ORDER BY created_at DESC`
  ).all(req.user.id);
  res.json({ apps: rows });
});

/**
 * Create app.
 * Body: { url | store_id, country?, keywords?: string[] }
 *  - Metadata, rating, developer, category, icon — pulled from AppTweak.
 *  - If `keywords` array given, they are inserted and their current ranks
 *    are fetched immediately in one bulk call.
 */
router.post('/', async (req, res) => {
  const { url, store_id, country = 'us', keywords = [] } = req.body || {};
  const appleId = parseAppleAppId(store_id || url);
  if (!appleId) return res.status(400).json({ error: 'invalid_app_id' });

  const meta = await appTweak.fetchAppMetadata(appleId, country).catch(() => null);
  if (!meta) {
    return res.status(404).json({
      error: 'app_not_found_in_apptweak',
      hint: 'Проверьте URL приложения и страну',
    });
  }

  const info = db.prepare(
    `INSERT INTO apps (user_id, store_id, bundle_id, name, icon_url, category, country, url,
                       rating, rating_count, developer, subtitle, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.user.id, meta.store_id, meta.bundle_id, meta.name, meta.icon_url, meta.category,
    country, url || null, meta.rating, meta.rating_count, meta.developer, meta.subtitle, now()
  );
  const appId = info.lastInsertRowid;

  // Bulk-create keywords + fetch ranks once.
  const cleanKeywords = (Array.isArray(keywords) ? keywords : [])
    .map(k => String(k || '').trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);

  let ranksMap = {};
  if (cleanKeywords.length) {
    ranksMap = await appTweak.fetchKeywordPositionsBulk(meta.store_id, cleanKeywords, country)
      .catch(() => ({}));
    const insKw = db.prepare(
      `INSERT INTO keywords (app_id, term, country, target_pos, created_at, current_pos, last_checked_at)
       VALUES (?, ?, ?, 10, ?, ?, ?)`
    );
    const insPos = db.prepare(
      `INSERT INTO keyword_positions (keyword_id, position, checked_at, source) VALUES (?, ?, ?, 'apptweak')`
    );
    const ts = now();
    const tx = db.transaction(() => {
      for (const term of cleanKeywords) {
        const pos = ranksMap[term] ?? null;
        const r = insKw.run(appId, term, country, ts, pos, pos != null ? ts : null);
        if (pos != null) insPos.run(r.lastInsertRowid, pos, ts);
      }
    });
    tx();
  }

  const row = db.prepare('SELECT * FROM apps WHERE id = ?').get(appId);
  const kws = db.prepare(
    `SELECT * FROM keywords WHERE app_id = ? ORDER BY created_at DESC`
  ).all(appId);
  res.json({ app: row, keywords: kws });
});

router.get('/:id', (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!app) return res.status(404).json({ error: 'not_found' });
  const keywords = db.prepare(
    `SELECT k.*, COALESCE((SELECT SUM(count) FROM installs WHERE keyword_id = k.id), 0) AS total_installed
     FROM keywords k WHERE k.app_id = ? ORDER BY k.created_at DESC`
  ).all(app.id);
  res.json({ app, keywords });
});

router.patch('/:id', (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!app) return res.status(404).json({ error: 'not_found' });
  const { name, status, country, category } = req.body || {};
  db.prepare(
    `UPDATE apps SET
       name = COALESCE(?, name),
       status = COALESCE(?, status),
       country = COALESCE(?, country),
       category = COALESCE(?, category)
     WHERE id = ?`
  ).run(name ?? null, status ?? null, country ?? null, category ?? null, app.id);
  res.json({ app: db.prepare('SELECT * FROM apps WHERE id = ?').get(app.id) });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM apps WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

/**
 * Re-sync app: refresh metadata + ranks for all its keywords.
 * Cheaper than per-keyword tick because uses bulk endpoint.
 */
router.post('/:id/sync', async (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!app) return res.status(404).json({ error: 'not_found' });

  // metadata refresh
  if (app.store_id) {
    const meta = await appTweak.fetchAppMetadata(app.store_id, app.country).catch(() => null);
    if (meta) {
      db.prepare(
        `UPDATE apps SET name=COALESCE(?,name), icon_url=COALESCE(?,icon_url),
           category=COALESCE(?,category), rating=?, rating_count=?,
           developer=COALESCE(?,developer), subtitle=COALESCE(?,subtitle)
         WHERE id=?`
      ).run(meta.name, meta.icon_url, meta.category, meta.rating, meta.rating_count,
            meta.developer, meta.subtitle, app.id);
    }
  }

  // bulk ranks
  const kws = db.prepare(`SELECT id, term FROM keywords WHERE app_id = ? AND status='active'`).all(app.id);
  let updated = 0;
  if (kws.length && app.store_id) {
    const ranks = await appTweak.fetchKeywordPositionsBulk(app.store_id, kws.map(k => k.term), app.country)
      .catch(() => ({}));
    const ts = now();
    const insPos = db.prepare(`INSERT INTO keyword_positions (keyword_id, position, checked_at, source) VALUES (?, ?, ?, 'apptweak')`);
    const updKw = db.prepare(`UPDATE keywords SET current_pos = ?, last_checked_at = ? WHERE id = ?`);
    const tx = db.transaction(() => {
      for (const k of kws) {
        const p = ranks[k.term] ?? null;
        if (p != null) insPos.run(k.id, p, ts);
        updKw.run(p, ts, k.id);
        updated++;
      }
    });
    tx();
  }

  const row = db.prepare('SELECT * FROM apps WHERE id = ?').get(app.id);
  res.json({ app: row, keywords_updated: updated });
});

/**
 * Pull historical ranks (last N days) from AppTweak for all keywords of this app
 * and persist into keyword_positions. One API call, real history populated.
 */
router.post('/:id/sync-history', async (req, res) => {
  const days = Math.min(+req.query.days || 30, 90);
  const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!app) return res.status(404).json({ error: 'not_found' });
  if (!app.store_id) return res.status(400).json({ error: 'no_store_id' });

  const kws = db.prepare(`SELECT id, term FROM keywords WHERE app_id = ?`).all(app.id);
  if (!kws.length) return res.json({ inserted: 0 });

  const hist = await appTweak.fetchKeywordHistory(app.store_id, kws.map(k => k.term), app.country, days)
    .catch(() => ({}));

  // Wipe existing apptweak rows in window, then insert fresh.
  const since = Date.now() - days * 86400_000;
  const ins = db.prepare(`INSERT INTO keyword_positions (keyword_id, position, checked_at, source) VALUES (?, ?, ?, 'apptweak_history')`);
  const wipe = db.prepare(`DELETE FROM keyword_positions WHERE keyword_id = ? AND checked_at >= ? AND source LIKE 'apptweak%'`);
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const k of kws) {
      const arr = hist[k.term] || [];
      if (!arr.length) continue;
      wipe.run(k.id, since);
      for (const p of arr) {
        if (p.value == null) continue;
        const ts = Date.parse(p.date + 'T12:00:00Z');
        if (!ts) continue;
        ins.run(k.id, p.value, ts);
        inserted++;
      }
    }
  });
  tx();
  res.json({ inserted, days });
});

/**
 * Keyword suggestions for an app (AppTweak top-installs by app).
 * Optionally enriches with volume/difficulty metrics.
 *
 * Query: ?withMetrics=1&limit=20
 */
router.get('/:id/suggestions', async (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!app) return res.status(404).json({ error: 'not_found' });
  if (!app.store_id) return res.status(400).json({ error: 'no_store_id' });

  const limit = Math.min(+req.query.limit || 30, 50);
  const suggestions = await appTweak.fetchKeywordSuggestionsForApp(app.store_id, app.country, limit)
    .catch(() => []);

  // Filter out keywords already tracked
  const tracked = new Set(
    db.prepare('SELECT term FROM keywords WHERE app_id = ?').all(app.id).map(r => r.term.toLowerCase())
  );
  const filtered = suggestions.filter(s => !tracked.has(s.keyword.toLowerCase()));

  // Enrich with metrics (optional, costs more credits)
  if (String(req.query.withMetrics) === '1' && filtered.length) {
    const top = filtered.slice(0, 10);
    const metrics = await appTweak.fetchKeywordMetrics(top.map(s => s.keyword), app.country)
      .catch(() => ({}));
    for (const s of top) {
      const m = metrics[s.keyword];
      if (m) Object.assign(s, m);
    }
  }

  res.json({ suggestions: filtered });
});

/**
 * Position matrix for AppBooster-like view.
 * Returns:
 *   {
 *     dates: ["2026-04-03", ..., "2026-05-02"],
 *     keywords: [{
 *       id, term, current_pos, target_pos,
 *       byDate: { "2026-04-03": 12, ... },   // null = no data
 *       best, worst, trend (number, negative = improved)
 *     }]
 *   }
 */
router.get('/:id/matrix', (req, res) => {
  const days = Math.min(+req.query.days || 30, 90);
  const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!app) return res.status(404).json({ error: 'not_found' });

  const since = Date.now() - days * 86400_000;
  const kws = db.prepare(
    `SELECT id, term, current_pos, target_pos, frequency, popularity, status, created_at
     FROM keywords WHERE app_id = ? ORDER BY created_at ASC`
  ).all(app.id);

  // Build dates window
  const dates = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  // For each keyword, fetch its positions in window and pick latest per day.
  const posStmt = db.prepare(
    `SELECT position, checked_at FROM keyword_positions
     WHERE keyword_id = ? AND checked_at >= ? ORDER BY checked_at ASC`
  );
  const out = kws.map(k => {
    const rows = posStmt.all(k.id, since);
    const byDate = {};
    for (const r of rows) {
      const d = new Date(r.checked_at).toISOString().slice(0, 10);
      byDate[d] = r.position; // last writer wins → latest pos for that day
    }
    const vals = Object.values(byDate).filter(v => v != null);
    const best = vals.length ? Math.min(...vals) : null;
    const worst = vals.length ? Math.max(...vals) : null;
    // simple trend = first vs last (lower rank = better, so trend negative = improvement)
    const sortedDates = Object.keys(byDate).sort();
    const first = sortedDates.length ? byDate[sortedDates[0]] : null;
    const last = sortedDates.length ? byDate[sortedDates[sortedDates.length - 1]] : null;
    const trend = (first != null && last != null) ? (last - first) : null;
    return { ...k, byDate, best, worst, trend };
  });

  res.json({ app, dates, keywords: out });
});

export default router;
