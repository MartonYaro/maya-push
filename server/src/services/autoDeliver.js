import { db, now, getBalance } from '../db.js';
import { broadcast } from '../sse.js';
import { payDeliveryReferral } from './referral.js';

const HOUR = 3600_000;
const MIN_DELAY = 3 * HOUR;   // installs land within 3–8h of the order
const MAX_DELAY = 8 * HOUR;

/** Random delivery delay (ms) from the moment an order is placed. */
export function deliverDelayMs() {
  return Math.round(MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY));
}

/**
 * Delivery moment for an order, bound to its POOL DAY (`date`, YYYY-MM-DD).
 * Installs run through the target day and complete between 14:00–22:00 UTC of
 * that day — an order placed today for tomorrow must NOT show "delivered"
 * tonight. For same-day orders placed late, the 3–8h minimum from creation
 * still applies (whichever is later).
 */
export function deliverAtFor(dateStr, createdAt = now()) {
  const dayStart = Date.parse(String(dateStr) + 'T00:00:00Z');
  const minFromCreation = createdAt + deliverDelayMs();
  if (!Number.isFinite(dayStart)) return minFromCreation;
  const withinPoolDay = dayStart + Math.round((14 + Math.random() * 8) * HOUR);
  return Math.max(withinPoolDay, minFromCreation);
}

/** YYYY-MM-DD of "now" in UTC — pool days are UTC-based. */
function todayUTC() {
  return new Date(now()).toISOString().slice(0, 10);
}

/**
 * Auto-deliver: orders placed by clients are fulfilled by the supplier within
 * 3–8h, so we flip them to `delivered` (full count) once their per-order
 * `deliver_at` passes. This drives the client-facing "доставлено" status,
 * referral payouts and P&L revenue — no manual operator action needed.
 *
 * Legacy/back-filled orders without a `deliver_at` get one assigned lazily from
 * their `created_at` (so anything already overdue delivers on the next tick).
 *
 * @returns {{assigned:number, delivered:number}}
 */
export function runAutoDeliver() {
  // 1. Backfill deliver_at for any pending order that lacks one (pool-day aware).
  const missing = db.prepare(
    `SELECT id, date, created_at FROM installs
     WHERE deliver_at IS NULL AND status IN ('scheduled','in_progress')`
  ).all();
  const setDeliverAt = db.prepare('UPDATE installs SET deliver_at = ? WHERE id = ?');
  const assignTx = db.transaction(() => {
    for (const r of missing) setDeliverAt.run(deliverAtFor(r.date, r.created_at || now()), r.id);
  });
  assignTx();

  // 2. Pool day has begun → the order is being worked: scheduled → in_progress.
  const started = db.prepare(`
    SELECT i.id, a.user_id
    FROM installs i
    JOIN keywords k ON k.id = i.keyword_id
    JOIN apps a     ON a.id = k.app_id
    WHERE i.status = 'scheduled' AND i.date <= ?
      AND (i.deliver_at IS NULL OR i.deliver_at > ?)
  `).all(todayUTC(), now());
  if (started.length) {
    const flip = db.prepare(`UPDATE installs SET status = 'in_progress', updated_at = ? WHERE id = ?`);
    const flipTx = db.transaction(() => { for (const r of started) flip.run(now(), r.id); });
    flipTx();
    for (const r of started) {
      const fresh = db.prepare('SELECT * FROM installs WHERE id = ?').get(r.id);
      broadcast(r.user_id, 'install.updated', fresh);
    }
  }

  // 3. Deliver everything whose window has elapsed.
  const due = db.prepare(`
    SELECT i.*, k.app_id, a.user_id
    FROM installs i
    JOIN keywords k ON k.id = i.keyword_id
    JOIN apps a     ON a.id = k.app_id
    WHERE i.status IN ('scheduled','in_progress')
      AND i.deliver_at IS NOT NULL AND i.deliver_at <= ?
  `).all(now());

  let delivered = 0;
  for (const order of due) {
    try {
      const deliveredCount = order.count;
      let payout = null;
      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE installs SET status = 'delivered', delivered = ?, updated_at = ? WHERE id = ?`
        ).run(deliveredCount, now(), order.id);
        payout = payDeliveryReferral(order, deliveredCount);
      });
      tx();

      const fresh = db.prepare('SELECT * FROM installs WHERE id = ?').get(order.id);
      broadcast(order.user_id, 'install.updated', fresh);
      if (payout) {
        broadcast(payout.userId, 'transaction.created', { kind: 'referral', amount: payout.amount });
        broadcast(payout.userId, 'balance.updated', { balance: getBalance(payout.userId) });
      }
      delivered++;
    } catch (err) {
      console.error(`[auto-deliver] order ${order.id} failed:`, err);
    }
  }
  if (delivered || started.length) console.log(`[auto-deliver] started ${started.length}, delivered ${delivered} order(s)`);
  return { assigned: missing.length, started: started.length, delivered };
}
