import {
  botReady,
  deleteWebhook,
  getUpdates,
  setMyCommands,
  setWebhook,
  TelegramFatal,
} from './telegram';
import { handleUpdate } from './botHandlers';
import { COMMANDS_GUEST } from './botKeyboard';

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
    let updates;

    try {
      updates = await getUpdates(offset);
    } catch (e) {
      /* Невірний токен. Повторювати немає сенсу — зупиняємось і кажемо
         причину ОДИН раз. Без цього цикл писав би те саме «Not Found»
         кожні пʼять секунд, і справжня причина губилась би в логу. */
      if (e instanceof TelegramFatal) {
        polling = false;
        console.error(`[bot] зупинено: ${e.message}`);
        return;
      }
      throw e;
    }

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

  /* Меню «/» для чатів, які ще не увійшли. Персональні списки ставляться
     при вході; цей — те, що бачить незнайомець, і в ньому тільки вхід.
     Через void: список команд не варте того, щоб через нього не піднявся
     бот. */
  void setMyCommands(COMMANDS_GUEST).catch(() => null);

  const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;

  if (webhookUrl) {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) {
      console.error('[bot] TELEGRAM_WEBHOOK_URL заданий без TELEGRAM_WEBHOOK_SECRET — вебхук не ставимо');
      return;
    }
    try {
      const ok = await setWebhook(webhookUrl, secret);
      console.log(ok ? `[bot] вебхук: ${webhookUrl}` : '[bot] не вдалося поставити вебхук');
    } catch (e) {
      if (e instanceof TelegramFatal) {
        console.error(`[bot] не запущено: ${e.message}`);
        return;
      }
      throw e;
    }
    return;
  }

  /* Знімати вебхук теж може впасти на невірному токені — тоді бота просто
     не вмикаємо, а не валимо разом з ним увесь API. */
  try {
    await deleteWebhook();
  } catch (e) {
    if (e instanceof TelegramFatal) {
      console.error(`[bot] не запущено: ${e.message}`);
      return;
    }
    throw e;
  }

  polling = true;
  void pollLoop();
  console.log('[bot] long polling');
}

/** Для тестів і акуратного зупину */
export function stopBot() {
  polling = false;
}
