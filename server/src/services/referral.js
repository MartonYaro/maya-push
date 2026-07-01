import { db, now, userInstallPrice, REFERRAL_RATE } from '../db.js';

/**
 * Credit the buyer's referrer when an order's installs are delivered.
 * Pays a % of the DELIVERED count, valued at the REFERRER's own install price,
 * using the referrer's manual ref_rate if set (else the global default).
 *
 * Idempotent per order (guarded by transactions.ref_id = `ref:<orderId>`), so it
 * is safe to call from both the manual admin status change and the auto-deliver
 * cron. MUST be called inside a db.transaction by the caller.
 *
 * @returns {{userId:number, amount:number}|null} payout info for broadcasting, or null.
 */
export function payDeliveryReferral(order, deliveredCount) {
  if (!(deliveredCount > 0)) return null;
  const buyer = db.prepare('SELECT referred_by FROM users WHERE id = ?').get(order.user_id);
  if (!buyer || !buyer.referred_by) return null;
  const already = db.prepare(`SELECT 1 FROM transactions WHERE ref_id = ? AND type = 'referral'`).get(`ref:${order.id}`);
  if (already) return null;

  const refRow = db.prepare('SELECT ref_rate FROM users WHERE id = ?').get(buyer.referred_by);
  const rate = (refRow && refRow.ref_rate != null) ? refRow.ref_rate : REFERRAL_RATE();
  const reward = +(deliveredCount * rate * userInstallPrice(buyer.referred_by)).toFixed(2);
  if (!(reward > 0)) return null;

  db.prepare(
    `INSERT INTO transactions (user_id, type, amount, status, description, ref_id, created_at)
     VALUES (?, 'referral', ?, 'done', ?, ?, ?)`
  ).run(buyer.referred_by, reward,
    `Реферальный бонус: ${deliveredCount} установок · ${Math.round(rate * 100)}% по вашему тарифу`,
    `ref:${order.id}`, now());

  return { userId: buyer.referred_by, amount: reward };
}
