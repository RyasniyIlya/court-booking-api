import { botReady, deleteWebhook, getUpdates, setWebhook } from './telegram';
import { handleUpdate } from './botHandlers';

/**
 * Як бот отримує повідомлення.
 *
 * Два режими одним кодом:
 *   TELEGRAM_WEBHOOK_URL задано -> вебхук (прод, Render дає HTTPS);
 *   не задано                   -> long polling (локальна розробка).
 *
 * Чому не завжди вебхук: на машині розробника немає публічної адреси, і
 * без тунелю бот не перевіряється взагалі. Чому не завжди polling: він
 * тримає процес у постійному опитуванні, а на Render це зайвий трафік і
 * зайва причина для рестарту.
 *
 * У Telegram два режими взаємовиключні: увімкнений вебхук просто не дає
 * викликати getUpdates. Тому polling першою дією знімає вебхук — інакше
 * після переїзду з прода на локальну машину бот мовчав би, а причина
 * лежала б на боці Telegram, а не в коді.
 */

let polling = false;

/** Скільки чекати після падіння мережі, щоб не забити лог за секунду */
const RETRY_MS = 5000;

async function pollLoop() {
  let offset = 0;

  while (polling) {
    const updates = await getUpdates(offset);

    if (!updates) {
      /* null — мережа або Telegram віддали помилку. getUpdates уже написав
         причину в лог; тут лишається тільки не крутити цикл упритул. */
      await new Promise((r) => setTimeout(r, RETRY_MS));
      continue;
    }

    for (const u of updates) {
      offset = u.update_id + 1;
      /* Одне зламане оновлення не має зупиняти чергу: інакше повідомлення,
         на якому впав обробник, блокувало б бота назавжди — offset не
         зрушив би, і Telegram віддавав би його знову й знову. */
      try {
        await handleUpdate(u);
      } catch (e) {
        console.error('[bot] update failed', u.update_id, e);
      }
    }
  }
}

export async function startBot() {
  if (!botReady()) {
    console.log('[bot] TELEGRAM_BOT_TOKEN не заданий — бот вимкнений');
    return;
  }

  const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;

  if (webhookUrl) {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) {
      console.error('[bot] TELEGRAM_WEBHOOK_URL заданий без TELEGRAM_WEBHOOK_SECRET — вебхук не ставимо');
      return;
    }
    const ok = await setWebhook(webhookUrl, secret);
    console.log(ok ? `[bot] вебхук: ${webhookUrl}` : '[bot] не вдалося поставити вебхук');
    return;
  }

  await deleteWebhook();
  polling = true;
  void pollLoop();
  console.log('[bot] long polling');
}

/** Для тестів і акуратного зупину */
export function stopBot() {
  polling = false;
}
