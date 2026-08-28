/**
 * Клієнт Telegram Bot API. Тільки транспорт — жодної логіки про клуби.
 *
 * Без бібліотеки навмисно. Нам потрібні три виклики з усього API
 * (sendMessage, getUpdates, setWebhook), а будь-який фреймворк тягне свою
 * модель сцен і станів, під яку довелось би підганяти наші ролі й клуби.
 */

const API = 'https://api.telegram.org';

export const botToken = () => process.env.TELEGRAM_BOT_TOKEN ?? '';

/** Чи взагалі налаштований бот. Без токена всі виклики мовчки нічого не роблять. */
export const botReady = () => Boolean(botToken());

async function call<T>(method: string, body: unknown): Promise<T | null> {
  const token = botToken();
  if (!token) return null;

  try {
    const r = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await r.json() as { ok: boolean; result?: T; description?: string };

    if (!data.ok) {
      console.error(`[telegram] ${method} failed:`, data.description);
      return null;
    }

    return data.result ?? null;
  } catch (e) {
    console.error(`[telegram] ${method} threw`, e);
    return null;
  }
}

/**
 * Надіслати повідомлення.
 *
 * Помилку ковтаємо і лише пишемо в лог: Telegram лежить окремо від нас, і
 * бронь не має падати через те, що месенджер відповів 502. Виклики
 * навмисно робляться через void — відповідь гравцю не чекає на месенджер.
 */
export function sendMessage(chatId: string | number, text: string) {
  return call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

/* ── Оновлення ────────────────────────────────────────────────────────────
   Два режими одним кодом. Локально публічної адреси немає, тому polling;
   на проді Render дає HTTPS, і вебхук дешевший — не тримає процес у
   постійному опитуванні. Вибір робить одна змінна оточення. */

export type TgUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; first_name?: string; username?: string };
  };
};

export function getUpdates(offset: number, timeoutSec = 25) {
  return call<TgUpdate[]>('getUpdates', {
    offset,
    timeout: timeoutSec,
    allowed_updates: ['message'],
  });
}

export function setWebhook(url: string, secret: string) {
  return call<boolean>('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message'],
  });
}

export function deleteWebhook() {
  return call<boolean>('deleteWebhook', { drop_pending_updates: false });
}
