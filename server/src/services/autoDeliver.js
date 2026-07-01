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
  // 1. Backfill deliver_at for any pending order that lacks one.
  const missing = db.prepare(
    `SELECT id, created_at FROM installs
     WHERE deliver_at IS NULL AND status IN ('scheduled','in_progress')`
  ).all();
  const setDeliverAt = db.prepare('UPDATE installs SET deliver_at = ? WHERE id = ?');
  const assignTx = db.transaction(() => {
    for (const r of missing) setDeliverAt.run((r.created_at || now()) + deliverDelayMs(), r.id);
  });
  assignTx();

  // 2. Deliver everything whose window has elapsed.
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
  if (delivered) console.log(`[auto-deliver] delivered ${delivered} order(s)`);
  return { assigned: missing.length, delivered };
}
