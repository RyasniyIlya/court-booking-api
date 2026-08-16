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
          : 'pending';

    return {
      providerRef: body.invoiceId,
      status,
      amountKop: body.amount,
      at: new Date(),
    };
  }

  async refund(): Promise<void> { /* у заглушки повертати нічого */ }
  async cancelUnpaid(): Promise<void> { /* немає що гасити */ }
}
