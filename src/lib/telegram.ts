/**
 * Клієнт Telegram Bot API. Тільки транспорт — жодної логіки про клуби.
 *
 * Без бібліотеки навмисно. Нам потрібні три виклики з усього API
 * (sendMessage, setWebhook), а будь-який фреймворк тягне свою
 * модель сцен і станів, під яку довелось би підганяти наші ролі й клуби.
 */

import { chatHash, countSend, currentTemplate, verdictFor } from './telegramSafety';

const API = 'https://api.telegram.org';

export const botToken = () => process.env.TELEGRAM_BOT_TOKEN ?? '';

/** Чи взагалі налаштований бот. Без токена всі виклики мовчки нічого не роблять. */
export const botReady = () => Boolean(botToken());

/**
 * Помилка, після якої повторювати немає сенсу.
 *
 * Telegram відповідає 401/404 на невірний токен. Без цієї різниці цикл
 * опитування крутився б вічно з тим самим «Not Found» кожні пʼять секунд:
 * лог засмічений, а причина — одруківка в TELEGRAM_BOT_TOKEN — губиться
 * серед тисячі однакових рядків.
 */
export class TelegramFatal extends Error {}
export class TelegramDeliveryError extends Error {
  constructor(public readonly retryable: boolean) { super('Telegram delivery failed'); }
}

/** Методи, що доходять до людини або чату: їх стосується TELEGRAM_SEND_MODE. */
const GATED = new Set(['sendMessage', 'editMessageText', 'deleteMessage', 'answerCallbackQuery', 'setMyCommands']);
/** З них у підсумок sent/skipped/failed іде лише те, що бачить людина. */
const COUNTED = new Set(['sendMessage', 'editMessageText']);

async function call<T>(method: string, body: unknown, strict = false): Promise<T | null> {
  if (GATED.has(method)) {
    const b = body as { chat_id?: string | number; scope?: { chat_id?: string | number } };
    const chatId = b.chat_id ?? b.scope?.chat_id;
    const verdict = verdictFor(chatId);
    if (verdict !== 'send') {
      if (COUNTED.has(method)) countSend('skipped');
      if (verdict === 'skip-dry') {
        /* Лише відбиток чату й назва шаблону — без тексту (там імена й телефони). */
        console.log(`[telegram] dry ${method} chat=${chatId === undefined ? '-' : chatHash(chatId)} template=${currentTemplate(method)}`);
      }
      /* null → sendReminderMessage віддасть 'retry': мітки «нагадано» в базі не
         ставляться, тож після переходу на live ці люди своє нагадування отримають. */
      return null;
    }
  }

  const token = botToken();
  if (!token) return null;

  const counted = COUNTED.has(method);
  try {
    const out = await callLive<T>(method, body, strict, token);
    if (counted) countSend(out === null ? 'failed' : 'sent');
    return out;
  } catch (e) {
    if (counted) countSend('failed');
    throw e;
  }
}

async function callLive<T>(method: string, body: unknown, strict: boolean, token: string): Promise<T | null> {

  let r: Response;

  try {
    r = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Telegram не повинен утримувати ресурси API безкінечно, якщо мережа
      // зависла. Всі повідомлення подієві; помилка не валить бронювання.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    /* Мережа. Тимчасово — про це варто сказати й спробувати ще. */
    console.error(`[telegram] ${method} network error`);
    if (strict) throw new TelegramDeliveryError(true);
    return null;
  }

  const data = await r.json().catch(() => ({ ok: false, description: 'not json' })) as {
    ok: boolean; result?: T; description?: string;
  };

  if (!data.ok) {
    if (strict) throw new TelegramDeliveryError([200, 401, 404, 429].includes(r.status) || r.status >= 500);
    if (r.status === 401 || r.status === 404) {
      throw new TelegramFatal(
        `${method}: ${data.description ?? r.status}. Перевірте TELEGRAM_BOT_TOKEN.`,
      );
    }
    console.error(`[telegram] ${method} failed:`, data.description);
    return null;
  }

  return data.result ?? null;
}

