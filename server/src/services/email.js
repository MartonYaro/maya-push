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

// Branded, email-client-safe shell (table layout + inline styles — Gmail/Outlook
// strip <style> and don't support flex/grid). Dark theme matching the landing.
function emailShell({ preheader, heading, intro, bodyHtml = '', ctaText, ctaUrl, note }) {
  return `<!DOCTYPE html>
<html lang="ru" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>MAYA Push</title>
</head>
<body style="margin:0; padding:0; background:#070605; -webkit-text-size-adjust:100%;">
  <span style="display:none!important; visibility:hidden; opacity:0; height:0; width:0; overflow:hidden; mso-hide:all;">${escapeHtml(preheader || heading)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#070605;">
    <tr><td align="center" style="padding:32px 14px;">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px; max-width:100%; background:#100e0c; border:1px solid #232019; border-radius:18px; overflow:hidden;">

        <tr><td style="padding:22px 32px; background:#0a0908; border-bottom:1px solid #232019;">
          <span style="font-family:Arial,Helvetica,sans-serif; font-weight:800; font-size:18px; letter-spacing:1.5px; color:#f0ead8;">
            <span style="color:#3aff9f;">&#9650;</span>&nbsp; MAYA <span style="color:#8a8378; font-weight:600;">PUSH</span>
          </span>
        </td></tr>

        <tr><td style="padding:38px 32px 6px; font-family:Arial,Helvetica,sans-serif;">
          <h1 style="margin:0 0 16px; font-size:25px; line-height:1.25; color:#f0ead8; font-weight:800; letter-spacing:-0.01em;">${heading}</h1>
          ${intro ? `<p style="margin:0 0 8px; font-size:15px; line-height:1.6; color:#b8b0a0;">${intro}</p>` : ''}
          ${bodyHtml}
          ${ctaText ? `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 8px;">
            <tr><td align="center" bgcolor="#3aff9f" style="border-radius:11px;">
              <a href="${ctaUrl}" target="_blank" style="display:inline-block; padding:15px 34px; font-family:Arial,Helvetica,sans-serif; font-size:15px; font-weight:700; color:#0a0908; text-decoration:none; border-radius:11px;">${ctaText}</a>
            </td></tr>
          </table>` : ''}
          ${note ? `<p style="margin:18px 0 0; font-size:12px; line-height:1.6; color:#6a6358;">${note}</p>` : ''}
        </td></tr>

        <tr><td style="padding:24px 32px 30px; border-top:1px solid #232019; font-family:Arial,Helvetica,sans-serif;">
          <p style="margin:0; font-size:12px; color:#6a6358;">MAYA&nbsp;Push — позиции в&nbsp;App&nbsp;Store и&nbsp;мотивированные установки · <a href="https://mayapush.com" style="color:#3aff9f; text-decoration:none;">mayapush.com</a></p>
          <p style="margin:7px 0 0; font-size:12px; color:#54504a;">Поддержка — Telegram <a href="https://t.me/MayaPush_bot" style="color:#3aff9f; text-decoration:none;">@MayaPush_bot</a></p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function renderVerifyEmail({ name, verifyUrl }) {
  const subject = 'Подтвердите email — MAYA Push';
  const html = emailShell({
    preheader: 'Один клик — и аккаунт активен.',
    heading: `Привет, ${escapeHtml(name)} 👋`,
    intro: 'Остался один шаг — подтвердите email, чтобы активировать аккаунт <b style="color:#f0ead8;">MAYA&nbsp;Push</b> и открыть кабинет.',
    ctaText: 'Подтвердить email →',
    ctaUrl: verifyUrl,
    note: `Если кнопка не открывается — скопируйте ссылку:<br><a href="${verifyUrl}" style="color:#3aff9f; word-break:break-all;">${verifyUrl}</a><br><br>Если вы не регистрировались — просто проигнорируйте это письмо.`,
  });
  const text = `Привет, ${name}!\n\nПодтвердите email, перейдя по ссылке:\n${verifyUrl}\n\nЕсли вы не регистрировались — просто проигнорируйте письмо.`;
  return { subject, html, text };
}

export function renderResetEmail({ name, resetUrl }) {
  const subject = 'Сброс пароля — MAYA Push';
  const html = emailShell({
    preheader: 'Ссылка для сброса пароля действительна 1 час.',
    heading: 'Сброс пароля',
    intro: `Привет, ${escapeHtml(name)}. Кто-то (надеемся, вы) запросил сброс пароля для аккаунта MAYA&nbsp;Push.`,
    ctaText: 'Установить новый пароль →',
    ctaUrl: resetUrl,
    note: 'Ссылка действительна 1&nbsp;час. Если вы не запрашивали сброс — игнорируйте письмо, пароль останется прежним.',
  });
  const text = `Сброс пароля для MAYA Push.\n\nСсылка (действительна 1 час):\n${resetUrl}\n\nЕсли вы не запрашивали — игнорируйте.`;
  return { subject, html, text };
}

export function renderWelcomeEmail({ name, dashboardUrl }) {
  const subject = '🎉 Добро пожаловать в MAYA Push';
  const steps = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px;">
      ${[
        'Добавьте приложение из&nbsp;App&nbsp;Store',
        'Укажите ключи, которые хотите продвинуть',
        'Запустите кампанию или просто следите за&nbsp;позициями',
      ].map((s, i) => `
      <tr><td style="padding:6px 0; font-family:Arial,Helvetica,sans-serif; font-size:15px; color:#b8b0a0; line-height:1.5;">
        <span style="display:inline-block; width:24px; height:24px; background:#16261d; color:#3aff9f; border-radius:6px; text-align:center; line-height:24px; font-weight:700; font-size:13px; margin-right:10px;">${i + 1}</span>${s}
      </td></tr>`).join('')}
    </table>`;
  const html = emailShell({
    preheader: 'Email подтверждён — аккаунт активен.',
    heading: `Добро пожаловать, ${escapeHtml(name)}! 🎉`,
    intro: 'Email подтверждён, аккаунт активен. Дальше всё просто:',
    bodyHtml: steps,
    ctaText: 'Открыть кабинет →',
    ctaUrl: dashboardUrl,
  });
  const text = `Добро пожаловать, ${name}!\n\nКабинет: ${dashboardUrl}\nПоддержка: @MayaPush_bot`;
  return { subject, html, text };
}

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 });

