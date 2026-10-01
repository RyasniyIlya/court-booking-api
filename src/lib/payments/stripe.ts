import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentError, type PayProvider, type CreateInvoiceInput, type Invoice, type WebhookEvent } from './types';

// https://docs.stripe.com/api — Checkout Sessions (create/expire/list), Refunds,
// https://docs.stripe.com/webhooks — ручна перевірка Stripe-Signature.
// Лише REST через fetch, без офіційного SDK.
const BASE = 'https://api.stripe.com';

export function stripeKeys(value: string): { secretKey: string; webhookSecret: string } {
  try {
    const keys = JSON.parse(value);
    if (typeof keys.secretKey !== 'string' || typeof keys.webhookSecret !== 'string') throw new Error();
    const secretKey = keys.secretKey.trim();
    const webhookSecret = keys.webhookSecret.trim();
    if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,200}$/.test(secretKey)) throw new Error();
    if (!/^whsec_[A-Za-z0-9]{10,200}$/.test(webhookSecret)) throw new Error();
    return { secretKey, webhookSecret };
  } catch { throw new PaymentError('Invalid Stripe credentials'); }
}

/** Stripe не приймає сесію, що живе менше 30 хвилин; +хвилина запасу на розбіжність годинників. */
const MIN_SESSION_SECONDS = 30 * 60 + 60;
const MAX_SESSION_SECONDS = 24 * 60 * 60 - 60;
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const SESSION_ID = /^cs_[A-Za-z0-9_]+$/;

type Json = Record<string, any>;

export class StripeProvider implements PayProvider {
  readonly name = 'stripe';
  private readonly keys: ReturnType<typeof stripeKeys>;
  constructor(credentials: string) {
    this.keys = stripeKeys(credentials);
    if (process.env.NODE_ENV === 'production' && this.keys.secretKey.includes('_test_')) {
      throw new PaymentError('Stripe test keys are disabled in production');
    }
  }

