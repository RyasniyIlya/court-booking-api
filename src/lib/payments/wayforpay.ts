import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { PaymentError, type PayProvider, type CreateInvoiceInput, type Invoice, type WebhookEvent, type PayEventStatus } from './types';

// https://wiki.wayforpay.com/ — Accept payment (Purchase, serviceUrl),
// Check Status, Refund, Codes of responses.
// Усі підписи WayForPay — HMAC-MD5 (hex) від полів через «;» з ключем secretKey.
const API = 'https://api.wayforpay.com/api';
/** Куди браузер POST-ить форму Purchase — єдиний дозволений form-action проміжної сторінки */
export const WAYFORPAY_PAY_URL = 'https://secure.wayforpay.com/pay';

/** Публічний тестовий мерчант WayForPay: його secretKey відомий усім, тож на проді підписи були б підробними. */
const PUBLIC_TEST_MERCHANT = 'test_merch_n1';

const HOSTNAME = /^(?=.{3,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function wayForPayKeys(value: string): { merchantAccount: string; secretKey: string; domain: string } {
  try {
    const keys = JSON.parse(value);
    if (![keys.merchantAccount, keys.secretKey, keys.domain].every((key) => typeof key === 'string')) throw new Error();
    const merchantAccount = keys.merchantAccount.trim();
    const secretKey = keys.secretKey.trim();
    const domain = keys.domain.trim().toLowerCase();
    if (!/^[A-Za-z0-9_.-]{3,100}$/.test(merchantAccount)) throw new Error();
    if (!/^\S{10,180}$/.test(secretKey)) throw new Error();
    if (!HOSTNAME.test(domain)) throw new Error();
    return { merchantAccount, secretKey, domain };
  } catch { throw new PaymentError('Invalid WayForPay credentials'); }
}

/** Документований набір transactionStatus -> наші п'ять */
const statuses: Record<string, PayEventStatus> = {
  Approved: 'paid',
  Declined: 'failed',
  Expired: 'expired',
  Refunded: 'refunded', Voided: 'refunded',
  InProcessing: 'pending', Pending: 'pending', WaitingAuthComplete: 'pending', RefundInProcessing: 'pending',
};

// Codes of responses: 1100 ok, 1113 invalid signature, 1121 account not found,
// 1127 order not found, 1138 refund in processing.
const OK = '1100';
const ORDER_NOT_FOUND = '1127';

export class WayForPayProvider implements PayProvider {
  readonly name = 'wayforpay';
  private readonly keys: ReturnType<typeof wayForPayKeys>;
  constructor(credentials: string, private readonly baseUrl: string) {
    this.keys = wayForPayKeys(credentials);
    if (process.env.NODE_ENV === 'production' && this.keys.merchantAccount === PUBLIC_TEST_MERCHANT) {
      throw new PaymentError('WayForPay test merchant is disabled in production');
    }
  }

  private sign(fields: Array<string | number>): string {
    return createHmac('md5', this.keys.secretKey).update(fields.join(';'), 'utf8').digest('hex');
  }

  private matches(fields: Array<string | number>, received: unknown): boolean {
    if (typeof received !== 'string') return false;
    const expected = Buffer.from(this.sign(fields));
    const actual = Buffer.from(received.toLowerCase());
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private async request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, merchantAccount: this.keys.merchantAccount, apiVersion: 1 }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) { throw new PaymentError('WayForPay unavailable', e); }
    const text = await response.text();
    if (!response.ok) {
      console.error('[wayforpay]', payload.transactionType, response.status, text.slice(0, 400));
      throw new PaymentError(`WayForPay HTTP ${response.status}`);
    }
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      console.error('[wayforpay]', payload.transactionType, 'bad body', text.slice(0, 400));
      throw new PaymentError('Invalid WayForPay response');
    }
    return body as Record<string, unknown>;
  }

  /** Мітка для проміжних сторінок: HMAC-SHA256 від (призначення|дані) ключем клубу. Призначення не дає підставити мітку одного роуту в інший. */
  private tag(purpose: 'checkout' | 'return', data: string): string {
    return createHmac('sha256', this.keys.secretKey).update(`cb-wfp-${purpose}|${data}`, 'utf8').digest('hex');
  }

  private tagMatches(purpose: 'checkout' | 'return', data: string, received: unknown): boolean {
    if (typeof received !== 'string') return false;
    const expected = Buffer.from(this.tag(purpose, data));
    const actual = Buffer.from(received.toLowerCase());
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** Підписане посилання, на яке WayForPay поверне гравця; /return сам перенаправить на redirectUrl. */
  private returnUrl(providerRef: string, to: string): string {
    const query = new URLSearchParams({ ref: providerRef, to, t: this.tag('return', `${providerRef}|${to}`) });
    return `${this.baseUrl}/api/pay/wayforpay/return?${query}`;
  }

  /**
   * Hosted Purchase замість CREATE_INVOICE: лише він знає returnUrl, а отже повертає гравця на сайт клубу.
   * Мережі тут немає: поля форми підписуємо самі й віддаємо в посиланні на нашу проміжну сторінку
   * (GET /api/pay/wayforpay/checkout), яка POST-ить їх на secure.wayforpay.com. Браузер не вміє POST із посилання.
   */
  async createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
    if (!Number.isSafeInteger(input.amountKop) || input.amountKop <= 0 || !Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
      throw new PaymentError('Invalid WayForPay amount or lifetime');
    }
    const providerRef = randomUUID();
    const orderDate = Math.floor(Date.now() / 1000);
    const amount = String(input.amountKop / 100);
    const productName = input.destination.slice(0, 200) || 'Бронювання';
    // Порядок із документації: account; domain; reference; date; amount; currency; names; counts; prices.
    const merchantSignature = this.sign([
      this.keys.merchantAccount, this.keys.domain, providerRef, orderDate, amount, 'UAH', productName, 1, amount,
    ]);
    const fields = {
      merchantAccount: this.keys.merchantAccount, merchantAuthType: 'SimpleSignature', merchantDomainName: this.keys.domain,
      merchantTransactionType: 'AUTO', merchantTransactionSecureType: 'AUTO', merchantSignature,
      language: 'UA', returnUrl: this.returnUrl(providerRef, input.redirectUrl), serviceUrl: input.webHookUrl,
      orderReference: providerRef, orderDate: String(orderDate), amount, currency: 'UAH',
      // Документація описує і orderTimeout, і orderLifetime однаково («в секундах»); у прикладі форми — orderTimeout.
      orderTimeout: String(input.ttlSeconds),
      'productName[]': [productName], 'productPrice[]': [amount], 'productCount[]': ['1'],
    };
    const d = Buffer.from(JSON.stringify(fields)).toString('base64url');
    const query = new URLSearchParams({ ref: providerRef, d, t: this.tag('checkout', d) });
    return { providerRef, pageUrl: `${this.baseUrl}/api/pay/wayforpay/checkout?${query}` };
  }

  /** Поля форми з підписаного посилання. Кидає, якщо мітка чужа або дані не про цей рахунок. */
  readCheckout(providerRef: string, d: string, t: string): Record<string, string | string[]> {
    if (!this.tagMatches('checkout', d, t)) throw new PaymentError('Invalid WayForPay checkout signature');
    let fields: Record<string, unknown>;
    try { fields = JSON.parse(Buffer.from(d, 'base64url').toString('utf8')); }
    catch { throw new PaymentError('Invalid WayForPay checkout data'); }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)
      || fields.orderReference !== providerRef || fields.merchantAccount !== this.keys.merchantAccount || fields.currency !== 'UAH') {
      throw new PaymentError('WayForPay checkout mismatch');
    }
    const clean: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(fields)) {
      const ok = /^[A-Za-z]+(\[\])?$/.test(name) && (typeof value === 'string'
        || (Array.isArray(value) && value.every((item) => typeof item === 'string')));
      if (!ok) throw new PaymentError('Invalid WayForPay checkout field');
      clean[name] = value as string | string[];
    }
    return clean;
  }

  /** true, лише якщо `to` підписано нами для цього рахунку й це http(s)-адреса */
  verifyReturn(providerRef: string, to: string, t: string): boolean {
    if (!this.tagMatches('return', `${providerRef}|${to}`, t)) return false;
    try { return ['http:', 'https:'].includes(new URL(to).protocol); } catch { return false; }
  }

  /** Тіло — JSON; інколи весь JSON приходить єдиним ключем form-urlencoded тіла. */
  private readBody(rawBody: Buffer): { body: Record<string, unknown>; text: string } {
    let text = rawBody.toString('utf8').trim();
    if (!text.startsWith('{')) {
      const entries = [...new URLSearchParams(text).entries()];
      if (entries.length !== 1 || !entries[0][0].startsWith('{')) throw new PaymentError('Invalid WayForPay callback');
      text = entries[0][1] ? `${entries[0][0]}=${entries[0][1]}` : entries[0][0];
    }
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new PaymentError('Invalid WayForPay callback'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PaymentError('Invalid WayForPay callback');
    return { body: body as Record<string, unknown>, text };
  }

  async parseWebhook(rawBody: Buffer): Promise<WebhookEvent> {
    const { body, text } = this.readBody(rawBody);
    const scalar = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');
    // Підпис рахується від суми «як її надіслали» — беремо й буквальний запис із тіла (10.00 vs 10).
    const literal = /"amount"\s*:\s*"?([-0-9.eE+]+)"?/.exec(text)?.[1];
    const amounts = [...new Set([scalar(body.amount), literal ?? ''])].filter(Boolean);
    const signed = amounts.some((amount) => this.matches([
      scalar(body.merchantAccount), scalar(body.orderReference), amount, scalar(body.currency),
      scalar(body.authCode), scalar(body.cardPan), scalar(body.transactionStatus), scalar(body.reasonCode),
    ], body.merchantSignature));
    if (!signed) throw new PaymentError('Invalid WayForPay signature');
    if (body.merchantAccount !== this.keys.merchantAccount) throw new PaymentError('WayForPay merchant mismatch');
    if (body.currency !== 'UAH' || typeof body.orderReference !== 'string' || !body.orderReference) {
      throw new PaymentError('Invalid WayForPay payment identity');
    }
    const status = typeof body.transactionStatus === 'string' ? statuses[body.transactionStatus] : undefined;
    if (!status) throw new PaymentError('Unknown WayForPay status');
    const amount = typeof body.amount === 'number' || typeof body.amount === 'string' ? Number(body.amount) : NaN;
    const amountKop = Math.round(amount * 100);
    if (body.amount === '' || !Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(amountKop) || Math.abs(amount * 100 - amountKop) > 0.00001) {
      throw new PaymentError('Invalid WayForPay amount');
    }
    let at: Date | undefined;
    if (body.processingDate != null && body.processingDate !== '') {
      const seconds = Number(body.processingDate);
      at = new Date(seconds * 1000);
      if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(at.getTime())) throw new PaymentError('Invalid WayForPay timestamp');
    }
    const reason = [scalar(body.reasonCode), typeof body.reason === 'string' ? body.reason : ''].filter(Boolean).join(' ').slice(0, 200);
    return { providerRef: body.orderReference, status, amountKop, at, failReason: status === 'paid' || !reason ? undefined : reason };
  }

  /** WayForPay повторює вебхук до 4 діб, доки не отримає саме таку підписану відповідь */
  webhookAck(event: WebhookEvent): unknown {
    const time = Math.floor(Date.now() / 1000);
    return { orderReference: event.providerRef, status: 'accept', time, signature: this.sign([event.providerRef, 'accept', time]) };
  }

  async testConnection(): Promise<void> {
    // Read-only CHECK_STATUS по неіснуючому замовленню: підпис і мерчант прийняті, якщо банк каже «order not found».
    const orderReference = `connection-${randomUUID()}`;
    const body = await this.request({
      transactionType: 'CHECK_STATUS', orderReference, merchantSignature: this.sign([this.keys.merchantAccount, orderReference]),
    });
    if (String(body.reasonCode) !== ORDER_NOT_FOUND) throw new PaymentError('WayForPay credential check failed');
  }

  async refund(providerRef: string, amountKop: number): Promise<void> {
    if (!Number.isSafeInteger(amountKop) || amountKop <= 0) throw new PaymentError('Invalid refund amount');
    const amount = amountKop / 100;
    const body = await this.request({
      transactionType: 'REFUND', orderReference: providerRef, amount, currency: 'UAH', comment: 'Скасування бронювання',
      merchantSignature: this.sign([this.keys.merchantAccount, providerRef, amount, 'UAH']),
    });
    const status = String(body.transactionStatus);
    const code = String(body.reasonCode);
    // 1138 RefundInProcessing — повернення прийнято, чекає коштів на балансі мерчанта.
    const done = (status === 'Refunded' || status === 'Voided') && code === OK;
    const inProgress = status === 'RefundInProcessing' || code === '1138';
    if (!done && !inProgress) {
      console.error('[wayforpay] REFUND rejected', JSON.stringify(body).slice(0, 400));
      throw new PaymentError('WayForPay refund rejected');
    }
    // Остаточний статус усе одно приходить підписаним вебхуком.
  }

  async cancelUnpaid(_providerRef: string): Promise<void> {
    // У Purchase немає рахунку, який можна видалити (REMOVE_INVOICE стосується лише CREATE_INVOICE).
    // Сторінку банку обмежує orderTimeout, а проміжна сторінка перед кожним POST перевіряє бронь.
  }
}
