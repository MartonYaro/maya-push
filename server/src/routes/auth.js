import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db, now, getBalance, maybePromoteAdmin } from '../db.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { sendEmail, renderVerifyEmail, renderResetEmail, renderWelcomeEmail } from '../services/email.js';
import { notifyAdmin, tgNewSignup } from '../services/telegram.js';
import { audit } from '../services/audit.js';

const router = Router();

const PUBLIC_URL = () => process.env.PUBLIC_URL || 'http://localhost:3000';

const VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RESET_TTL_MS  = 60 * 60 * 1000;          // 1 hour

function rand(bytes = 32) { return crypto.randomBytes(bytes).toString('hex'); }

/* ────── Validation helpers ────── */

function validateEmail(s) {
  if (!s) return false;
  const v = String(s).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 200;
}

function validatePassword(s) {
  if (!s || typeof s !== 'string') return 'password_too_short';
  if (s.length < 8) return 'password_too_short';
  if (s.length > 128) return 'password_too_long';
  if (!/[A-Za-zА-Яа-я]/.test(s)) return 'password_needs_letter';
  if (!/\d/.test(s)) return 'password_needs_digit';
  return null;
}

/* ═══════════════════════════════════════════════════
   REGISTER
   ═══════════════════════════════════════════════════ */

