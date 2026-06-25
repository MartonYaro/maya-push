import { Router } from 'express';
import { db, REFERRAL_RATE } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

function publicBase() {
  if (process.env.APP_PUBLIC_URL) return process.env.APP_PUBLIC_URL.replace(/\/$/, '');
  if (process.env.APP_HOST) return `https://${process.env.APP_HOST}`;
  return (process.env.PUBLIC_URL || '').replace(/\/$/, '');
}
function maskEmail(e) {
  const s = String(e || '');
  const [u, d] = s.split('@');
  if (!d) return s;
  return (u.length <= 2 ? u : u.slice(0, 2) + '***') + '@' + d;
}

router.get('/', (req, res) => {
  const me = req.user.id;
  const u = db.prepare('SELECT ref_code, ref_rate FROM users WHERE id = ?').get(me) || {};
  const count = db.prepare('SELECT COUNT(*) AS n FROM users WHERE referred_by = ?').get(me).n;
  const earned = db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE user_id = ? AND type = 'referral' AND status = 'done'`
  ).get(me).s || 0;
  const rate = u.ref_rate != null ? Number(u.ref_rate) : REFERRAL_RATE();
  const referrals = db.prepare(
    'SELECT name, email, created_at FROM users WHERE referred_by = ? ORDER BY created_at DESC LIMIT 100'
  ).all(me);

  res.json({
    code: u.ref_code || null,
    link: u.ref_code ? `${publicBase()}/dashboard?ref=${u.ref_code}` : null,
    rate,
    count,
    earned,
    referrals: referrals.map(r => ({ name: r.name, email: maskEmail(r.email), joined: r.created_at })),
  });
});

export default router;
