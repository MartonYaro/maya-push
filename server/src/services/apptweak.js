/**
 * AppTweak API client (verified May 2026).
 * Auth: X-Apptweak-Key. Base: https://public-api.apptweak.com
 */

const BASE = () => process.env.APPTWEAK_BASE_URL || 'https://public-api.apptweak.com';
const KEY = () => process.env.APPTWEAK_API_KEY || '';

function isConfigured() { return !!KEY(); }

async function call(path, params = {}) {
  if (!isConfigured()) return null;
  const url = new URL(BASE() + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : v);
  }
  try {
    const res = await fetch(url, {
      headers: { 'X-Apptweak-Key': KEY(), 'Accept': 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn('[apptweak]', res.status, url.pathname, text.slice(0, 200));
      return null;
    }
    try { return JSON.parse(text); } catch { return null; }
  } catch (e) {
    console.warn('[apptweak] error', e.message);
    return null;
  }
}

// Apple iOS App Store category numeric IDs → human names.
const APPLE_CATEGORIES = {
  6000: 'Business', 6001: 'Weather', 6002: 'Utilities', 6003: 'Travel',
  6004: 'Sports', 6005: 'Social Networking', 6006: 'Reference', 6007: 'Productivity',
  6008: 'Photo & Video', 6009: 'News', 6010: 'Navigation', 6011: 'Music',
  6012: 'Lifestyle', 6013: 'Health & Fitness', 6014: 'Games', 6015: 'Finance',
  6016: 'Entertainment', 6017: 'Education', 6018: 'Books', 6020: 'Medical',
  6021: 'Magazines & Newspapers', 6022: 'Catalogs', 6023: 'Food & Drink',
  6024: 'Shopping', 6025: 'Stickers', 6026: 'Developer Tools', 6027: 'Graphics & Design',
};

export function categoryName(idOrName) {
  if (idOrName == null) return null;
  const n = Number(idOrName);
  if (Number.isFinite(n)) return APPLE_CATEGORIES[n] || ('Category ' + n);
  return String(idOrName);
}

export function parseAppleAppId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d{6,}$/.test(s)) return s;
  const m = s.match(/id(\d{6,})/i);
  return m ? m[1] : null;
}

/** Fetch app metadata: name, icon, primary category, developer, rating. */
export async function fetchAppMetadata(appleId, country = 'us') {
  const json = await call('/api/public/store/apps/metadata.json', {
    apps: appleId, country, device: 'iphone',
  });
  const m = json && json.result && json.result[appleId] && json.result[appleId].metadata;
  if (!m) return null;
  const catRaw = Array.isArray(m.categories) && m.categories.length ? m.categories[0] : null;
  return {
    store_id: String(appleId),
    bundle_id: m.bundle_id || null,
    name: m.title || null,
    subtitle: m.subtitle || null,
    icon_url: m.icon || null,
    category: categoryName(catRaw),
    category_id: catRaw,
    developer: (m.developer && m.developer.name) || null,
    rating: m.rating && typeof m.rating.average === 'number' ? m.rating.average : null,
    rating_count: m.rating && typeof m.rating.count === 'number' ? m.rating.count : null,
    country,
  };
}

/**
 * Get current ranks for many keywords in one call.
 * Returns map { keyword → number|null }.
 * Cost ≈ 11 credits per keyword.
 */
export async function fetchKeywordPositionsBulk(appleId, keywords, country = 'us') {
  if (!keywords || !keywords.length) return {};
  const json = await call('/api/public/store/apps/keywords-rankings/current.json', {
    apps: appleId, keywords, country, device: 'iphone', metrics: 'rank',
  });
  const node = json && json.result && json.result[appleId];
  const out = {};
  for (const kw of keywords) {
    const r = node && node[kw] && node[kw].rank;
    out[kw] = r && r.value != null ? r.value : null;
  }
  return out;
}

/** Single-keyword convenience wrapper. */
export async function fetchKeywordPosition(appleId, keyword, country = 'us') {
  const map = await fetchKeywordPositionsBulk(appleId, [keyword], country);
  return map[keyword] ?? null;
}

