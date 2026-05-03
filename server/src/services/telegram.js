/**
 * Telegram bot notifications.
 * Configured via env:
 *   TELEGRAM_BOT_TOKEN — from @BotFather
 *   TELEGRAM_ADMIN_CHAT — chat id of manager (string of numbers)
 *
 * If unset → no-op (logs to console).
 */
const API = (token) => `https://api.telegram.org/bot${token}`;

function isConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT);
}

export async function notifyAdmin(text, opts = {}) {
  if (!isConfigured()) {
    console.log('[telegram] (no token) ' + text.slice(0, 200));
    return { ok: false, fallback: true };
  }
  try {
    const url = `${API(process.env.TELEGRAM_BOT_TOKEN)}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_ADMIN_CHAT,
        text,
        parse_mode: opts.parseMode || 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      console.warn('[telegram] error', res.status, json);
      return { ok: false, error: json.description };
    }
    return { ok: true };
  } catch (e) {
    console.warn('[telegram] fetch error', e.message);
    return { ok: false, error: e.message };
  }
}

/* ─────────────── Templates ─────────────── */

export function tgEscape(s) {
  return String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export function tgNewSignup({ user, ip, ua }) {
  return `🆕 <b>Новая регистрация MAYA</b>
👤 <b>${tgEscape(user.name)}</b>
✉️ <code>${tgEscape(user.email)}</code>
🆔 #${user.id}
🌐 IP: <code>${tgEscape(ip || '-')}</code>
📱 UA: ${tgEscape((ua || '').slice(0, 80))}`;
}

export function tgNewTopup({ user, amount }) {
  return `💰 <b>Новая заявка на пополнение</b>
👤 ${tgEscape(user.name)} · <code>${tgEscape(user.email)}</code>
💵 <b>$${Number(amount).toFixed(0)}</b>
Подтверди в админке: /admin → «Заявки на пополнение»`;
}
