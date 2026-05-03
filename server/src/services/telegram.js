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

function publicUrl(path = '') {
  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  return base ? base + path : path;
}

export async function notifyAdmin(text, opts = {}) {
  if (!isConfigured()) {
    console.log('[telegram] (no token) ' + String(text).slice(0, 200));
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
        reply_markup: opts.reply_markup,
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
  return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function fmtMoney(n) { return '$' + Number(n || 0).toFixed(2); }
function fmtInt(n) { return Number(n || 0).toLocaleString('en-US').replace(/,/g, ' '); }

export function tgNewSignup({ user, ip, ua }) {
  return `🆕 <b>Новая регистрация</b>
👤 <b>${tgEscape(user.name)}</b>
✉️ <code>${tgEscape(user.email)}</code>
🆔 #${user.id}
🌐 IP: <code>${tgEscape(ip || '-')}</code>
📱 UA: ${tgEscape((ua || '').slice(0, 80))}`;
}

export function tgNewTopup({ user, amount, method, comment, txId }) {
  const adminLink = publicUrl('/admin');
  return `💰 <b>Заявка на пополнение</b>

👤 ${tgEscape(user.name)}
✉️ <code>${tgEscape(user.email)}</code>
🆔 user #${user.id}

💵 Сумма: <b>${fmtMoney(amount)}</b>
🏦 Метод: ${tgEscape(method || 'manager')}
📝 ${tgEscape(comment || '—')}

🧾 TX #${txId}
🔗 <a href="${adminLink}">Открыть админку</a>`;
}

export function tgTopupConfirmed({ user, amount, txId, balance }) {
  return `✅ <b>Пополнение подтверждено</b>
👤 ${tgEscape(user.name)} (<code>${tgEscape(user.email)}</code>)
💵 ${fmtMoney(amount)} · TX #${txId}
💳 Новый баланс: <b>${fmtMoney(balance)}</b>`;
}

/**
 * Single install order from a user (one keyword × one day, or batch).
 *   { user, app, keyword, date, count, cost, balance }
 */
export function tgInstallOrder({ user, app, keyword, date, count, cost, balance }) {
  const adminLink = publicUrl('/admin');
  return `🚀 <b>Новый заказ установок</b>

👤 ${tgEscape(user.name)} · <code>${tgEscape(user.email)}</code>
📱 <b>${tgEscape(app.name)}</b> · ${tgEscape((app.country || '').toUpperCase())}
🔑 Ключ: <b>${tgEscape(keyword.term)}</b>
📅 Дата: <code>${tgEscape(date)}</code>
🎯 Тариф: ${tgEscape(keyword.plan || 'standard')}

📊 Установок: <b>${fmtInt(count)}</b>
💸 Списано: <b>${fmtMoney(cost)}</b>
💰 Остаток: ${fmtMoney(balance)}

🔗 <a href="${adminLink}">Админка</a>`;
}

/** When user cancels a previously scheduled order (count=0). */
export function tgInstallCancelled({ user, app, keyword, date, refund, balance }) {
  return `❌ <b>Отмена заказа установок</b>
👤 ${tgEscape(user.name)} · <code>${tgEscape(user.email)}</code>
📱 ${tgEscape(app.name)} · 🔑 ${tgEscape(keyword.term)} · 📅 ${tgEscape(date)}
↩️ Возврат: ${fmtMoney(refund)} · Баланс: ${fmtMoney(balance)}`;
}
