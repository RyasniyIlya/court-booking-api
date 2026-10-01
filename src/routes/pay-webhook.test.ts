import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSign, generateKeyPairSync } from 'node:crypto';

/**
 * Вебхук банку — від байтів у мережі до виклику applyPayEvent.
 *
 * Найближче до живого прогону, що досяжно без справжнього банку: провайдер
 * тут НЕ заглушений, це справжній MonoProvider зі справжньою перевіркою
 * підпису. Заглушений лише сам банк (fetch за публічним ключем) і база.
 *
 * Головне, що стереже цей файл, — порядок middleware у src/index.ts. Підпис
 * рахується від сирих байтів тіла, тому payRouter має стояти ДО
 * express.json(). Це не абстрактна вимога: якщо колись хтось поміняє два
 * рядки місцями, тести провайдера лишаться зеленими, а всі до єдиного
 * платежі почнуть відлітати з 400 — гроші списані, броні висять у PENDING.
 * Тому тут два застосунки: правильно змонтований і неправильно.
 */

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PUBKEY_B64 = Buffer.from(
  publicKey.export({ type: 'spki', format: 'pem' }).toString(),
).toString('base64');

const sign = (raw: Buffer) =>
  createSign('SHA256').update(raw).sign(privateKey).toString('base64');

/* Чужа пара — нею підписуємо підробки. */
const alien = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const signAlien = (raw: Buffer) =>
  createSign('SHA256').update(raw).sign(alien.privateKey).toString('base64');

const prisma = { club: { findUnique: vi.fn() } };
const applyPayEvent = vi.fn(async () => 'applied');

vi.mock('../lib/db', () => ({ prisma }));
vi.mock('../lib/payments/apply', () => ({ applyPayEvent }));

/* providerFor підміняємо, бо він лізе за токеном у базу і розшифровує його.
   А от сам провайдер — справжній: саме його перевірку підпису ми й тестуємо. */
const providerFor = vi.fn();
vi.mock('../lib/payments', async () => {
  const { MonoProvider } = await import('../lib/payments/mono');
  return {
    providerFor: (club: unknown) => providerFor(club as never),
    publicBase: () => 'https://api.test',
    MonoProvider,
  };
});

const { payRouter } = await import('./pay');
const { MonoProvider } = await import('../lib/payments/mono');

/** Так змонтовано у src/index.ts: сире тіло, роутер до express.json(). */
const appRaw = express()
  .use('/api/pay', express.raw({ type: '*/*', limit: '100kb' }), payRouter);

/** А так — якби хтось переставив рядки. Тіло вже переспарене. */
const appJson = express()
  .use(express.json({ limit: '100kb' }))
  .use('/api/pay', payRouter);

const CLUB_ID = 'club-1';
const BODY = JSON.stringify({
  invoiceId: 'inv_1', status: 'success', amount: 45000,
  modifiedDate: '2026-08-30T10:15:00Z',
});

let seq = 0;

