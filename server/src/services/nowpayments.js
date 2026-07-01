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
// Account login — needed ONLY for the reconciliation poller, which asks
// NOWPayments for payment status when the IPN webhook never arrives. The list
// endpoint requires a JWT (the api-key alone can't look a payment up by our
// order_id), so we exchange email+password for a short-lived token.
const EMAIL = process.env.NOWPAYMENTS_EMAIL || '';
const PASSWORD = process.env.NOWPAYMENTS_PASSWORD || '';

let _jwt = null;
let _jwtExp = 0;

export const nowpayments = {
  get isConfigured() { return !!API_KEY; },
  get ipnConfigured() { return !!IPN_SECRET; },
  // Can we self-reconcile via the API (independent of the webhook)?
  get canReconcile() { return !!(API_KEY && EMAIL && PASSWORD); },

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

  /** Exchange email+password for a short-lived JWT (cached ~4 min). */
  async _authToken() {
    if (_jwt && Date.now() < _jwtExp) return _jwt;
    const res = await fetch(`${API_BASE}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) throw new Error(data.message || `nowpayments_auth_${res.status}`);
    _jwt = data.token;
    _jwtExp = Date.now() + 4 * 60_000; // NOWPayments JWT lives ~5 min
    return _jwt;
  },

  /**
   * Look up the latest payment for one of our order ids (e.g. "maya_55") and
   * return { status, paymentId, actuallyPaid } — or null if NOWPayments has no
   * payment for it yet (user opened the invoice but never paid). Scans recent
   * payments newest-first; stops once it pages past `since` (tx creation time).
   */
  async paymentStatusForOrder(orderId, { since } = {}) {
    const token = await this._authToken();
    const limit = 100;
    for (let page = 0; page < 10; page++) {
      const res = await fetch(
        `${API_BASE}/payment/?limit=${limit}&page=${page}&sortBy=created_at&orderBy=desc`,
        { headers: { 'x-api-key': API_KEY, Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`nowpayments_list_${res.status}`);
      const data = await res.json().catch(() => ({}));
      const list = data.data || data.result || [];
      if (!list.length) break;
      const hit = list.find(p => String(p.order_id) === orderId);
      if (hit) {
        return {
          status: hit.payment_status,
          paymentId: hit.payment_id,
          actuallyPaid: hit.actually_paid,
        };
      }
      // Everything below here is older; stop once the page's oldest predates the tx.
      const oldest = list[list.length - 1];
      const oldestMs = oldest && oldest.created_at ? new Date(oldest.created_at).getTime() : NaN;
      if (since && Number.isFinite(oldestMs) && oldestMs < since) break;
      if (list.length < limit) break;
    }
    return null;
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
