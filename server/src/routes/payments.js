// Public payment webhooks. NOT behind requireAuth — callers are payment
// providers, authenticated by signature instead.
import { Router } from 'express';
import { db } from '../db.js';
import { nowpayments } from '../services/nowpayments.js';
import { creditCryptoTopup } from '../services/topups.js';

const router = Router();

// NOWPayments IPN (Instant Payment Notification).
// Signature header: x-nowpayments-sig (HMAC-SHA512 of the sorted JSON body).
router.post('/nowpayments/ipn', (req, res) => {
  const sig = req.headers['x-nowpayments-sig'];
  const { order_id, payment_status, payment_id } = req.body || {};
  // Diagnostic: log every hit so Railway logs reveal whether NOWPayments is
  // calling us at all and whether the signature verifies. No secrets logged.
  const sigOk = nowpayments.verifyIpn(req.body || {}, sig);
  console.log(`[ipn] hit order_id=${order_id ?? '-'} status=${payment_status ?? '-'} payment_id=${payment_id ?? '-'} hasSig=${!!sig} sigOk=${sigOk} ipnSecretSet=${nowpayments.ipnConfigured}`);
  if (!sigOk) {
    console.warn(`[ipn] REJECTED bad_signature (secret ${nowpayments.ipnConfigured ? 'is set — likely mismatch with NOWPayments dashboard' : 'NOT set in env'})`);
    return res.status(401).json({ error: 'bad_signature' });
  }

  try {
    if (order_id && /^maya_\d+$/.test(order_id)) {
      const txId = parseInt(order_id.slice(5), 10);
      const tx = db.prepare('SELECT status FROM transactions WHERE id = ?').get(txId);
      if (!tx) console.warn(`[ipn] no transaction for ${order_id}`);
      else if (tx.status !== 'pending') console.log(`[ipn] tx ${txId} already '${tx.status}', skipping`);
      // Only credit on a terminal success status; creditCryptoTopup is idempotent.
      if (tx && tx.status === 'pending' && ['finished', 'confirmed'].includes(payment_status)) {
        creditCryptoTopup(txId, 'ipn');
      }
    }
  } catch (e) {
    // Never let provider see a 500 over our internal hiccup; we've validated the
    // signature, so acknowledge and let NOWPayments stop retrying.
  }
  res.json({ ok: true });
});

export default router;
