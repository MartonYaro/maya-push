import jwt from 'jsonwebtoken';
import { db } from '../db.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

/**
 * Block endpoints that consume AppTweak credits or paid resources
 * for users who haven't confirmed their email yet.
 *
 * Use after `requireAuth`. Returns 403 with code `email_verification_required`.
 */
export function requireVerified(req, res, next) {
  const u = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(req.user.id);
  if (!u) return res.status(401).json({ error: 'invalid_token' });
  if (!u.email_verified) {
    return res.status(403).json({
      error: 'email_verification_required',
      message: 'Подтверди email, чтобы пользоваться этой функцией.',
    });
  }
  next();
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}
