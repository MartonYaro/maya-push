// Lifecycle email notifications (money + growth). Fire-and-forget — never
// block the request path, never throw.
import { db, getBalance } from '../db.js';
import { sendEmail, renderTopupConfirmedEmail, renderLowBalanceEmail } from './email.js';

export function appBase() {
  if (process.env.APP_PUBLIC_URL) return process.env.APP_PUBLIC_URL.replace(/\/$/, '');
  if (process.env.APP_HOST) return `https://${process.env.APP_HOST}`;
  return (process.env.PUBLIC_URL || '').replace(/\/$/, '');
}
const LOW_BALANCE = () => Number(process.env.LOW_BALANCE_THRESHOLD) || 50;

function realEmail(u) {
  return u && u.email && !String(u.email).endsWith('@telegram.local') ? u.email : null;
}

/** Top-up confirmed (manual or crypto). Also clears the low-balance flag. */
export function emailTopupConfirmed(userId, amount) {
  try {
    const u = db.prepare('SELECT email, name FROM users WHERE id = ?').get(userId);
    const to = realEmail(u);
    const bal = getBalance(userId);
    if (bal >= LOW_BALANCE()) db.prepare('UPDATE users SET low_balance_notified = 0 WHERE id = ?').run(userId);
    if (!to) return;
    sendEmail({ to, ...renderTopupConfirmedEmail({ name: u.name, amount, balance: bal, dashboardUrl: appBase() + '/dashboard' }) }).catch(() => {});
  } catch {}
}

/** After a spend: warn once when balance drops below the threshold. */
export function maybeEmailLowBalance(userId) {
  try {
    const u = db.prepare('SELECT email, name, low_balance_notified FROM users WHERE id = ?').get(userId);
    const to = realEmail(u);
    const bal = getBalance(userId);
    if (bal < LOW_BALANCE() && !u.low_balance_notified) {
      db.prepare('UPDATE users SET low_balance_notified = 1 WHERE id = ?').run(userId);
      if (to) sendEmail({ to, ...renderLowBalanceEmail({ name: u.name, balance: bal, topupUrl: appBase() + '/dashboard#topup' }) }).catch(() => {});
    }
  } catch {}
}
