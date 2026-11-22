// Доставка SMS-кодов входа BLOOP — без платных SMS-шлюзов.
//
// Настоящую SMS оператору отправить «из воздуха» нельзя: в любой стране
// это платный сервис. Поэтому слой доставки переключается переменными
// окружения и поддерживает бесплатные каналы:
//
//   console   — код в консоль сервера (по умолчанию, работает сразу)
//   telegram  — код реально приходит НА ТЕЛЕФОН через вашего Telegram-бота:
//               BLOOP_SMS_MODE=telegram BLOOP_TELEGRAM_BOT_TOKEN=...
//               Пользователь один раз пишет боту свой номер — дальше все
//               коды входа приходят в Telegram (телефон всегда с собой).
//   webhook   — если позже появится любой SMS-провайдер: BLOOP_SMS_WEBHOOK_URL
//               (POST JSON { phone, code } — можно связать с любым шлюзом)
//
// Никаких внешних зависимостей: только встроенный fetch (Node 18+).
import { saveTelegramLink, getTelegramLink } from './db.js';

const MODE = (process.env.BLOOP_SMS_MODE || 'console').trim().toLowerCase();
const BOT_TOKEN = process.env.BLOOP_TELEGRAM_BOT_TOKEN || '';
const WEBHOOK_URL = process.env.BLOOP_SMS_WEBHOOK_URL || '';

let botUsername = null; // заполняется из getMe при старте Telegram-режима

function tgApi(method, params) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  }).then(r => r.json());
}

/**
 * Отправляет код выбранным каналом.
 * @returns {Promise<{channel: string, bot_username: string|null}>}
 *   channel: 'telegram' | 'telegram-not-linked' | 'console' | 'webhook'
 */
export async function deliverCode(phone, code) {
  console.log(`📱 SMS-код для ${phone}: ${code}`); // код всегда дублируется в консоль

  if (MODE === 'telegram' && BOT_TOKEN) {
    const link = getTelegramLink(phone);
    if (link) {
      const res = await tgApi('sendMessage', {
        chat_id: link.chat_id,
        text: `🔐 BLOOP: ваш код входа ${code}\n\nНикому его не говорите. Действует 5 минут.`,
      });
      if (res?.ok) return { channel: 'telegram', bot_username: botUsername };
      console.warn('BLOOP SMS: Telegram sendMessage не удался:', res?.description);
      return { channel: 'console', bot_username: null };
    }
    return { channel: 'telegram-not-linked', bot_username: botUsername };
  }

  if (MODE === 'webhook' && WEBHOOK_URL) {
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code, text: `BLOOP: код ${code}` }),
      });
      if (res.ok) return { channel: 'webhook', bot_username: null };
      console.warn('BLOOP SMS: webhook вернул', res.status);
    } catch (e) {
      console.warn('BLOOP SMS: webhook недоступен:', e.message);
    }
  }

  return { channel: 'console', bot_username: null };
}

/** Активен ли Telegram-канал (нужен для UI-подсказок на этапе «номер»). */
export function telegramConfigured() {
  return MODE === 'telegram' && !!BOT_TOKEN;
}

export function telegramBotUsername() {
  return botUsername;
}

// Поллинг getUpdates: пользователь пишет боту свой номер (+79991234567) —
// привязываем его Telegram-чат к телефону. Работает, только если задан токен.
export async function startTelegramPoller() {
  if (!telegramConfigured()) return;
  try {
    const me = await tgApi('getMe', {});
    if (!me?.ok) {
      console.warn('BLOOP SMS: Telegram-бот не отвечает, каналы: console. Проверьте BLOOP_TELEGRAM_BOT_TOKEN');
      return;
    }
    botUsername = me.result.username;
    console.log(`📱 SMS-доставка: Telegram-бот @${botUsername} готов. Пришлите ему свой номер телефона (+7…), чтобы получать коды входа.`);
  } catch (e) {
    console.warn('BLOOP SMS: getMe не удался:', e.message);
    return;
  }

  let offset = 0;
  const tick = async () => {
    try {
      const res = await tgApi('getUpdates', { offset, timeout: 25 });
      if (res?.ok) {
        for (const upd of res.result || []) {
          offset = Math.max(offset, (upd.update_id || 0) + 1);
          const msg = upd.message;
          const text = String(msg?.text || '').trim();
          const chatId = msg?.chat?.id;
          if (!chatId || !text) continue;
          const norm = '+' + text.replace(/[\s()\u2013\u2014-]|\+/g, '').replace(/\D/g, '');
          if (/^\+\d{7,15}$/.test(norm)) {
            saveTelegramLink(norm, chatId);
            await tgApi('sendMessage', {
              chat_id: chatId,
              text: `✅ Номер ${norm} сохранён. Теперь коды входа BLOOP будут приходить в этот чат.`,
            });
          } else {
            await tgApi('sendMessage', {
              chat_id: chatId,
              text: 'Пришлите номер телефона в формате +79991234567 — он будет привязан для получения кодов входа BLOOP.',
            });
          }
        }
      }
    } catch (e) {
      console.warn('BLOOP SMS: getUpdates ошибка:', e.message);
    }
    setTimeout(tick, 1500);
  };
  tick();
}
