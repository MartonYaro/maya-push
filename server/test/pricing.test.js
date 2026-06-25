import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRICE_PER_INSTALL, priceFor, installCost } from '../src/lib/pricing.js';

test('tier prices are the agreed values', () => {
  assert.equal(PRICE_PER_INSTALL.standard, 0.30);
  assert.equal(PRICE_PER_INSTALL.volume,   0.20);
  assert.equal(PRICE_PER_INSTALL.scale,    0.12);
});

test('priceFor falls back to standard for unknown / missing plan', () => {
  assert.equal(priceFor({ plan: 'standard' }), 0.30);
  assert.equal(priceFor({ plan: 'nope' }),     0.30);
  assert.equal(priceFor({}),                   0.30);
  assert.equal(priceFor(),                     0.30);
});

test('priceFor honours a per-user custom price over the plan', () => {
  assert.equal(priceFor({ plan: 'standard', customPrice: 0.07 }), 0.07);
  // custom price of 0 is a real (free) price, not "unset"
  assert.equal(priceFor({ plan: 'standard', customPrice: 0 }), 0);
  // null/undefined custom price → fall back to the plan
  assert.equal(priceFor({ plan: 'volume', customPrice: null }), 0.20);
  assert.equal(priceFor({ plan: 'volume', customPrice: undefined }), 0.20);
});

test('installCost rounds to whole cents', () => {
  assert.equal(installCost(100, 0.30), 30);
  assert.equal(installCost(3, 0.12), 0.36);
  // 7 × 0.85 = 5.95 exactly; guard against float drift
  assert.equal(installCost(7, 0.85), 5.95);
});

test('installCost clamps junk / negative input to a safe number', () => {
  assert.equal(installCost(-5, 0.30), 0);
  assert.equal(installCost(10, -1), 0);
  assert.equal(installCost('abc', 0.30), 0);
  assert.equal(installCost(2.9, 0.10), 0.2); // count truncates to 2
});
