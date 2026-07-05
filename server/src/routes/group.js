// Public endpoints for the holding site (group-maya.com).
// No auth — callers are anonymous visitors; abuse is contained by a per-IP
// rate limit and a honeypot field.
import { Router } from 'express';
import { db, now } from '../db.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { notifyAdmin, tgEscape } from '../services/telegram.js';
import { audit } from '../services/audit.js';

const router = Router();

/**
 * Pageview beacon — in-house analytics for the holding landing.
 * Body: { path?, ref?, lang? }. No cookies, no IP stored, UA trimmed.
 */
router.post('/beacon', rateLimit({ windowMs: 60 * 60_000, max: 60 }), (req, res) => {
  try {
    const { path, ref, lang } = req.body || {};
    db.prepare(
      `INSERT INTO group_hits (path, referrer, lang, ua, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(
      String(path || '/').slice(0, 200),
      String(ref || '').slice(0, 200),
      String(lang || '').slice(0, 10),
      String(req.headers['user-agent'] || '').slice(0, 160),
      now()
    );
  } catch {}
  res.json({ ok: true });
});

/**
 * Contact form → Telegram admin chat. Body:
 *   { name*, contact*, company?, interest?, message*, website? (honeypot) }
 */
router.post('/contact', rateLimit({ windowMs: 60 * 60_000, max: 5 }), (req, res) => {
  const { name, contact, company, interest, message, website } = req.body || {};
  // Honeypot: real users never see the "website" field — accept bots silently.
  if (website) return res.json({ ok: true });

  const nm = String(name || '').trim().slice(0, 80);
  const ct = String(contact || '').trim().slice(0, 120);
  const co = String(company || '').trim().slice(0, 120);
  const it = String(interest || '').trim().slice(0, 60);
  const msg = String(message || '').trim().slice(0, 1500);
  if (!nm || !ct || !msg) return res.status(400).json({ error: 'missing_fields' });

  notifyAdmin(
    `🏛 <b>Заявка с group-maya.com</b>\n\n` +
    `👤 ${tgEscape(nm)}${co ? ` · ${tgEscape(co)}` : ''}\n` +
    `📮 <code>${tgEscape(ct)}</code>\n` +
    `🎯 ${tgEscape(it || '—')}\n\n` +
    `${tgEscape(msg)}`
  ).catch(() => {});
  try { audit(req, { action: 'group.contact', meta: { name: nm, contact: ct, interest: it } }); } catch {}
  res.json({ ok: true });
});

export default router;
