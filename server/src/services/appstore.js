/**
 * App Store data client — uses Apple's free public iTunes endpoints.
 * No API key, no credits, no third-party dependency.
 *
 *   Lookup (metadata):  https://itunes.apple.com/lookup?id=<id>&country=<cc>
 *   Search (rankings):  https://itunes.apple.com/search?term=<q>&country=<cc>&entity=software&limit=200
 *
 * Keyword position = index of our app inside the ordered search results.
 * This is the live store ranking as Apple returns it for that query.
 *
 * Some advanced metrics (search volume, difficulty) are NOT available from the
 * free endpoints — those features are marked "in development" in the product.
 */

const LOOKUP = 'https://itunes.apple.com/lookup';
const SEARCH = 'https://itunes.apple.com/search';
const SEARCH_LIMIT = 200;     // Apple caps software search at 200
const POLITE_DELAY_MS = 400;  // stay well under iTunes rate limits

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Always available — no key required.
function isConfigured() { return true; }

async function getJson(url) {
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'MAYA Push/1.0' },
    });
    if (!res.ok) {
      console.warn('[store]', res.status, url.slice(0, 120));
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn('[store] error', e.message);
    return null;
  }
}

export function parseAppleAppId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d{6,}$/.test(s)) return s;
  const m = s.match(/id(\d{6,})/i);
  return m ? m[1] : null;
}

/** Pass-through: iTunes already returns human category names. */
export function categoryName(idOrName) {
  return idOrName == null ? null : String(idOrName);
}

function bestArtwork(r) {
  // Upscale the 100px art to 512 when only the small one is present.
  const url = r.artworkUrl512 || r.artworkUrl100 || r.artworkUrl60 || null;
  return url ? url.replace(/\/\d+x\d+(bb)?\./, '/512x512$1.') : null;
}

/** App metadata: name, icon, category, developer, rating. */
export async function fetchAppMetadata(appleId, country = 'us') {
  const url = `${LOOKUP}?id=${encodeURIComponent(appleId)}&country=${encodeURIComponent(country)}&entity=software`;
  const json = await getJson(url);
  const r = json && Array.isArray(json.results) && json.results[0];
  if (!r) return null;
  return {
    store_id: String(appleId),
    bundle_id: r.bundleId || null,
    name: r.trackName || null,
    subtitle: null,                               // not exposed by lookup
    icon_url: bestArtwork(r),
    category: r.primaryGenreName || null,
    category_id: r.primaryGenreId || null,
    developer: r.artistName || null,
    rating: typeof r.averageUserRating === 'number' ? r.averageUserRating : null,
    rating_count: typeof r.userRatingCount === 'number' ? r.userRatingCount : null,
    country,
  };
}

/** Per-app lookups (resilient — one bad id never breaks the batch). */
export async function fetchAppsMetadata(appleIds, country = 'us') {
  if (!appleIds || !appleIds.length) return {};
  const out = {};
  for (const id of appleIds) {
    const meta = await fetchAppMetadata(id, country).catch(() => null);
    if (meta) out[id] = meta;
    await sleep(120);
  }
  return out;
}

/**
 * Returns the ordered list of app store_ids ranking for a keyword (top→down),
 * plus a quick metadata map so callers can render results without extra calls.
 */
async function searchKeyword(term, country = 'us', limit = SEARCH_LIMIT) {
  const url = `${SEARCH}?term=${encodeURIComponent(term)}&country=${encodeURIComponent(country)}`
            + `&entity=software&limit=${limit}`;
  const json = await getJson(url);
  return (json && Array.isArray(json.results)) ? json.results : [];
}

/** Current rank of one app for one keyword (1-based) or null if not in top-200. */
export async function fetchKeywordPosition(appleId, keyword, country = 'us') {
  const results = await searchKeyword(keyword, country);
  const idx = results.findIndex(a => String(a.trackId) === String(appleId));
  return idx === -1 ? null : idx + 1;
}

/** Ranks for many keywords. Returns map { keyword → number|null }. */
export async function fetchKeywordPositionsBulk(appleId, keywords, country = 'us') {
  if (!keywords || !keywords.length) return {};
  const out = {};
  for (const kw of keywords) {
    const results = await searchKeyword(kw, country);
    const idx = results.findIndex(a => String(a.trackId) === String(appleId));
    out[kw] = idx === -1 ? null : idx + 1;
    await sleep(POLITE_DELAY_MS);
  }
  return out;
}

/**
 * Top apps ranking for a keyword. Returns array of store_ids (top→down),
 * and caches their metadata for the explorer to display.
 */
export async function fetchKeywordSearchResults(keyword, country = 'us', limit = 25) {
  const results = await searchKeyword(keyword, country, Math.min(limit, SEARCH_LIMIT));
  return results.map(r => ({
    store_id: String(r.trackId),
    name: r.trackName || null,
    icon_url: bestArtwork(r),
    developer: r.artistName || null,
    category: r.primaryGenreName || null,
    rating: typeof r.averageUserRating === 'number' ? r.averageUserRating : null,
    rating_count: typeof r.userRatingCount === 'number' ? r.userRatingCount : null,
  }));
}

/* ── Features that need a paid data source — disabled, "in development" ── */

/** Search volume / difficulty: not available from free endpoints. */
export async function fetchKeywordMetrics(_keywords, _country = 'us') {
  return {}; // UI shows "в разработке"
}

/** Keyword suggestions: not available from free endpoints yet. */
export async function fetchKeywordSuggestionsForApp(_appleId, _country = 'us', _limit = 30) {
  return [];
}

/**
 * Historical ranks: Apple has no public history endpoint. We build history
 * ourselves over time from keyword_positions (the cron snapshots daily), so
 * this returns empty — no external backfill.
 */
export async function fetchKeywordHistory(_appleId, _keywords, _country = 'us', _days = 30) {
  return {};
}

export const appStore = {
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
