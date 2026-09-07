import {
  botReady,
  botToken,
  setMyCommands,
  setWebhook,
} from './telegram';
import { COMMANDS_GUEST } from './botKeyboard';
import { createHash } from 'node:crypto';

/**
 * Вхідні повідомлення бот отримує тільки через webhook.
 *
 * Раніше за відсутності TELEGRAM_WEBHOOK_URL процес переходив у long
 * polling і безперервно викликав getUpdates. На проді одна пропущена
 * змінна оточення перетворювалась на нескінченний цикл мережевих запитів,
 * а при проблемах із мережею — ще й на потік однакових помилок у логах.
 *
 * Тепер немає запасного polling-режиму. Якщо публічний webhook не
 * налаштований, API продовжує надсилати подієві повідомлення через
 * sendMessage, але не опитує Telegram і не приймає команди від користувача.
 */

const WEBHOOK_PATH = '/api/telegram/webhook';

/** Повертає публічну HTTPS-адресу webhook або null для локального API. */
export function telegramWebhookUrl(): string | null {
  const explicit = process.env.TELEGRAM_WEBHOOK_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const rawBase = process.env.PUBLIC_API_URL?.trim().replace(/\/+$/, '');
  if (!rawBase) return null;

  const base = /^https?:\/\//.test(rawBase) ? rawBase : `https://${rawBase}`;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base)) return null;

  return `${base}${WEBHOOK_PATH}`;
}

/**
 * Спільний секрет для реєстрації та приймання webhook.
 *
 * Явне значення має пріоритет. Запасний варіант — стабільний SHA-256 від
 * токена: сам токен назовні не потрапляє, результат відповідає дозволеному
 * Telegram алфавіту, а старий Render-сервіс переходить на webhook без
 * ручного додавання нової змінної оточення.
 */
export function telegramWebhookSecret(): string {
  const explicit = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (explicit) return explicit;

  const token = botToken();
  return token ? createHash('sha256').update(`court-booking:${token}`).digest('hex') : '';
}

export async function startBot() {
  if (!botReady()) {
    console.log('[bot] TELEGRAM_BOT_TOKEN не заданий — бот вимкнений');
    return;
  }

  const webhookUrl = telegramWebhookUrl();
  const secret = telegramWebhookSecret();

  if (!webhookUrl || !secret) {
    console.log('[bot] webhook не налаштований — працюють лише вихідні сповіщення');
    return;
  }

  if (!webhookUrl.startsWith('https://')) {
    console.error('[bot] webhook має використовувати https — вхідні команди вимкнені');
    return;
  }

  try {
    const ok = await setWebhook(webhookUrl, secret);
    if (!ok) {
      console.error('[bot] Telegram не прийняв webhook — вхідні команди вимкнені');
      return;
    }

    console.log(`[bot] webhook: ${webhookUrl}`);

    // Це один запит під час старту, а не фоновий цикл. Помилка меню не
    // впливає на webhook і не повинна зупиняти API.
    void setMyCommands(COMMANDS_GUEST).catch((e) => {
      console.error('[bot] не вдалося оновити меню команд', e);
    });
  } catch (e) {
    // Telegram не є умовою запуску API. Навіть невірний токен або тимчасова
    // мережна помилка не повинні валити бронювання й кабінет.
    console.error('[bot] не вдалося налаштувати webhook', e);
  }
}
