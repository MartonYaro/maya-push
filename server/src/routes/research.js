import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { appTweak } from '../services/apptweak.js';

const router = Router();
router.use(requireAuth);

/**
 * Keyword research / explorer.
 *   GET /api/research/keyword?keyword=fitness&country=us&topApps=5
 *
 * Returns:
 *   {
 *     keyword, country,
 *     metrics: { volume, difficulty, results, max_reach },
 *     totalApps,
 *     topApps: [ { position, store_id, name, icon_url, developer, category, rating } ]
 *   }
 *
 * AppTweak credit cost ≈ 11 (metrics) + 1 (search) + 5×N/5 metadata.
 * Default topApps=5 → ~13 credits per call.
 */
router.get('/keyword', async (req, res) => {
  const keyword = String(req.query.keyword || '').trim();
  const country = (String(req.query.country || 'us')).toLowerCase();
  const topApps = Math.min(Math.max(+req.query.topApps || 5, 0), 25);

  if (!keyword) return res.status(400).json({ error: 'missing_keyword' });
  if (!appTweak.isConfigured()) {
    return res.status(503).json({ error: 'apptweak_not_configured' });
  }

  const [metricsMap, ids] = await Promise.all([
    appTweak.fetchKeywordMetrics([keyword], country).catch(() => ({})),
    appTweak.fetchKeywordSearchResults(keyword, country).catch(() => []),
  ]);
  const metrics = metricsMap[keyword] || null;

  const topIds = ids.slice(0, topApps);
  const meta = topIds.length
    ? await appTweak.fetchAppsMetadata(topIds, country).catch(() => ({}))
    : {};

  const apps = topIds.map((id, i) => ({
    position: i + 1,
    store_id: id,
    ...(meta[id] || { name: 'App #' + id }),
  }));

  res.json({
    keyword,
    country,
    metrics,
    totalApps: ids.length,
    topApps: apps,
  });
});

export default router;
