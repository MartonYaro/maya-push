import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { appStore } from '../services/appstore.js';

const router = Router();
router.use(requireAuth);

/**
 * Keyword research / explorer — live App Store search.
 *   GET /api/research/keyword?keyword=fitness&country=us&topApps=10
 *
 * Returns:
 *   {
 *     keyword, country,
 *     metrics: null,            // search volume / difficulty — "в разработке"
 *     metrics_in_development: true,
 *     totalApps,                // how many apps the store returned (≤200)
 *     topApps: [ { position, store_id, name, icon_url, developer, category, rating } ]
 *   }
 */
router.get('/keyword', async (req, res) => {
  const keyword = String(req.query.keyword || '').trim();
  const country = (String(req.query.country || 'us')).toLowerCase();
  const topApps = Math.min(Math.max(+req.query.topApps || 10, 0), 25);

  if (!keyword) return res.status(400).json({ error: 'missing_keyword' });

  const results = await appStore.fetchKeywordSearchResults(keyword, country, topApps)
    .catch(() => []);

  const apps = results.map((r, i) => ({ position: i + 1, ...r }));

  res.json({
    keyword,
    country,
    metrics: null,
    metrics_in_development: true,   // volume/difficulty not available yet
    totalApps: apps.length,
    topApps: apps,
  });
});

export default router;
