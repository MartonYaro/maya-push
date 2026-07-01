// NOWPayments reconciliation poller.
//
// Why this exists: the inbound IPN webhook has proven unreliable (dashboard
// config / signature), so real payments sat 'pending' until a human confirmed
// them in the admin panel. This job removes the dependency on the webhook — it
// asks NOWPayments directly for the status of every pending crypto top-up and
// credits the ones that are paid, using the same idempotent path as the IPN.
import { db } from '../db.js';
import { nowpayments } from './nowpayments.js';
import { creditCryptoTopup } from './topups.js';

let running = false;

/** One reconciliation pass. Safe to call on a timer and on boot. */
export async function runReconcile() {
  if (!nowpayments.canReconcile) return { skipped: 'not_configured' };
  if (running) return { skipped: 'already_running' };
  running = true;
  const result = { checked: 0, credited: 0, pendingStill: 0, errors: 0 };
  try {
    // Only crypto top-ups (NOWPayments), still pending, from the last 30 days.
    const rows = db.prepare(
      `SELECT id, amount, created_at FROM transactions
        WHERE type = 'topup' AND status = 'pending'
          AND description LIKE '%NOWPayments%'
          AND created_at > ?`
    ).all(Date.now() - 30 * 24 * 60 * 60_000);

    for (const tx of rows) {
      result.checked++;
      try {
        const r = await nowpayments.paymentStatusForOrder(`maya_${tx.id}`, {
          since: tx.created_at - 60_000,
        });
        if (r && ['finished', 'confirmed'].includes(r.status)) {
          if (creditCryptoTopup(tx.id, 'reconcile')) result.credited++;
        } else if (r && r.status === 'partially_paid') {
          result.pendingStill++;
          console.warn(`[reconcile] tx ${tx.id} partially_paid (paid ${r.actuallyPaid}) — manual review`);
        } else {
          result.pendingStill++;
        }
      } catch (e) {
        result.errors++;
        console.warn(`[reconcile] tx ${tx.id} lookup failed: ${e.message}`);
      }
    }
    if (result.credited || result.errors) {
      console.log(`[reconcile] pass done: ${JSON.stringify(result)}`);
    }
  } finally {
    running = false;
  }
  return result;
}