/**
 * Historical ranks per day. Returns:
 *   { keyword → [{date:"YYYY-MM-DD", value:number|null}, ...] }
 */
export async function fetchKeywordHistory(appleId, keywords, country = 'us', days = 30) {
  if (!keywords || !keywords.length) return {};
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86400_000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const json = await call('/api/public/store/apps/keywords-rankings/history.json', {
    apps: appleId, keywords, country, device: 'iphone', metrics: 'rank',
    start_date: fmt(start), end_date: fmt(end),
  });
  const node = json && json.result && json.result[appleId];
  const out = {};
  for (const kw of keywords) {
    const arr = node && node[kw] && node[kw].rank;
    out[kw] = Array.isArray(arr)
      ? arr.map(p => ({ date: p.date, value: p.value, effective: p.effective_value }))
      : [];
  }
  return out;
}

/**
 * Keyword suggestions based on app's current performance.
 * Returns [{keyword, ranking, volume, score, is_typo}, ...]
 */
export async function fetchKeywordSuggestionsForApp(appleId, country = 'us', limit = 30) {
  const json = await call('/api/public/store/keywords/suggestions/app.json', {
    apps: appleId, country, device: 'iphone',
  });
  const arr = json && json.result && json.result[appleId] && json.result[appleId].suggestions;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(s => !s.is_typo)
    .slice(0, limit)
    .map(s => ({
      keyword: s.keyword,
      ranking: s.ranking,
      volume: s.volume,
      score: s.score,
    }));
}

/**
 * Live search results — top apps ranking for a keyword.
 * Returns array of Apple app IDs (top to bottom).
 */
export async function fetchKeywordSearchResults(keyword, country = 'us') {
  const json = await call('/api/public/store/keywords/search-results/current.json', {
    keyword, country, device: 'iphone',
  });
  const arr = json && json.result && json.result.value;
  return Array.isArray(arr) ? arr.map(String) : [];
}

/**
 * Bulk metadata for many apps. AppTweak fails the entire batch if ANY app
 * isn't available in the requested country, so we do per-app calls in
 * parallel — slower but resilient.
 *
 * Returns map { storeId → { name, icon_url, category, ... } }.
 */
export async function fetchAppsMetadata(appleIds, country = 'us') {
  if (!appleIds || !appleIds.length) return {};
  const results = await Promise.all(
    appleIds.map(id => fetchAppMetadata(id, country).catch(() => null))
  );
  const out = {};
  for (let i = 0; i < appleIds.length; i++) {
    const meta = results[i];
    if (meta) out[appleIds[i]] = meta;
  }
  return out;
}

/**
 * Keyword metrics: volume, difficulty, total results, max reach.
 * Returns map { keyword → { volume, difficulty, results, max_reach } }
 */
export async function fetchKeywordMetrics(keywords, country = 'us') {
  if (!keywords || !keywords.length) return {};
  const json = await call('/api/public/store/keywords/metrics/current.json', {
    keywords, country, device: 'iphone',
    metrics: 'volume,difficulty,results,max_reach',
  });
  const result = json && json.result;
  const out = {};
  if (!result) return out;
  for (const kw of keywords) {
    const m = result[kw];
    out[kw] = m ? {
      volume:     m.volume     ? m.volume.value     : null,
      difficulty: m.difficulty ? m.difficulty.value : null,
      results:    m.results    ? m.results.value    : null,
      max_reach:  m.max_reach  ? m.max_reach.value  : null,
    } : null;
  }
  return out;
}

export const appTweak = {
  isConfigured,
  fetchAppMetadata,
  fetchAppsMetadata,
  fetchKeywordPosition,
  fetchKeywordPositionsBulk,
  fetchKeywordHistory,
  fetchKeywordSuggestionsForApp,
  fetchKeywordMetrics,
  fetchKeywordSearchResults,
  parseAppleAppId,
  categoryName,
};
