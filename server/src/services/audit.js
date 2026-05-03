/**
 * Audit log helper. Records security-relevant events.
 * Schema: audit_log(user_id, actor_id, action, meta, ip, user_agent, created_at)
 */
import { db, now } from '../db.js';

export function audit(req, { userId = null, actorId = null, action, meta = null }) {
  const ip = (req && (req.headers?.['x-forwarded-for'] || req.ip || req.socket?.remoteAddress) || '')
    .toString().split(',')[0].trim();
  const ua = (req && req.headers?.['user-agent'] || '').toString().slice(0, 300);
  try {
    db.prepare(
      `INSERT INTO audit_log (user_id, actor_id, action, meta, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId, actorId || userId, action,
      meta ? JSON.stringify(meta) : null,
      ip || null, ua || null, now()
    );
  } catch (e) { console.warn('[audit] failed:', e.message); }
}
