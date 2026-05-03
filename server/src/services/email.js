/**
 * Email sender. Uses Resend HTTP API if RESEND_API_KEY is set,
 * otherwise falls back to console.log so dev still sees the link.
 *
 * https://resend.com/docs/api-reference/emails/send-email
 */
const RESEND_URL = 'https://api.resend.com/emails';

function isConfigured() { return !!process.env.RESEND_API_KEY; }

function fromAddr() {
  return process.env.EMAIL_FROM || 'MAYA Push <onboarding@resend.dev>';
}

export async function sendEmail({ to, subject, html, text }) {
  if (!to) return { ok: false, error: 'no_to' };

  if (!isConfigured()) {
    console.log('\n┌─ EMAIL (no RESEND_API_KEY, console fallback) ──────');
    console.log(`│ to:      ${to}`);
    console.log(`│ subject: ${subject}`);
    console.log(`│ ${text || stripHtml(html)}`);
    console.log('└─────────────────────────────────────────────────────\n');
    return { ok: true, fallback: true };
  }

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddr(),
        to: Array.isArray(to) ? to : [to],
        subject,
        html: html || `<pre>${escapeHtml(text || '')}</pre>`,
        text: text || stripHtml(html || ''),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn('[email] resend error', res.status, data);
      return { ok: false, error: data.message || ('http_' + res.status) };
    }
    return { ok: true, id: data.id };
  } catch (e) {
    console.warn('[email] error', e.message);
    return { ok: false, error: e.message };
  }
}

function stripHtml(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ─────────────────── Templates ─────────────────── */

export function renderVerifyEmail({ name, verifyUrl }) {
  const subject = 'Подтвердите email — MAYA Push';
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background: #0a0908; color: #f0ead8;">
      <h1 style="font-size: 22px; margin-bottom: 8px;">Привет, ${escapeHtml(name)} 👋</h1>
      <p style="color: #b8b0a0; line-height: 1.5;">Это подтверждение email для <b>MAYA Push</b>.</p>
      <p>
        <a href="${verifyUrl}" style="display: inline-block; padding: 12px 24px; background: #3aff9f; color: #0a0908; text-decoration: none; font-weight: 700; margin: 16px 0;">Подтвердить email →</a>
      </p>
      <p style="color: #6a6358; font-size: 12px; margin-top: 24px;">Если кнопка не работает — ссылка: ${verifyUrl}</p>
      <p style="color: #6a6358; font-size: 12px;">Если вы не регистрировались — просто проигнорируйте письмо.</p>
    </div>`;
  const text = `Привет, ${name}!\n\nПодтвердите email перейдя по ссылке:\n${verifyUrl}\n\nЕсли вы не регистрировались — просто проигнорируйте.`;
  return { subject, html, text };
}

export function renderResetEmail({ name, resetUrl }) {
  const subject = 'Сброс пароля — MAYA Push';
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background: #0a0908; color: #f0ead8;">
      <h1 style="font-size: 22px;">Сброс пароля</h1>
      <p style="color: #b8b0a0; line-height: 1.5;">Привет, ${escapeHtml(name)}. Кто-то (надеемся, вы) запросил сброс пароля для аккаунта MAYA Push.</p>
      <p>
        <a href="${resetUrl}" style="display: inline-block; padding: 12px 24px; background: #3aff9f; color: #0a0908; text-decoration: none; font-weight: 700; margin: 16px 0;">Установить новый пароль →</a>
      </p>
      <p style="color: #6a6358; font-size: 12px;">Ссылка действительна 1 час. Если вы не запрашивали сброс — игнорируйте письмо, пароль не изменится.</p>
    </div>`;
  const text = `Сброс пароля для MAYA Push.\n\nСсылка (действительна 1 час):\n${resetUrl}\n\nЕсли вы не запрашивали — игнорируйте.`;
  return { subject, html, text };
}

export function renderWelcomeEmail({ name, dashboardUrl }) {
  const subject = '🎉 Добро пожаловать в MAYA Push';
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background: #0a0908; color: #f0ead8;">
      <h1 style="font-size: 22px;">Добро пожаловать, ${escapeHtml(name)}! 🎉</h1>
      <p style="color: #b8b0a0; line-height: 1.5;">
        Email подтверждён, аккаунт активен. Теперь:<br>
        1. Добавь приложение из&nbsp;App Store<br>
        2. Укажи ключи которые хочешь продвинуть<br>
        3. Запусти кампанию или просто наблюдай за&nbsp;позициями
      </p>
      <p><a href="${dashboardUrl}" style="display: inline-block; padding: 12px 24px; background: #3aff9f; color: #0a0908; text-decoration: none; font-weight: 700;">Открыть кабинет →</a></p>
      <p style="color: #6a6358; font-size: 12px; margin-top: 24px;">Вопросы — в Telegram <a href="https://t.me/ojakos" style="color: #3aff9f;">@ojakos</a></p>
    </div>`;
  const text = `Добро пожаловать, ${name}!\n\nКабинет: ${dashboardUrl}\nПоддержка: @ojakos`;
  return { subject, html, text };
}
