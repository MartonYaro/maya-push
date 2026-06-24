/**
 * Store resolver — lets the app treat App Store and Google Play uniformly.
 * Both service objects expose the same interface (parseId, fetchAppMetadata,
 * fetchKeywordPositionsBulk, fetchKeywordSearchResults, …).
 */
import { appStore } from './appstore.js';
import { playStore } from './playstore.js';

export const STORES = { appstore: appStore, googleplay: playStore };

/** Return the service for a store key ('appstore' | 'googleplay'). */
export function storeFor(key) {
  return STORES[key] || appStore;
}

/** Guess the store from a URL or id. Defaults to App Store. */
export function detectStore(input) {
  const s = String(input || '').trim();
  if (/play\.google\.com/i.test(s)) return 'googleplay';
  if (/apps\.apple\.com|itunes\.apple\.com/i.test(s)) return 'appstore';
  if (/[?&]id=[a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+/.test(s)) return 'googleplay';
  if (/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(s)) return 'googleplay'; // bare package name
  if (/^\d{6,}$/.test(s) || /id\d{6,}/.test(s)) return 'appstore';
  return 'appstore';
}

export const storeLabel = (key) => storeFor(key).label;
