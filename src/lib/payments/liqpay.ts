import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { PaymentError, type PayProvider, type CreateInvoiceInput, type Invoice, type WebhookEvent, type PayEventStatus } from './types';

// API v7: https://www.liqpay.ua/doc/api/internet_acquiring/checkout?tab=1
// https://www.liqpay.ua/doc/api/callback (SHA3-256, not legacy v3 SHA-1).
export function liqPayKeys(value: string): { publicKey: string; privateKey: string } {
  try {
    const keys = JSON.parse(value);
    if (![keys.publicKey, keys.privateKey].every((key) => typeof key === 'string' && /^[A-Za-z0-9_-]{10,180}$/.test(key.trim()))) throw new Error();
    return { publicKey: keys.publicKey.trim(), privateKey: keys.privateKey.trim() };
  } catch { throw new PaymentError('Invalid LiqPay credentials'); }
}

const statuses: Record<string, PayEventStatus> = {
  success: 'paid', wait_compensation: 'paid', reversed: 'refunded',
  error: 'failed', failure: 'failed', expired: 'expired',
  processing: 'pending', prepared: 'pending', invoice_wait: 'pending',
  cash_wait: 'pending', hold_wait: 'pending', wait_accept: 'pending',
  wait_card: 'pending', wait_lc: 'pending', wait_reserve: 'pending', wait_secure: 'pending',
  try_again: 'pending', wait_qr: 'pending', '3ds_verify': 'pending',
  captcha_verify: 'pending', cvv_verify: 'pending', ivr_verify: 'pending',
  otp_verify: 'pending', password_verify: 'pending', phone_verify: 'pending',
  pin_verify: 'pending', senderapp_verify: 'pending', p24_verify: 'pending', mp_verify: 'pending',
};

export class LiqPayProvider implements PayProvider {
  readonly name = 'liqpay';
  private readonly keys: ReturnType<typeof liqPayKeys>;
  constructor(credentials: string, private readonly baseUrl: string) {
    this.keys = liqPayKeys(credentials);
    if (process.env.NODE_ENV === 'production' && this.keys.publicKey.startsWith('sandbox_')) {
      throw new PaymentError('LiqPay sandbox keys are disabled in production');
    }
  }

  private sign(data: string): Buffer {
    return createHash('sha3-256').update(this.keys.privateKey + data + this.keys.privateKey).digest();
  }

  private encode(payload: Record<string, unknown>) {
    const data = Buffer.from(JSON.stringify({ ...payload, version: 7, public_key: this.keys.publicKey })).toString('base64');
    return { data, signature: this.sign(data).toString('base64') };
  }

  readSigned(data: string, signature: string): Record<string, unknown> {
    const received = Buffer.from(signature, 'base64');
    const expected = this.sign(data);
    if (!data || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new PaymentError('Invalid LiqPay signature');
    }
    let body;
    try { body = JSON.parse(Buffer.from(data, 'base64').toString('utf8')); }
    catch { throw new PaymentError('Invalid LiqPay data'); }
    if (!body || body.public_key !== this.keys.publicKey || String(body.version) !== '7') {
      throw new PaymentError('LiqPay merchant or version mismatch');
    }
    return body;
  }

  async createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
    if (!Number.isSafeInteger(input.amountKop) || input.amountKop <= 0 || !Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
      throw new PaymentError('Invalid LiqPay amount or lifetime');
    }
    const providerRef = randomUUID();
    const encoded = this.encode({
      action: 'pay', amount: input.amountKop / 100, currency: 'UAH',
      description: input.destination, order_id: providerRef,
      result_url: input.redirectUrl, server_url: input.webHookUrl,
      expired_date: new Date(Date.now() + input.ttlSeconds * 1000).toISOString().slice(0, 19).replace('T', ' '),
      language: 'uk', paytypes: 'card,privat24,apay,gpay,qr',
    });
    // Browser POST is performed by our small bridge page, not by the widget.
    return { providerRef, pageUrl: `${this.baseUrl}/api/pay/liqpay/checkout?${new URLSearchParams(encoded)}` };
  }

  async parseWebhook(rawBody: Buffer): Promise<WebhookEvent> {
    const form = new URLSearchParams(rawBody.toString('utf8'));
    if (form.getAll('data').length !== 1 || form.getAll('signature').length !== 1) throw new PaymentError('Invalid LiqPay callback');
    const body = this.readSigned(form.get('data')!, form.get('signature')!);
    if (body.currency !== 'UAH' || body.action !== 'pay' || typeof body.order_id !== 'string' || !body.order_id) {
      throw new PaymentError('Invalid LiqPay payment identity');
    }
    if (process.env.NODE_ENV === 'production' && (body.sandbox === true || body.sandbox === 1 || body.sandbox === '1' || body.status === 'sandbox')) {
      throw new PaymentError('Sandbox callback cannot confirm a booking');
    }
    const status = body.status === 'sandbox' && process.env.NODE_ENV !== 'production' ? 'paid'
      : typeof body.status === 'string' ? statuses[body.status] : undefined;
    if (!status) throw new PaymentError('Unknown LiqPay status');
    const amount = typeof body.amount === 'number' || typeof body.amount === 'string' ? Number(body.amount) : NaN;
    const amountKop = Math.round(amount * 100);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(amountKop) || Math.abs(amount * 100 - amountKop) > 0.00001) {
      throw new PaymentError('Invalid LiqPay amount');
    }
    const timestamp = body.end_date == null ? undefined : Number(body.end_date);
    if (timestamp !== undefined && (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(new Date(timestamp).getTime()))) {
      throw new PaymentError('Invalid LiqPay timestamp');
    }
    return {
      providerRef: body.order_id, status, amountKop,
      at: timestamp === undefined ? undefined : new Date(timestamp),
      failReason: typeof body.err_code === 'string' ? body.err_code : undefined,
    };
  }

  private async request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch('https://www.liqpay.ua/api/request', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(this.encode(payload)).toString(), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new PaymentError(`LiqPay HTTP ${response.status}`);
    const body = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PaymentError('Invalid LiqPay response');
    return body as Record<string, unknown>;
  }

  async testConnection(): Promise<void> {
    // A read-only signed request. Creating local checkout data does not test keys.
    const body = await this.request({ action: 'status', order_id: `connection-${randomUUID()}` });
    if (body.err_code !== 'payment_not_found') throw new PaymentError('LiqPay credential check failed');
  }

  async refund(providerRef: string, amountKop: number): Promise<void> {
    if (!Number.isSafeInteger(amountKop) || amountKop <= 0) throw new PaymentError('Invalid refund amount');
    const body = await this.request({ action: 'refund', order_id: providerRef, amount: amountKop / 100 });
    if (body.result !== 'ok' || !['reversed', 'success', 'processing', 'wait_reserve'].includes(String(body.status))) {
      throw new PaymentError('LiqPay refund rejected');
    }
    // Final status still comes from the signed callback, including delayed refunds.
  }

  async cancelUnpaid(_providerRef: string): Promise<void> {
    // Checkout has no unpaid-invoice cancellation API. expired_date limits the
    // bank page; the bridge also checks the current booking before every POST.
  }
}
