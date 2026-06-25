// Growth email: every 3 days, mail each user the keywords that climbed.
import { db } from '../db.js';
import { sendEmail, renderPositionDigestEmail } from './email.js';
import { appBase } from './notifications.js';

export async function runPositionDigest({ logger = console } = {}) {
  const since = Date.now() - 3 * 86400000;
  const users = db.prepare(`
    SELECT DISTINCT u.id, u.email, u.name
    FROM users u JOIN apps a ON a.user_id = u.id
    WHERE u.email_verified = 1 AND u.email_optout = 0
      AND u.email IS NOT NULL AND u.email NOT LIKE '%@telegram.local'
  `).all();

  let sent = 0;
  for (const u of users) {
    const kws = db.prepare(`
      SELECT k.id, k.term, k.current_pos, a.name AS app
      FROM keywords k JOIN apps a ON a.id = k.app_id
      WHERE a.user_id = ? AND k.status = 'active' AND k.current_pos IS NOT NULL
    `).all(u.id);

    const items = [];
    for (const k of kws) {
      const past = db.prepare(`
        SELECT position FROM keyword_positions
        WHERE keyword_id = ? AND checked_at <= ? AND position IS NOT NULL
        ORDER BY checked_at DESC LIMIT 1
      `).get(k.id, since);
      if (past && past.position != null && k.current_pos < past.position) {
        items.push({ term: k.term, app: k.app, from: past.position, to: k.current_pos });
      }
    }
    if (!items.length) continue;
    items.sort((a, b) => (b.from - b.to) - (a.from - a.to));
    try {
      await sendEmail({ to: u.email, ...renderPositionDigestEmail({ name: u.name, items, dashboardUrl: appBase() + '/dashboard' }) });
      sent++;
    } catch {}
  }
  logger.log(`[digest] position digest sent to ${sent} users`);
  return { sent };
}
