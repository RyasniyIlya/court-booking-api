import { createVerify } from 'node:crypto';
import type {
  PayProvider, CreateInvoiceInput, Invoice, WebhookEvent, PayEventStatus,
} from './types';
import { PaymentError } from './types';

/**
 * Plata by mono — еквайринг монобанку.
 * Документація: https://api.monobank.ua/docs/acquiring.html
 *
 * Обрано першим, бо у клубу-ФОПа найімовірніше вже є рахунок у моно,
 * і комісія 1,3% — найнижча на ринку.
 */

const BASE = process.env.MONO_API_BASE ?? 'https://api.monobank.ua';

/** Статуси mono -> наші. hold нам не трапляється: працюємо у режимі debit. */
const STATUS_MAP: Record<string, PayEventStatus> = {
  created: 'pending',
  processing: 'pending',
  hold: 'pending',
  success: 'paid',
  failure: 'failed',
  reversed: 'refunded',
  expired: 'expired',
};

/**
 * Публічний ключ мерчанта. Змінюється вкрай рідко, а вебхуки приходять
 * пачками — тримаємо в памʼяті на годину, щоб не ходити по мережі на кожен.
 *
 * refetchAfter — не раніше якого часу дозволено перечитати ключ достроково
 * (див. parseWebhook).
 */
const pubkeyCache = new Map<string, { pem: string; until: number; refetchAfter: number }>();
const PUBKEY_TTL_MS = 60 * 60 * 1000;

/**
 * Як часто дозволено перечитувати ключ через непідхожий підпис.
 *
 * Роут вебхука публічний і нічим не прикритий, крім самого підпису. Якби
 * кожен невдалий підпис гнав нас у банк, будь-хто зміг би шквалом підробок
 * влаштувати нам потік запитів до mono з токеном клуба — і токен поїхав би
 * у рейт-ліміт банку. Хвилина — стеля для підробок і водночас максимальна
 * затримка відновлення після справжньої ротації ключа.
 */
const PUBKEY_REFETCH_COOLDOWN_MS = 60 * 1000;

export class MonoProvider implements PayProvider {
  readonly name = 'mono';

  constructor(private readonly token: string) {
    if (!token) throw new PaymentError('Порожній токен еквайрингу');
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${BASE}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'X-Token': this.token,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new PaymentError('Банк недоступний', e);
    }

    const text = await r.text();
    if (!r.ok) {
      // errText — поле помилки mono. Не тягнемо його у відповідь гравцю:
      // там може бути внутрішня інформація мерчанта.
      console.error('[mono]', path, r.status, text.slice(0, 400));
      throw new PaymentError(`mono ${path} -> ${r.status}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
    const res = await this.call<{ invoiceId: string; pageUrl: string }>(
      '/api/merchant/invoice/create',
      {
        amount: input.amountKop,
        ccy: 980,
        paymentType: 'debit',
        redirectUrl: input.redirectUrl,
        webHookUrl: input.webHookUrl,
        validity: input.ttlSeconds,
        merchantPaymInfo: {
          reference: input.reference,
          destination: input.destination,
        },
      },
    );
    if (!res.invoiceId || !res.pageUrl) throw new PaymentError('mono повернув порожній рахунок');
    return { providerRef: res.invoiceId, pageUrl: res.pageUrl };
  }

  /** force — піти в банк навіть за живого кеша (ключ провернувся) */
  private async pubkey(force = false): Promise<string> {
    const cached = pubkeyCache.get(this.token);
    if (!force && cached && cached.until > Date.now()) return cached.pem;

    const res = await this.call<{ key: string }>('/api/merchant/pubkey');
    if (!res.key) throw new PaymentError('mono не віддав публічний ключ');

    const pem = Buffer.from(res.key, 'base64').toString('utf8');
    const now = Date.now();
    pubkeyCache.set(this.token, {
      pem,
      until: now + PUBKEY_TTL_MS,
      refetchAfter: now + PUBKEY_REFETCH_COOLDOWN_MS,
    });
    return pem;
  }

  async parseWebhook(rawBody: Buffer, headers: NodeJS.Dict<string | string[]>): Promise<WebhookEvent> {
    const sign = headers['x-sign'];
    const sigB64 = Array.isArray(sign) ? sign[0] : sign;
    if (!sigB64) throw new PaymentError('Вебхук без підпису');

    // Підпис рахується від СИРИХ байтів тіла. Якщо тіло десь пройшло через
    // JSON.parse -> JSON.stringify, підпис не збіжиться.
    const sig = Buffer.from(sigB64, 'base64');
    const verify = (pem: string) => createVerify('SHA256').update(rawBody).verify(pem, sig);

    /* Ключ мерчанта може провернутись. Кешований ключ, який не підійшов, —
       привід перечитати його з банку, а не одразу відбити вебхук: інакше
       після ротації ми годину відбивали б кожен платіж, гроші списувались
       би, а броні висіли в PENDING. Дострокове перечитування — не частіше
       разу на хвилину, див. PUBKEY_REFETCH_COOLDOWN_MS. */
    const cached = pubkeyCache.get(this.token);
    const fromCache = Boolean(cached && cached.until > Date.now());

    let ok = verify(await this.pubkey());
    if (!ok && fromCache && cached!.refetchAfter <= Date.now()) {
      ok = verify(await this.pubkey(true));
    }
    if (!ok) throw new PaymentError('Підпис вебхука не збігся');

    let body: {
      invoiceId?: string; status?: string; amount?: number;
      modifiedDate?: string; failureReason?: string; errCode?: string;
    };
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch (e) {
      throw new PaymentError('Вебхук не є JSON', e);
    }

    if (!body.invoiceId || !body.status) throw new PaymentError('Вебхук без invoiceId або status');

    const status = STATUS_MAP[body.status];
    if (!status) throw new PaymentError(`Невідомий статус mono: ${body.status}`);

    return {
      providerRef: body.invoiceId,
      status,
      amountKop: typeof body.amount === 'number' ? body.amount : undefined,
      at: body.modifiedDate ? new Date(body.modifiedDate) : undefined,
      failReason: body.failureReason ?? body.errCode,
    };
  }

  async refund(providerRef: string, amountKop: number): Promise<void> {
    await this.call('/api/merchant/invoice/cancel', {
      invoiceId: providerRef,
      amount: amountKop,
    });
  }

  async cancelUnpaid(providerRef: string): Promise<void> {
    // remove працює тільки для неоплачених рахунків — саме наш випадок
    await this.call('/api/merchant/invoice/remove', { invoiceId: providerRef });
  }
}