export function renderTopupConfirmedEmail({ name, amount, balance, dashboardUrl }) {
  const subject = `Баланс пополнен на ${money(amount)} — MAYA Push`;
  const html = emailShell({
    preheader: `Зачислено ${money(amount)}. Баланс: ${money(balance)}.`,
    heading: 'Баланс пополнен ✅',
    intro: `Привет, ${escapeHtml(name)}. Зачислили <b style="color:#3aff9f;">${money(amount)}</b> на ваш баланс. Текущий баланс — <b style="color:#f0ead8;">${money(balance)}</b>. Можно запускать кампании.`,
    ctaText: 'В кабинет →',
    ctaUrl: dashboardUrl,
  });
  const text = `Баланс пополнен на ${money(amount)}.\nТекущий баланс: ${money(balance)}.\nКабинет: ${dashboardUrl}`;
  return { subject, html, text };
}

export function renderLowBalanceEmail({ name, balance, topupUrl }) {
  const subject = 'Баланс заканчивается — MAYA Push';
  const html = emailShell({
    preheader: `На балансе осталось ${money(balance)}.`,
    heading: 'Баланс заканчивается',
    intro: `Привет, ${escapeHtml(name)}. На вашем балансе осталось <b style="color:#f0ead8;">${money(balance)}</b>. Пополните, чтобы кампании установок не&nbsp;останавливались и&nbsp;позиции продолжали расти.`,
    ctaText: 'Пополнить баланс →',
    ctaUrl: topupUrl,
    note: 'Оплата криптой зачисляется автоматически за&nbsp;минуты.',
  });
  const text = `На балансе осталось ${money(balance)}. Пополнить: ${topupUrl}`;
  return { subject, html, text };
}

export function renderPositionDigestEmail({ name, items, dashboardUrl }) {
  const subject = `Позиции растут 🚀 — ${items.length} ${items.length === 1 ? 'ключ' : 'ключей'} вверх`;
  const rows = items.slice(0, 20).map(it => `
    <tr><td style="padding:7px 0; border-bottom:1px solid #232019; font-family:Arial,sans-serif; font-size:14px; color:#b8b0a0;">
      <b style="color:#f0ead8;">${escapeHtml(it.term)}</b>${it.app ? ` <span style="color:#6a6358;">· ${escapeHtml(it.app)}</span>` : ''}
    </td><td align="right" style="padding:7px 0; border-bottom:1px solid #232019; font-family:Arial,sans-serif; font-size:14px; white-space:nowrap;">
      <span style="color:#6a6358;">#${it.from}</span> <span style="color:#6a6358;">→</span> <b style="color:#3aff9f;">#${it.to}</b> <span style="color:#3aff9f;">↑${it.from - it.to}</span>
    </td></tr>`).join('');
  const html = emailShell({
    preheader: `${items.length} ключей поднялись за 3 дня.`,
    heading: 'Ваши позиции растут 🚀',
    intro: 'За последние 3&nbsp;дня вы поднялись по&nbsp;этим запросам:',
    bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px;">${rows}</table>`,
    ctaText: 'Посмотреть все позиции →',
    ctaUrl: dashboardUrl,
  });
  const text = `Позиции растут!\n\n` + items.map(it => `${it.term}${it.app ? ' (' + it.app + ')' : ''}: #${it.from} → #${it.to}`).join('\n') + `\n\nКабинет: ${dashboardUrl}`;
  return { subject, html, text };
}
