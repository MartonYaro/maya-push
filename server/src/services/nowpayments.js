// NOWPayments crypto-payment integration.
//
// Needs two secrets (set as Railway env vars):
//   NOWPAYMENTS_API_KEY     — Dashboard → Settings → Payments → API keys
//   NOWPAYMENTS_IPN_SECRET  — Dashboard → Settings → Payments → IPN (Instant
//                             Payment Notifications) secret, used to sign callbacks
//
// In the NOWPayments dashboard the IPN callback URL must point at:
//   https://app.mayapush.com/api/payments/nowpayments/ipn
import crypto from 'crypto';

const API_BASE = 'https://api.nowpayments.io/v1';
const API_KEY = process.env.NOWPAYMENTS_API_KEY || '';
const IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || '';

export const nowpayments = {
  get isConfigured() { return !!API_KEY; },
  get ipnConfigured() { return !!IPN_SECRET; },

  /**
   * Create a hosted invoice. Returns { id, invoice_url }.
   * @param {object} p
   * @param {number} p.amount      price in USD
   * @param {string} p.orderId     our reference, e.g. "maya_<txId>"
   * @param {string} p.description shown on the checkout page
   * @param {string} p.ipnUrl      absolute callback URL
   * @param {string} [p.successUrl]
   * @param {string} [p.cancelUrl]
   */
  async createInvoice({ amount, orderId, description, ipnUrl, successUrl, cancelUrl }) {
    if (!API_KEY) throw new Error('nowpayments_not_configured');
    const res = await fetch(`${API_BASE}/invoice`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: amount,
        price_currency: 'usd',
        order_id: orderId,
        order_description: description,
        ipn_callback_url: ipnUrl,
        success_url: successUrl,
        cancel_url: cancelUrl,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || `nowpayments_http_${res.status}`);
    }
    return { id: data.id, invoice_url: data.invoice_url };
  },

  /**
   * Verify an IPN callback signature (header `x-nowpayments-sig`).
   * NOWPayments signs HMAC-SHA512 over the JSON body with keys sorted
   * alphabetically (recursively), using the IPN secret.
   */
  verifyIpn(body, signature) {
    if (!IPN_SECRET || !signature) return false;
    const sorted = sortKeys(body);
    const hmac = crypto.createHmac('sha512', IPN_SECRET)
      .update(JSON.stringify(sorted))
      .digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(String(signature)));
    } catch {
      return false;
    }
  },
};

function sortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => {
      acc[k] = sortKeys(obj[k]);
      return acc;
    }, {});
  }
  return obj;
}
