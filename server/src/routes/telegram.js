// Telegram support-desk webhook (public; authenticated by Telegram's secret header).
//
// Flow:
//   user → @MayaPush_bot         ── relayed to the admin chat
//   admin replies (reply-to)     ── delivered back to that user
//
// Setup (once): set TELEGRAM_WEBHOOK_SECRET, then register the webhook:
//   https://api.telegram.org/bot<token>/setWebhook?url=https://app.mayapush.com/api/telegram/webhook&secret_token=<secret>
import { Router } from 'express';
import { db, now } from '../db.js';
import { sendMessage, tgEscape } from '../services/telegram.js';

const router = Router();

router.post('/webhook', async (req, res) => {
  // Always ACK fast so Telegram doesn't retry; do the work, then 200.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).json({ error: 'bad_secret' });
  }
  res.json({ ok: true });

  try {
    const msg = req.body && req.body.message;
    if (!msg || !msg.chat) return;

    const adminChat = String(process.env.TELEGRAM_ADMIN_CHAT || '');
    const fromAdmin = adminChat && String(msg.chat.id) === adminChat;
    const text = (msg.text || '').trim();

    // ── Admin replying to a relayed support message ──
    if (fromAdmin) {
      const replyId = msg.reply_to_message && msg.reply_to_message.message_id;
      if (replyId && text) {
        const map = db.prepare('SELECT * FROM support_map WHERE admin_msg_id = ?').get(replyId);
        if (map) {
          const r = await sendMessage(map.user_chat_id, `💬 <b>Поддержка MAYA Push</b>\n\n${tgEscape(text)}`);
          await sendMessage(adminChat, r.ok ? '✓ Отправлено' : '⚠️ Не доставлено', { replyTo: msg.message_id });
        }
      }
      return; // ignore other admin chatter
    }

    // ── Message from a user ──
    const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Гость';
    const uname = msg.from?.username ? `@${msg.from.username}` : '—';

    if (text === '/start') {
      await sendMessage(msg.chat.id,
        `👋 Это поддержка <b>MAYA Push</b>.\n\nОпишите вопрос одним сообщением — менеджер ответит прямо здесь. Обычно отвечаем в течение рабочего дня.`);
      return;
    }

    const body = text || '(вложение без текста)';
    const header = `💬 <b>Поддержка</b> · ${tgEscape(name)} (${tgEscape(uname)}, id <code>${msg.chat.id}</code>)\n<i>Ответьте на это сообщение — ответ уйдёт пользователю.</i>\n\n${tgEscape(body)}`;
    const sent = await sendMessage(adminChat, header);
    if (sent.ok && sent.message_id) {
      db.prepare('INSERT OR REPLACE INTO support_map (admin_msg_id, user_chat_id, user_name, created_at) VALUES (?, ?, ?, ?)')
        .run(sent.message_id, msg.chat.id, name, now());
      await sendMessage(msg.chat.id, '✅ Сообщение получено — поддержка скоро ответит здесь.');
    }
  } catch (e) {
    // swallow — we already ACKed Telegram
  }
});

export default router;
