// Public payment webhooks. NOT behind requireAuth — callers are payment
// providers, authenticated by signature instead.
import { Router } from 'express';
import { db, getBalance } from '../db.js';
import { broadcast } from '../sse.js';
import { nowpayments } from '../services/nowpayments.js';
import { notifyAdmin, tgTopupConfirmed } from '../services/telegram.js';

const router = Router();

// NOWPayments IPN (Instant Payment Notification).
// Signature header: x-nowpayments-sig (HMAC-SHA512 of the sorted JSON body).
router.post('/nowpayments/ipn', (req, res) => {
  const sig = req.headers['x-nowpayments-sig'];
  if (!nowpayments.verifyIpn(req.body || {}, sig)) {
    return res.status(401).json({ error: 'bad_signature' });
  }

  const { order_id, payment_status } = req.body || {};
  try {
    if (order_id && /^maya_\d+$/.test(order_id)) {
      const txId = parseInt(order_id.slice(5), 10);
      const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
      // Only credit once, and only on a terminal success status.
      if (tx && tx.status === 'pending' && ['finished', 'confirmed'].includes(payment_status)) {
        db.prepare("UPDATE transactions SET status = 'done' WHERE id = ?").run(txId);
        const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
        broadcast(tx.user_id, 'transaction.updated', row);
        const userRow = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(tx.user_id);
        notifyAdmin(tgTopupConfirmed({
          user: userRow, amount: row.amount, txId, balance: getBalance(tx.user_id),
        })).catch(() => {});
      }
    }
  } catch (e) {
    // Never let provider see a 500 over our internal hiccup; we've validated the
    // signature, so acknowledge and let NOWPayments stop retrying.
  }
  res.json({ ok: true });
});

export default router;