/**
 * Надіслати повідомлення.
 *
 * Помилку ковтаємо і лише пишемо в лог: Telegram лежить окремо від нас, і
 * бронь не має падати через те, що месенджер відповів 502. Виклики
 * навмисно робляться через void — відповідь гравцю не чекає на месенджер.
 */
export function sendMessage(chatId: string | number, text: string, markup?: unknown) {
  return call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: markup,
  });
}

export async function sendReminderMessage(chatId: string | number, text: string, markup?: unknown): Promise<'sent' | 'retry' | 'permanent'> {
  try {
    const result = await call<{ message_id: number }>('sendMessage', {
      chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup,
    }, true);
    return result ? 'sent' : 'retry';
  } catch (error) {
    return error instanceof TelegramDeliveryError && !error.retryable ? 'permanent' : 'retry';
  }
}

/**
 * Переписати вже надіслане повідомлення.
 *
 * Потрібне кнопкам під звітом: натиснувши «14 днів», людина має побачити
 * інші цифри на тому ж місці, а не десяте повідомлення поспіль у стрічці.
 */
export function editMessageText(
  chatId: string | number,
  messageId: number,
  text: string,
  markup?: unknown,
) {
  return call<unknown>('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: markup,
  });
}

/**
 * Погасити «годинник» на натиснутій кнопці.
 *
 * Telegram крутить його, доки бот не відповів, і без цього виклику кнопка
 * виглядає завислою навіть тоді, коли все вже спрацювало.
 */
export function answerCallback(callbackId: string, text?: string) {
  return call<boolean>('answerCallbackQuery', { callback_query_id: callbackId, text });
}

/**
 * Список команд у синьому меню «/» біля поля вводу.
 *
 * Зі scope конкретного чату, а не глобально: тренеру немає чого бачити в
 * меню /week, якого йому все одно не покажуть. Глобальний список лишається
 * тим, що бачить незнайомий чат — там тільки вхід.
 */
export function setMyCommands(
  commands: { command: string; description: string }[],
  chatId?: string | number,
) {
  return call<boolean>('setMyCommands', {
    commands,
    scope: chatId ? { type: 'chat', chat_id: chatId } : { type: 'default' },
  });
}

/* ── Оновлення через webhook ───────────────────────────────────────────── */

export type TgUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
    /**
     * Контакт, надісланий кнопкою request_contact. user_id збігається з
     * from.id, лише коли людина поділилась СВОЇМ номером — пересланий
     * чужий контакт має інший user_id або не має його зовсім.
     */
    contact?: { phone_number: string; first_name?: string; last_name?: string; user_id?: number };
  };
  /** Натиснута кнопка під повідомленням */
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
    from?: { id: number };
  };
};

/* callback_query у списку обовʼязково: без нього Telegram просто не
   надішле натискання кнопок, і вони мовчатимуть — помилки при цьому
   ніде не буде, що робить причину неочевидною. */
const UPDATES = ['message', 'callback_query'];

export function setWebhook(url: string, secret: string) {
  return call<boolean>('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: UPDATES,
  });
}

/**
 * Прибрати повідомлення з чату.
 *
 * Потрібне рівно для одного: пароль, надісланий боту при вході, не має
 * лежати в історії чату. Telegram дозволяє видаляти чуже повідомлення в
 * приватному чаті лише 48 годин — нам вистачає з запасом, ми видаляємо
 * одразу після перевірки.
 *
 * Помилку ковтаємо: якщо видалити не вдалось, вхід усе одно відбувся, і
 * падати через це безглуздо — користувачу ми окремо кажемо стерти
 * повідомлення руками.
 */
export function deleteMessage(chatId: string | number, messageId: number) {
  return call<boolean>('deleteMessage', { chat_id: chatId, message_id: messageId })
    .catch(() => null);
}