  private async call(method: 'GET' | 'POST', path: string, form?: URLSearchParams, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
    let response: Response;
    try {
      response = await fetch(`${BASE}${path}`, {
        method, signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${this.keys.secretKey}`,
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...headers,
        },
        body: form?.toString(),
      });
    } catch (e) { throw new PaymentError('Stripe unavailable', e); }
    const text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!response.ok) console.error('[stripe]', method, path.split('?')[0], response.status, text.slice(0, 400));
    return { status: response.status, body: body && typeof body === 'object' && !Array.isArray(body) ? body as Json : {} };
  }

  private async ok(method: 'GET' | 'POST', path: string, form?: URLSearchParams, headers?: Record<string, string>): Promise<Json> {
    const { status, body } = await this.call(method, path, form, headers);
    if (status < 200 || status >= 300) throw new PaymentError(`Stripe HTTP ${status}`);
    return body;
  }

  async createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
    if (!Number.isSafeInteger(input.amountKop) || input.amountKop <= 0 || !Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
      throw new PaymentError('Invalid Stripe amount or lifetime');
    }
    // Мінімум для Stripe — 30 хвилин, а наш холд коротший. Сесія може пожити довше за бронь:
    // коротший строк тримає cancelUnpaid (expire) та наявна обробка пізньої оплати.
    const lifetime = Math.min(Math.max(input.ttlSeconds, MIN_SESSION_SECONDS), MAX_SESSION_SECONDS);
    const form = new URLSearchParams({
      mode: 'payment',
      'line_items[0][price_data][currency]': 'uah',
      'line_items[0][price_data][unit_amount]': String(input.amountKop),
      'line_items[0][price_data][product_data][name]': input.destination.slice(0, 250) || 'Бронювання',
      'line_items[0][quantity]': '1',
      success_url: input.redirectUrl,
      cancel_url: input.redirectUrl,
      client_reference_id: input.reference.slice(0, 200),
      locale: 'auto',
      expires_at: String(Math.floor(Date.now() / 1000) + lifetime),
    });
    // payment_method_types не задаємо: за замовчуванням Stripe сам покаже картки, Apple Pay і Google Pay.
    const session = await this.ok('POST', '/v1/checkout/sessions', form);
    if (typeof session.id !== 'string' || !SESSION_ID.test(session.id) || typeof session.url !== 'string' || !session.url.startsWith('https://')) {
      throw new PaymentError('Invalid Stripe session');
    }
    return { providerRef: session.id, pageUrl: session.url };
  }

  private verifySignature(rawBody: Buffer, header: string | undefined): void {
    if (!header) throw new PaymentError('Missing Stripe signature');
    let timestamp = '';
    const signatures: string[] = [];
    for (const part of header.split(',')) {
      const [key, value] = [part.slice(0, part.indexOf('=')).trim(), part.slice(part.indexOf('=') + 1).trim()];
      if (key === 't') timestamp = value;
      else if (key === 'v1' && value) signatures.push(value); // інші схеми (v0) ігноруємо
    }
    const seconds = Number(timestamp);
    if (!/^\d+$/.test(timestamp) || !signatures.length) throw new PaymentError('Invalid Stripe signature');
    const expected = Buffer.from(createHmac('sha256', this.keys.webhookSecret).update(`${timestamp}.`).update(rawBody).digest('hex'));
    // Під час ротації секрету в заголовку кілька v1 — достатньо збігу будь-якого.
    const matched = signatures.reduce((found, signature) => {
      const actual = Buffer.from(signature.toLowerCase());
      return (actual.length === expected.length && timingSafeEqual(actual, expected)) || found;
    }, false);
    if (!matched) throw new PaymentError('Invalid Stripe signature');
    if (Math.abs(Date.now() / 1000 - seconds) > SIGNATURE_TOLERANCE_SECONDS) throw new PaymentError('Stale Stripe signature');
  }

  async parseWebhook(rawBody: Buffer, headers: NodeJS.Dict<string | string[]>): Promise<WebhookEvent> {
    const header = headers['stripe-signature'];
    this.verifySignature(rawBody, Array.isArray(header) ? header[0] : header);
    let event: Json;
    try { event = JSON.parse(rawBody.toString('utf8')); } catch { throw new PaymentError('Invalid Stripe event'); }
    if (!event || typeof event !== 'object' || typeof event.id !== 'string' || typeof event.type !== 'string'
      || !Number.isFinite(event.created) || !event.data?.object || typeof event.data.object !== 'object') {
      throw new PaymentError('Invalid Stripe event');
    }
    if (process.env.NODE_ENV === 'production' && event.livemode === false) {
      throw new PaymentError('Stripe test event cannot confirm a booking');
    }
    const at = new Date(event.created * 1000);
    const object: Json = event.data.object;

    const session = (status: WebhookEvent['status']): WebhookEvent => {
      if (typeof object.id !== 'string' || !object.id || object.currency !== 'uah') throw new PaymentError('Invalid Stripe payment identity');
      if (!Number.isSafeInteger(object.amount_total) || object.amount_total <= 0) throw new PaymentError('Invalid Stripe amount');
      return { providerRef: object.id, status, amountKop: object.amount_total, at };
    };

    switch (event.type) {
      case 'checkout.session.completed':
        // Картка — 'paid' одразу; відкладені методи (банківський переказ) — 'unpaid', гроші прийдуть async-подією.
        return session(object.payment_status === 'paid' ? 'paid' : 'pending');
      case 'checkout.session.async_payment_succeeded': return session('paid');
      case 'checkout.session.async_payment_failed': return session('failed');
      case 'checkout.session.expired': return session('expired');
      case 'charge.refunded': {
        if (object.currency !== 'uah' || typeof object.payment_intent !== 'string' || !object.payment_intent) {
          throw new PaymentError('Invalid Stripe charge');
        }
        // Наш providerRef — id сесії, а подія про платіж: шукаємо сесію за payment_intent.
        const found = await this.ok('GET', `/v1/checkout/sessions?${new URLSearchParams({ payment_intent: object.payment_intent, limit: '1' })}`);
        const id = found.data?.[0]?.id;
        if (typeof id !== 'string' || !id) return { providerRef: event.id, status: 'pending', at };
        // Часткове повернення нічого не скасовує — лише 'pending', який apply не бере до уваги для оплаченого платежу.
        if (object.refunded !== true) return { providerRef: id, status: 'pending', at };
        return { providerRef: id, status: 'refunded', amountKop: Number.isSafeInteger(object.amount_refunded) ? object.amount_refunded : undefined, at };
      }
      default:
        // Чужий тип події — не помилка: 400 змусив би Stripe повторювати доставку, а згодом вимкнути ендпоінт.
        // Віддаємо 'pending' з id події замість рахунку: apply відповість unknown-invoice, роут — 200.
        return { providerRef: event.id, status: 'pending', at };
    }
  }

  async testConnection(): Promise<void> {
    // Лише читання; працює і з обмеженим ключем (rk_), якому дано доступ до Checkout.
    const { status } = await this.call('GET', '/v1/checkout/sessions?limit=1');
    if (status !== 200) throw new PaymentError('Stripe credential check failed');
  }

  async refund(providerRef: string, amountKop: number): Promise<void> {
    if (!Number.isSafeInteger(amountKop) || amountKop <= 0 || !SESSION_ID.test(providerRef)) throw new PaymentError('Invalid refund amount');
    const session = await this.ok('GET', `/v1/checkout/sessions/${providerRef}`);
    if (typeof session.payment_intent !== 'string' || !session.payment_intent) throw new PaymentError('Stripe refund rejected');
    // Той самий ключ на повтор запиту — повернення не задвоїться, якщо відповідь загубилась.
    const key = `cb-refund-${createHash('sha256').update(`${providerRef}:${amountKop}`).digest('hex').slice(0, 40)}`;
    const { status, body } = await this.call('POST', '/v1/refunds',
      new URLSearchParams({ payment_intent: session.payment_intent, amount: String(amountKop) }), { 'Idempotency-Key': key });
    if (status < 200 || status >= 300 || body.status === 'failed' || body.status === 'canceled') {
      throw new PaymentError('Stripe refund rejected');
    }
    // Остаточний стан приходить вебхуком charge.refunded.
  }

  async cancelUnpaid(providerRef: string): Promise<void> {
    if (!SESSION_ID.test(providerRef)) throw new PaymentError('Invalid Stripe session');
    // Закінчити можна лише open-сесію; оплачену Stripe відхилить, викликач це ловить.
    await this.ok('POST', `/v1/checkout/sessions/${providerRef}/expire`, new URLSearchParams());
  }
}
