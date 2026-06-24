/**
 * Google Play data client — mirrors the App Store service interface so the
 * rest of the app can treat both stores uniformly. Backed by the
 * `google-play-scraper` package (no official Play API exists).
 *
 * Keyword position = index of our app (by package name) inside the ordered
 * Play search results for that query.
 */
const SEARCH_NUM = 200;
const POLITE_DELAY_MS = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lazy import — keeps startup fast and isolates the dependency.
let _gplay = null;
async function gp() {
  if (!_gplay) {
    const mod = await import('google-play-scraper');
    _gplay = mod.default || mod;
  }
  return _gplay;
}

function langFor(country) {
  const c = String(country || 'us').toLowerCase();
  return ({ ru: 'ru', ua: 'uk', de: 'de', fr: 'fr', es: 'es', it: 'it', br: 'pt', pt: 'pt' })[c] || 'en';
}

function isConfigured() { return true; }

/** Extract a Google Play package name from a URL or accept a bare package id. */
export function parsePlayAppId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/[?&]id=([a-zA-Z0-9._]+)/);
  if (m) return m[1];
  // Bare package name like com.company.app
  if (/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(s)) return s;
  return null;
}

export function categoryName(idOrName) {
  return idOrName == null ? null : String(idOrName);
}

export async function fetchAppMetadata(pkg, country = 'us') {
  try {
    const gplay = await gp();
    const a = await gplay.app({ appId: pkg, country, lang: langFor(country) });
    if (!a) return null;
    return {
      store_id: String(pkg),
      bundle_id: String(pkg),
      name: a.title || null,
      subtitle: a.summary || null,
      icon_url: a.icon || null,
      category: a.genre || null,
      category_id: a.genreId || null,
      developer: a.developer || null,
      rating: typeof a.score === 'number' ? a.score : null,
      rating_count: typeof a.ratings === 'number' ? a.ratings : null,
      country,
    };
  } catch (e) {
    console.warn('[play] metadata error', pkg, e.message);
    return null;
  }
}

export async function fetchAppsMetadata(pkgs, country = 'us') {
  if (!pkgs || !pkgs.length) return {};
  const out = {};
  for (const id of pkgs) {
    const meta = await fetchAppMetadata(id, country).catch(() => null);
    if (meta) out[id] = meta;
    await sleep(200);
  }
  return out;
}

async function searchKeyword(term, country = 'us', num = SEARCH_NUM) {
  try {
    const gplay = await gp();
    const res = await gplay.search({ term, num, country, lang: langFor(country) });
    return Array.isArray(res) ? res : [];
  } catch (e) {
    console.warn('[play] search error', term, e.message);
    return [];
  }
}

export async function fetchKeywordPosition(pkg, keyword, country = 'us') {
  const results = await searchKeyword(keyword, country);
  const idx = results.findIndex(a => String(a.appId) === String(pkg));
  return idx === -1 ? null : idx + 1;
}

export async function fetchKeywordPositionsBulk(pkg, keywords, country = 'us') {
  if (!keywords || !keywords.length) return {};
  const out = {};
  for (const kw of keywords) {
    const results = await searchKeyword(kw, country);
    const idx = results.findIndex(a => String(a.appId) === String(pkg));
    out[kw] = idx === -1 ? null : idx + 1;
    await sleep(POLITE_DELAY_MS);
  }
  return out;
}

export async function fetchKeywordSearchResults(keyword, country = 'us', limit = 25) {
  const results = await searchKeyword(keyword, country, Math.min(limit, SEARCH_NUM));
  return results.map(r => ({
    store_id: String(r.appId),
    name: r.title || null,
    icon_url: r.icon || null,
    developer: r.developer || null,
    category: null,
    rating: typeof r.score === 'number' ? r.score : null,
    rating_count: typeof r.ratings === 'number' ? r.ratings : null,
  }));
}

export async function fetchKeywordMetrics(_keywords, _country = 'us') { return {}; }
export async function fetchKeywordSuggestionsForApp(_pkg, _country = 'us', _limit = 30) { return []; }
export async function fetchKeywordHistory(_pkg, _keywords, _country = 'us', _days = 30) { return {}; }

export const playStore = {
  key: 'googleplay',
  label: 'Google Play',
  isConfigured,
  parseId: parsePlayAppId,
  fetchAppMetadata,
  fetchAppsMetadata,
  fetchKeywordPosition,
  fetchKeywordPositionsBulk,
  fetchKeywordHistory,
  fetchKeywordSuggestionsForApp,
  fetchKeywordMetrics,
  fetchKeywordSearchResults,
  parsePlayAppId,
  categoryName,
};