const post = (app: express.Express, body: string, sig: string) =>
  request(app)
    .post(`/api/pay/webhook/${CLUB_ID}`)
    .set('Content-Type', 'application/json')
    .set('x-sign', sig)
    .send(body);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ key: PUBKEY_B64 }))));

  prisma.club.findUnique.mockResolvedValue({
    id: CLUB_ID, paymentProvider: 'mono', paymentTokenEnc: 'enc',
  });
  // Свій токен на тест: кеш публічного ключа у MonoProvider живе по токену
  providerFor.mockImplementation(() => new MonoProvider(`tok-${++seq}`));
  applyPayEvent.mockResolvedValue('applied');
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('POST /api/pay/webhook/:clubId', () => {
  it('підписаний банком вебхук доходить до applyPayEvent', async () => {
    const raw = Buffer.from(BODY);
    const res = await post(appRaw, BODY, sign(raw));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(applyPayEvent).toHaveBeenCalledTimes(1);
    const [providerName, ev] = applyPayEvent.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(providerName).toBe('mono');
    expect(ev).toMatchObject({
      providerRef: 'inv_1',
      status: 'paid',
      amountKop: 45000,
    });
  });

  /**
   * Той самий валідний вебхук, той самий підпис — і 400 лише тому, що
   * тіло по дорозі пройшло через express.json(). Тест існує, щоб цей
   * спосіб усе зламати був зафіксований, а не жив у коментарі.
   */
  it('той самий вебхук через express.json() відлітає — тому роутер і монтується першим', async () => {
    const raw = Buffer.from(BODY);
    const res = await post(appJson, BODY, sign(raw));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'BAD_WEBHOOK' });
    expect(applyPayEvent).not.toHaveBeenCalled();
  });

  it('чужий підпис — 400 і жодного дотику до бази платежів', async () => {
    const raw = Buffer.from(BODY);
    const res = await post(appRaw, BODY, signAlien(raw));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'BAD_WEBHOOK' });
    expect(applyPayEvent).not.toHaveBeenCalled();
  });

  it('підмінена сума при валідному підписі оригіналу — 400', async () => {
    const original = Buffer.from(BODY);
    const tampered = JSON.stringify({
      invoiceId: 'inv_1', status: 'success', amount: 1,
      modifiedDate: '2026-08-30T10:15:00Z',
    });

    const res = await post(appRaw, tampered, sign(original));

    expect(res.status).toBe(400);
    expect(applyPayEvent).not.toHaveBeenCalled();
  });

  it('невідомий клуб — 404', async () => {
    prisma.club.findUnique.mockResolvedValue(null);
    const raw = Buffer.from(BODY);

    const res = await post(appRaw, BODY, sign(raw));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND' });
    expect(applyPayEvent).not.toHaveBeenCalled();
  });

  it('клуб без налаштованої платіжки — 404 PAYMENTS_OFF', async () => {
    providerFor.mockReturnValue(null);
    const raw = Buffer.from(BODY);

    const res = await post(appRaw, BODY, sign(raw));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'PAYMENTS_OFF' });
    expect(applyPayEvent).not.toHaveBeenCalled();
  });

  /* Банк робить до трьох спроб. 500 — єдиний спосіб попросити повтор,
     і саме він потрібен, коли впала наша база, а не підпис. */
  it('падіння applyPayEvent — 500, щоб банк повторив', async () => {
    applyPayEvent.mockRejectedValue(new Error('база лягла'));
    const raw = Buffer.from(BODY);

    const res = await post(appRaw, BODY, sign(raw));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'INTERNAL' });
  });

  /* А ось «рахунок нам невідомий» повторювати безглуздо: скільки не шли,
     він відомішим не стане. Тому 200, попри те, що нічого не змінилось. */
  it('подія без наслідків — усе одно 200, щоб банк НЕ повторював', async () => {
    applyPayEvent.mockResolvedValue('unknown-invoice');
    const raw = Buffer.from(BODY);

    const res = await post(appRaw, BODY, sign(raw));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('вебхук без підпису — 400', async () => {
    const res = await request(appRaw)
      .post(`/api/pay/webhook/${CLUB_ID}`)
      .set('Content-Type', 'application/json')
      .send(BODY);

    expect(res.status).toBe(400);
    expect(applyPayEvent).not.toHaveBeenCalled();
  });
});

describe('webhook acknowledgement', () => {
  /* Провайдер із власним форматом підтвердження (WayForPay) отримує його
     замість стандартного { ok: true } — інакше банк повторював би вебхук
     до 4 діб. Решта провайдерів лишається на { ok: true }. */
  it('віддає тіло з webhookAck, якщо провайдер його має', async () => {
    const event = { providerRef: 'ord_1', status: 'paid' as const, amountKop: 100 };
    const webhookAck = vi.fn(() => ({ accept: 'custom' }));
    providerFor.mockReturnValue({ name: 'custom', parseWebhook: async () => event, webhookAck });

    const res = await request(appRaw).post(`/api/pay/webhook/${CLUB_ID}`).set('Content-Type', 'application/json').send('{}');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accept: 'custom' });
    expect(webhookAck).toHaveBeenCalledWith(event);
    expect(applyPayEvent).toHaveBeenCalledWith('custom', event, CLUB_ID);
  });

  it('без webhookAck відповідь лишається { ok: true }', async () => {
    providerFor.mockReturnValue({ name: 'plain', parseWebhook: async () => ({ providerRef: 'ord_1', status: 'paid' }) });

    const res = await request(appRaw).post(`/api/pay/webhook/${CLUB_ID}`).set('Content-Type', 'application/json').send('{}');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('справжній WayForPay: підписаний вебхук дає підписане підтвердження', async () => {
    const { createHmac } = await import('node:crypto');
    const { WayForPayProvider } = await import('../lib/payments/wayforpay');
    const creds = { merchantAccount: 'club_example_com', secretKey: 'secret_key_12345', domain: 'club.example.com' };
    providerFor.mockImplementation(() => new WayForPayProvider(JSON.stringify(creds)));
    const md5 = (f: string[]) => createHmac('md5', creds.secretKey).update(f.join(';')).digest('hex');
    const body = {
      merchantAccount: creds.merchantAccount, orderReference: 'ord_1', amount: 450, currency: 'UAH', authCode: '1', cardPan: '41****1111',
      transactionStatus: 'Approved', reasonCode: 1100, merchantSignature: md5([creds.merchantAccount, 'ord_1', '450', 'UAH', '1', '41****1111', 'Approved', '1100']),
    };

    const res = await request(appRaw).post(`/api/pay/webhook/${CLUB_ID}`).set('Content-Type', 'application/json').send(JSON.stringify(body));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ orderReference: 'ord_1', status: 'accept' });
    expect(res.body.signature).toBe(md5(['ord_1', 'accept', String(res.body.time)]));
    expect(applyPayEvent).toHaveBeenCalledWith('wayforpay', expect.objectContaining({ providerRef: 'ord_1', status: 'paid', amountKop: 45000 }), CLUB_ID);
  });
});
