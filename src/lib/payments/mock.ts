import { randomUUID } from 'node:crypto';
import type { PayProvider, CreateInvoiceInput, Invoice, WebhookEvent } from './types';
import { PaymentError } from './types';

/**
 * Заглушка для локальної розробки.
 *
 * Замість сторінки банку віддає нашу ж сторінку /api/pay/mock/:ref,
 * де дві кнопки: «Оплатити» і «Скасувати». Натискання дьоргає той самий
 * вебхук, що й справжній банк, — тобто перевіряється весь ланцюжок,
 * а не тільки редірект.
 *
 * Підпис не перевіряється: у dev його нема кому ставити. Тому провайдер
 * mock свідомо не має бути доступний на проді (див. index.ts).
 */
/**
 * Куди стукати вебхуком по кожному рахунку, який ця заглушка виставила.
 *
 * Адреса вебхука приходить у createInvoice, а refund() її вже не бачить —
 * у справжнього банку вона й не потрібна, він пам'ятає мерчанта сам.
 * Заглушці пам'ятати нема де, тому тримаємо в пам'яті процесу.
 *
 * Втрата при перезапуску — свідомо прийнятна: це dev-заглушка, і
 * найгірше, що станеться, — повернення в локальній базі доведеться
 * підтвердити руками. У проді mock вимкнено (див. index.ts).
 */
const mockHooks = new Map<string, string>();

export class MockProvider implements PayProvider {
  readonly name = 'mock';

  constructor(private readonly publicBase: string) {}

  async createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
    const providerRef = `mock_${randomUUID().slice(0, 8)}`;
    const url = new URL(`${this.publicBase}/api/pay/mock/${providerRef}`);
    url.searchParams.set('amount', String(input.amountKop));
    url.searchParams.set('back', input.redirectUrl);
    url.searchParams.set('hook', input.webHookUrl);
    url.searchParams.set('what', input.destination);
    mockHooks.set(providerRef, input.webHookUrl);
    return { providerRef, pageUrl: url.toString() };
  }

  async parseWebhook(rawBody: Buffer): Promise<WebhookEvent> {
    let body: { invoiceId?: string; status?: string; amount?: number };
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch (e) {
      throw new PaymentError('mock: тіло не є JSON', e);
    }
    if (!body.invoiceId) throw new PaymentError('mock: немає invoiceId');

    const status = body.status === 'success' ? 'paid'
      : body.status === 'failure' ? 'failed'
        : body.status === 'expired' ? 'expired'
          : body.status === 'reversed' ? 'refunded'
            : 'pending';

    return {
      providerRef: body.invoiceId,
      status,
      amountKop: body.amount,
      at: new Date(),
    };
  }

  /**
   * Грошей у заглушки немає, але вебхук вона шле справжній — той самий
   * `reversed`, що й моно. Інакше локально перевірявся б лише HTTP-запит
   * до банку, а найцікавіше (як подія «повернуто» лягає в базу і знімає
   * бронь) лишалось би неперевіреним до першого живого клуба.
   */
  async refund(providerRef: string, amountKop: number): Promise<void> {
    const hook = mockHooks.get(providerRef);
    if (!hook) return;

    /* Не чекаємо на відповідь: справжній банк теж повертає керування
       одразу, а вебхук долітає окремо. Помилку тільки логуємо — роут
       повернення про неї нічого зробити не може. */
    void fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceId: providerRef, status: 'reversed', amount: amountKop }),
    }).catch((e) => console.error('[pay] mock reverse hook failed', e));
  }

  async cancelUnpaid(): Promise<void> { /* немає що гасити */ }
}
