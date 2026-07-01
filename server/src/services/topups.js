// Shared crediting for crypto (NOWPayments) top-ups.
//
// Both paths converge here so they behave identically and can never double-credit:
//   1. the inbound IPN webhook (routes/payments.js), and
//   2. the reconciliation poller (services/nowpaymentsReconcile.js) that asks
//      NOWPayments directly when the webhook never arrives.
//
// Idempotent by design: a top-up flips from 'pending' → 'done' exactly once;
// any later call for the same tx is a no-op.
import { db, getBalance } from '../db.js';
import { broadcast } from '../sse.js';
import { notifyAdmin, tgTopupConfirmed } from './telegram.js';
import { emailTopupConfirmed } from './notifications.js';

/**
 * Credit a pending top-up transaction. Returns true only if THIS call was the
 * one that flipped it to 'done' (so callers can log/notify without racing).
 * @param {number} txId
 * @param {string} source  who triggered it ('ipn' | 'reconcile' | 'admin')
 */
export function creditCryptoTopup(txId, source = 'ipn') {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
  if (!tx) { console.warn(`[credit] no transaction ${txId} (${source})`); return false; }
  if (tx.status !== 'pending') return false; // already credited / voided — no-op

  db.prepare("UPDATE transactions SET status = 'done' WHERE id = ?").run(txId);
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
  console.log(`[credit] (${source}) tx ${txId} ($${tx.amount}) → done for user ${tx.user_id}`);

  // Live-update the user's dashboard, email them, and ping the admin chat —
  // the exact notifications the manual admin-confirm path already sends.
  broadcast(tx.user_id, 'transaction.updated', row);
  if (row.amount > 0) { try { emailTopupConfirmed(tx.user_id, row.amount); } catch {} }
  try {
    const userRow = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(tx.user_id);
    notifyAdmin(tgTopupConfirmed({
      user: userRow, amount: row.amount, txId, balance: getBalance(tx.user_id),
    })).catch(() => {});
  } catch {}
  return true;
}
