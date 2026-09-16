import type { PayProvider } from './types';
import { MonoProvider } from './mono';
import { LiqPayProvider } from './liqpay';
import { MockProvider } from './mock';
import { decryptSecret } from '../crypto';
import { mockPaymentsEnabled } from './demo';

export * from './types';

/**
 * Публічна адреса цього API. Потрібна для webHookUrl і для сторінки
 * заглушки. За локальної розробки — http://localhost:3000,
 * на проді — адреса з Render.
 */
export function publicBase(): string {
  const raw = (process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`)
    .trim()
    .replace(/\/+$/, '');

  // Render у fromService віддає хост без схеми ("xxx.onrender.com").
  // Без цього webHookUrl вийшов би невалідним, і банк просто не достукався б.
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
}

type ClubPay = {
  paymentProvider: string | null;
  paymentTokenEnc: string | null;
};

/**
 * Провайдер конкретного клубу. null, якщо клуб не налаштований —
 * викликач сам вирішує, що це означає (зазвичай «працюємо без передоплати»).
 */
export function providerFor(club: ClubPay): PayProvider | null {
  const kind = club.paymentProvider;
  if (!kind) return null;

  if (kind === 'mock') {
    // Заглушка приймає «оплату» одним кліком — на проді це діра.
    if (!mockPaymentsEnabled()) {
      console.error('[pay] mock-провайдер вимкнено у production');
      return null;
    }
    return new MockProvider(publicBase());
  }

  if (kind === 'mono' || kind === 'liqpay') {
    if (!club.paymentTokenEnc) return null;
    try {
      const credentials = decryptSecret(club.paymentTokenEnc);
      return kind === 'liqpay' ? new LiqPayProvider(credentials, publicBase()) : new MonoProvider(credentials);
    } catch (e) {
      // Найчастіша причина — змінили PAYMENTS_SECRET, і старі токени
      // більше не розшифровуються. Клубу треба ввести токен заново.
      console.error('[pay] не вдалося розшифрувати токен клубу', e);
      return null;
    }
  }

  console.error(`[pay] невідомий провайдер: ${kind}`);
  return null;
}

/** Список того, що можна вибрати у налаштуваннях клубу */
export const KNOWN_PROVIDERS = ['mono', 'liqpay', 'mock'] as const;
