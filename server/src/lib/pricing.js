/**
 * Pricing — the single source of truth for what an install costs.
 *
 * Kept DB-free and side-effect-free on purpose so it can be unit-tested in
 * isolation (no native better-sqlite3 needed) and reused anywhere on the
 * server. The client (web/js/app.js PRICING_TIERS), the admin tier labels and
 * the landing page must stay in sync with PRICE_PER_INSTALL below.
 */

// Per-install price by plan, in USD.
export const PRICE_PER_INSTALL = {
  standard: 0.30,
  volume:   0.20,
  scale:    0.12,
  fast:     0.55,
  premium:  0.85,
};

/**
 * Resolve the per-install price for an order.
 * A per-user custom price (set by admin) always wins over the plan price;
 * otherwise we fall back to the plan, then to `standard` for unknown plans.
 *
 * @param {{ plan?: string, customPrice?: number|null }} opts
 * @returns {number} price per install in USD
 */
export function priceFor({ plan, customPrice } = {}) {
  if (customPrice != null && Number.isFinite(customPrice)) return customPrice;
  return PRICE_PER_INSTALL[plan] ?? PRICE_PER_INSTALL.standard;
}

/**
 * Total cost for `count` installs at `price` each, rounded to whole cents.
 * @param {number} count
 * @param {number} price
 * @returns {number}
 */
export function installCost(count, price) {
  const c = Math.max(0, Math.trunc(Number(count) || 0));
  const p = Math.max(0, Number(price) || 0);
  return +(c * p).toFixed(2);
}