router.post('/register',
  rateLimit({ windowMs: 60 * 60_000, max: 10 }),  // 10 регистраций в час с IP
  async (req, res) => {
    const { email, password, name, accept_tos, hp_field } = req.body || {};

    // Honeypot — bots fill ALL visible fields including hidden ones
    if (hp_field) {
      console.warn('[auth] honeypot triggered, hp_field=', hp_field);
      // Pretend success to confuse bots
      return res.status(200).json({ token: 'noop', user: { id: 0, email, name } });
    }

    if (!validateEmail(email)) return res.status(400).json({ error: 'invalid_email' });
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    if (!name || String(name).trim().length < 2) return res.status(400).json({ error: 'invalid_name' });
    if (!accept_tos) return res.status(400).json({ error: 'must_accept_tos' });

    const norm = String(email).trim().toLowerCase();
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(norm);
    if (exists) return res.status(409).json({ error: 'email_taken' });

    // Pilot mode: if there is no email service configured (or AUTH_AUTO_VERIFY=1),
    // we cannot send verification links — so don't lock users out. Accounts are
    // created already-verified. Strict verification turns on automatically once
    // RESEND_API_KEY is set.
    const emailConfigured = !!process.env.RESEND_API_KEY;
    const autoVerify = !emailConfigured || process.env.AUTH_AUTO_VERIFY === '1';

    const hash = await bcrypt.hash(password, 10);
    const info = db.prepare(
      `INSERT INTO users (email, password_hash, name, created_at, email_verified) VALUES (?, ?, ?, ?, ?)`
    ).run(norm, hash, String(name).trim(), now(), autoVerify ? 1 : 0);

    const user = { id: info.lastInsertRowid, email: norm, name: String(name).trim() };

    db.prepare(
      `INSERT INTO transactions (user_id, type, amount, status, description, created_at)
       VALUES (?, 'system', 0, 'done', 'Регистрация аккаунта', ?)`
    ).run(user.id, now());

    // Only issue a verification token + send email when email is actually configured
    if (!autoVerify) {
      const token = rand(24);
      db.prepare(
        `INSERT INTO email_verifications (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
      ).run(token, user.id, now() + VERIFY_TTL_MS, now());

      const verifyUrl = `${PUBLIC_URL()}/api/auth/verify?token=${token}`;
      sendEmail({
        to: user.email,
        ...renderVerifyEmail({ name: user.name, verifyUrl }),
      }).catch(() => {});
    }

    // Notify admin via Telegram
    notifyAdmin(tgNewSignup({
      user, ip: req.headers['x-forwarded-for'] || req.ip,
      ua: req.headers['user-agent'],
    })).catch(() => {});

    audit(req, { userId: user.id, action: 'auth.register' });

    const jwt = signToken(user);
    res.json({ token: jwt, user, requires_verification: !autoVerify });
  }
);

/* ═══════════════════════════════════════════════════
   LOGIN
   ═══════════════════════════════════════════════════ */

router.post('/login',
  rateLimit({ windowMs: 15 * 60_000, max: 10 }),  // 10 попыток / 15 мин с IP
  async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
    const norm = String(email).trim().toLowerCase();
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(norm);
    if (!row) {
      audit(req, { action: 'auth.login_failed', meta: { email: norm, reason: 'no_user' } });
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      audit(req, { userId: row.id, action: 'auth.login_failed', meta: { reason: 'bad_password' } });
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), row.id);
    maybePromoteAdmin(row.email);
    audit(req, { userId: row.id, action: 'auth.login' });

    const user = { id: row.id, email: row.email, name: row.name };
    const token = signToken(user);
    const emailConfigured = !!process.env.RESEND_API_KEY;
    const verified = (!emailConfigured || process.env.AUTH_AUTO_VERIFY === '1') ? true : !!row.email_verified;
    res.json({ token, user, email_verified: verified });
  }
);

/* ═══════════════════════════════════════════════════
   SOCIAL LOGIN  (Google + Telegram)
   ═══════════════════════════════════════════════════ */

/** Find-or-create a user from a social provider, link provider id to an
 *  existing account when the email matches. Returns { id, email, name }. */
function upsertSocialUser(req, { provider, googleId = null, telegramId = null, email = null, name, avatar = null, telegram = null }) {
  let row = null;
  if (googleId)   row = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);
  if (!row && telegramId) row = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  if (!row && email)      row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (row) {
    db.prepare(
      `UPDATE users SET
         google_id   = COALESCE(?, google_id),
         telegram_id = COALESCE(?, telegram_id),
         avatar_url  = COALESCE(?, avatar_url),
         telegram    = COALESCE(?, telegram),
         last_login_at = ?
       WHERE id = ?`
    ).run(googleId, telegramId, avatar, telegram, now(), row.id);
    maybePromoteAdmin(row.email);
    audit(req, { userId: row.id, action: 'auth.login_' + provider });
    return { id: row.id, email: row.email, name: row.name };
  }

  const finalEmail = email || `tg${telegramId}@telegram.local`;
  const info = db.prepare(
    `INSERT INTO users (email, password_hash, name, created_at, email_verified, provider, google_id, telegram_id, avatar_url, telegram)
     VALUES (?, '', ?, ?, 1, ?, ?, ?, ?, ?)`
  ).run(finalEmail, name, now(), provider, googleId, telegramId, avatar, telegram);
  const id = info.lastInsertRowid;
  db.prepare(
    `INSERT INTO transactions (user_id, type, amount, status, description, created_at)
     VALUES (?, 'system', 0, 'done', ?, ?)`
  ).run(id, 'Регистрация через ' + provider, now());
  const u = { id, email: finalEmail, name };
  maybePromoteAdmin(finalEmail);
  audit(req, { userId: id, action: 'auth.register_' + provider });
  notifyAdmin(tgNewSignup({ user: u, ip: req.headers['x-forwarded-for'] || req.ip, ua: req.headers['user-agent'] })).catch(() => {});
  return u;
}

/** Google Sign-In: verify the GIS ID token, then upsert. Body: { credential } */
router.post('/google',
  rateLimit({ windowMs: 15 * 60_000, max: 20 }),
  async (req, res) => {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: 'missing_credential' });

    let info;
    try {
      const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
      info = await r.json();
      if (!r.ok || !info || !info.sub) throw new Error('invalid');
    } catch {
      return res.status(401).json({ error: 'google_verify_failed' });
    }
    // If a client id is configured, enforce audience match
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (clientId && info.aud !== clientId) {
      return res.status(401).json({ error: 'google_aud_mismatch' });
    }

    const email = (info.email || '').toLowerCase() || null;
    const name = info.name || (email ? email.split('@')[0] : 'User');
    const user = upsertSocialUser(req, {
      provider: 'google', googleId: info.sub, email, name, avatar: info.picture || null,
    });
    res.json({ token: signToken(user), user, email_verified: true });
  }
);

/** Telegram Login Widget: verify HMAC, then upsert.
 *  Body: { id, first_name, last_name?, username?, photo_url?, auth_date, hash } */
router.post('/telegram',
  rateLimit({ windowMs: 15 * 60_000, max: 20 }),
  (req, res) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return res.status(503).json({ error: 'telegram_not_configured' });

    const { hash, ...fields } = req.body || {};
    if (!hash || !fields.id) return res.status(400).json({ error: 'missing_fields' });

    // Verify per https://core.telegram.org/widgets/login#checking-authorization
    const checkString = Object.keys(fields).sort()
      .map(k => `${k}=${fields[k]}`).join('\n');
    const secret = crypto.createHash('sha256').update(botToken).digest();
    const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
    if (hmac !== hash) return res.status(401).json({ error: 'telegram_verify_failed' });

    if (fields.auth_date && (Date.now() / 1000 - Number(fields.auth_date)) > 86400) {
      return res.status(401).json({ error: 'telegram_expired' });
    }

    const tgId = String(fields.id);
    const name = [fields.first_name, fields.last_name].filter(Boolean).join(' ')
      || fields.username || ('tg' + tgId);
    const user = upsertSocialUser(req, {
      provider: 'telegram', telegramId: tgId, email: null, name,
      avatar: fields.photo_url || null, telegram: fields.username || null,
    });
    res.json({ token: signToken(user), user, email_verified: true });
  }
);

/* ═══════════════════════════════════════════════════
   ME
   ═══════════════════════════════════════════════════ */

router.get('/me', requireAuth, (req, res) => {
  const row = db.prepare(
    'SELECT id, email, name, role, email_verified, telegram, created_at, custom_install_price FROM users WHERE id = ?'
  ).get(req.user.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  // Pilot mode: report verified when email service isn't configured, so the
  // "confirm your email" banner doesn't nag when there's no way to confirm.
  const emailConfigured = !!process.env.RESEND_API_KEY;
  const verified = (!emailConfigured || process.env.AUTH_AUTO_VERIFY === '1') ? true : !!row.email_verified;
  res.json({
    user: { ...row, email_verified: verified ? 1 : 0 },
    balance: getBalance(row.id),
    email_verified: verified,
  });
});

/** Update profile (telegram contact for now). Body: { telegram } */
router.patch('/me', requireAuth, (req, res) => {
  const { telegram } = req.body || {};
  let tg = telegram == null ? null : String(telegram).trim();
  if (tg) {
    tg = tg.replace(/^@/, '').replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '');
    if (!/^[a-zA-Z0-9_]{4,32}$/.test(tg)) {
      return res.status(400).json({ error: 'invalid_telegram' });
    }
  } else {
    tg = null;
  }
  db.prepare('UPDATE users SET telegram = ? WHERE id = ?').run(tg, req.user.id);
  const row = db.prepare(
    'SELECT id, email, name, role, email_verified, telegram, created_at FROM users WHERE id = ?'
  ).get(req.user.id);
  res.json({ user: row });
});

/* ═══════════════════════════════════════════════════
   VERIFY EMAIL  (link clicked from email)
   ═══════════════════════════════════════════════════ */

router.get('/verify', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.redirect('/dashboard?verified=invalid');

  const row = db.prepare('SELECT * FROM email_verifications WHERE token = ?').get(token);
  if (!row) return res.redirect('/dashboard?verified=invalid');
  if (row.expires_at < now()) {
    db.prepare('DELETE FROM email_verifications WHERE token = ?').run(token);
    return res.redirect('/dashboard?verified=expired');
  }

  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
  db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(row.user_id);

  // Welcome email
  const u = db.prepare('SELECT email, name FROM users WHERE id = ?').get(row.user_id);
  if (u) {
    const dashboardUrl = `${PUBLIC_URL()}/dashboard`;
    sendEmail({ to: u.email, ...renderWelcomeEmail({ name: u.name, dashboardUrl }) }).catch(() => {});
  }

  audit(req, { userId: row.user_id, action: 'auth.email_verified' });
  res.redirect('/dashboard?verified=ok');
});

/* Re-send verification (authed user that's not yet verified). */
router.post('/resend-verification',
  requireAuth,
  rateLimit({ windowMs: 10 * 60_000, max: 5 }),
  (req, res) => {
    const u = db.prepare('SELECT id, email, name, email_verified FROM users WHERE id = ?').get(req.user.id);
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (u.email_verified) return res.json({ ok: true, already_verified: true });

    const token = rand(24);
    db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(u.id);
    db.prepare(
      `INSERT INTO email_verifications (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
    ).run(token, u.id, now() + VERIFY_TTL_MS, now());

    const verifyUrl = `${PUBLIC_URL()}/api/auth/verify?token=${token}`;
    sendEmail({ to: u.email, ...renderVerifyEmail({ name: u.name, verifyUrl }) }).catch(() => {});
    audit(req, { userId: u.id, action: 'auth.verification_resent' });
    res.json({ ok: true });
  }
);

/* ═══════════════════════════════════════════════════
   FORGOT / RESET PASSWORD
   ═══════════════════════════════════════════════════ */

router.post('/forgot',
  rateLimit({ windowMs: 60 * 60_000, max: 5 }),  // 5 запросов / час с IP
  async (req, res) => {
    const { email } = req.body || {};
    if (!validateEmail(email)) return res.status(400).json({ error: 'invalid_email' });
    const norm = String(email).trim().toLowerCase();
    const u = db.prepare('SELECT id, email, name FROM users WHERE email = ?').get(norm);

    // Always respond OK (prevents email enumeration)
    if (!u) {
      audit(req, { action: 'auth.forgot_unknown_email', meta: { email: norm } });
      return res.json({ ok: true });
    }

    const token = rand(24);
    db.prepare(
      `INSERT INTO password_resets (token, user_id, expires_at, created_at, used) VALUES (?, ?, ?, ?, 0)`
    ).run(token, u.id, now() + RESET_TTL_MS, now());

    const resetUrl = `${PUBLIC_URL()}/dashboard?reset=${token}`;
    sendEmail({ to: u.email, ...renderResetEmail({ name: u.name, resetUrl }) }).catch(() => {});

    audit(req, { userId: u.id, action: 'auth.forgot_requested' });
    res.json({ ok: true });
  }
);

router.post('/reset',
  rateLimit({ windowMs: 60 * 60_000, max: 10 }),
  async (req, res) => {
    const { token, password } = req.body || {};
    if (!token) return res.status(400).json({ error: 'missing_token' });
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const r = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(String(token));
    if (!r || r.used)              return res.status(400).json({ error: 'invalid_token' });
    if (r.expires_at < now())      return res.status(400).json({ error: 'expired_token' });

    const hash = await bcrypt.hash(password, 10);
    const tx = db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, r.user_id);
      db.prepare('UPDATE password_resets SET used = 1 WHERE token = ?').run(String(token));
      // Invalidate any other reset tokens for this user
      db.prepare('DELETE FROM password_resets WHERE user_id = ? AND token != ?').run(r.user_id, String(token));
    });
    tx();

    audit(req, { userId: r.user_id, action: 'auth.password_reset' });

    // Issue a fresh JWT so user is logged in immediately
    const u = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(r.user_id);
    const jwt = signToken(u);
    res.json({ ok: true, token: jwt, user: u });
  }
);

export default router;
