import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
const prisma = { club: { findUnique: vi.fn(), update: vi.fn() }, payment: { count: vi.fn() } };
vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('../../lib/payments', () => ({ KNOWN_PROVIDERS: ['mono', 'liqpay', 'wayforpay', 'stripe', 'mock'], providerFor: vi.fn(), publicBase: () => 'http://localhost' }));
vi.mock('../../lib/crypto', () => ({ encryptSecret: () => 'encrypted', paymentsSecretReady: () => true }));
vi.mock('../public', () => ({ logoSrcOf: () => null }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => { req.auth = { clubId: 'club', role: 'OWNER' }; next(); },
  requireStaff: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const { clubRouter } = await import('./club');
const app = express().use(express.json()).use(clubRouter);
beforeEach(() => {
  vi.clearAllMocks();
  prisma.payment.count.mockResolvedValue(0);
  prisma.club.findUnique.mockResolvedValue({ prepayEnabled: false, paymentProvider: 'mono', paymentTokenEnc: null });
  prisma.club.update.mockResolvedValue({ id: 'club' });
});
it.each([{}, { paymentToken: null }, { paymentProvider: null }])('rejects enabling without credentials: %j', async extra => {
  const res = await request(app).patch('/club').send({ prepayEnabled: true, ...extra });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('PAYMENTS_NOT_CONFIGURED');
  expect(prisma.club.update).not.toHaveBeenCalled();
});
it('accepts an existing token', async () => {
  prisma.club.findUnique.mockResolvedValue({ prepayEnabled: false, paymentProvider: 'mono', paymentTokenEnc: 'encrypted' });
  expect((await request(app).patch('/club').send({ prepayEnabled: true })).status).toBe(200);
});
it('accepts a new token and encrypts it', async () => {
  expect((await request(app).patch('/club').send({ prepayEnabled: true, paymentToken: 'test-token-value' })).status).toBe(200);
  expect(prisma.club.update.mock.calls[0][0].data.paymentTokenEnc).toBe('encrypted');
});
it('blocks deleting the token while payments remain enabled', async () => {
  prisma.club.findUnique.mockResolvedValue({ prepayEnabled: true, paymentProvider: 'mono', paymentTokenEnc: 'encrypted' });
  expect((await request(app).patch('/club').send({ paymentToken: null })).status).toBe(400);
});
it('allows disabling payments and removing the token', async () => {
  expect((await request(app).patch('/club').send({ prepayEnabled: false, paymentToken: null })).status).toBe(200);
});
it('allows explicit mock payments without bank credentials', async () => {
  expect((await request(app).patch('/club').send({ prepayEnabled: true, paymentProvider: 'mock' })).status).toBe(200);
});
it('accepts LiqPay key pairs and rejects a single old bank token', async () => {
  const valid = JSON.stringify({ publicKey: 'public_key_12345', privateKey: 'private_key_12345' });
  expect((await request(app).patch('/club').send({ prepayEnabled: true, paymentProvider: 'liqpay', paymentToken: valid })).status).toBe(200);
  expect((await request(app).patch('/club').send({ prepayEnabled: true, paymentProvider: 'liqpay', paymentToken: 'old-bank-token' })).body.error).toBe('PAYMENT_CREDENTIALS_INVALID');
});
it('accepts WayForPay and Stripe credential sets and rejects malformed ones', async () => {
  const wayforpay = JSON.stringify({ merchantAccount: 'club_example_com', secretKey: 'secret_key_12345', domain: 'club.example.com' });
  const stripe = JSON.stringify({ secretKey: 'sk_live_abcdefghij1234567890', webhookSecret: 'whsec_abcdefghij1234567890' });
  const send = (paymentProvider: string, paymentToken: string) => request(app).patch('/club').send({ prepayEnabled: true, paymentProvider, paymentToken });
  expect((await send('wayforpay', wayforpay)).status).toBe(200);
  expect((await send('stripe', stripe)).status).toBe(200);
  // Ключі одного провайдера не підходять іншому, а одинокий старий токен — нікому з трьох.
  for (const [provider, token] of [
    ['wayforpay', stripe], ['stripe', wayforpay], ['wayforpay', 'old-bank-token'], ['stripe', 'sk_live_abcdefghij1234567890'],
    ['wayforpay', JSON.stringify({ merchantAccount: 'club_example_com', secretKey: 'secret_key_12345', domain: 'https://club.example.com' })],
    ['stripe', JSON.stringify({ secretKey: 'sk_live_abcdefghij1234567890', webhookSecret: 'bad' })],
  ]) {
    const res = await send(provider, token);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('PAYMENT_CREDENTIALS_INVALID');
  }
});
it('allows credentials up to 600 characters and exposes the webhook URL to paste into the provider', async () => {
  const long = JSON.stringify({ secretKey: 'sk_live_' + 'a'.repeat(200), webhookSecret: 'whsec_' + 'b'.repeat(200) });
  expect(long.length).toBeGreaterThan(400);
  const res = await request(app).patch('/club').send({ prepayEnabled: true, paymentProvider: 'stripe', paymentToken: long });
  expect(res.status).toBe(200);
  expect(res.body.paymentWebhookUrl).toBe('http://localhost/api/pay/webhook/club');
});
it('returns the webhook URL from the club read as well', async () => {
  prisma.club.findUnique.mockResolvedValue({ id: 'club', paymentProvider: 'stripe', paymentTokenEnc: 'encrypted' });
  const res = await request(app).get('/club');
  expect(res.body).toMatchObject({ hasPaymentToken: true, paymentWebhookUrl: 'http://localhost/api/pay/webhook/club' });
});
it('clears old keys when changing provider with online payments disabled', async () => {
  prisma.club.findUnique.mockResolvedValue({ prepayEnabled: false, paymentProvider: 'mono', paymentTokenEnc: 'encrypted' });
  expect((await request(app).patch('/club').send({ paymentProvider: 'liqpay' })).status).toBe(200);
  expect(prisma.club.update.mock.calls[0][0].data.paymentTokenEnc).toBeNull();
});
it.each([{ paymentProvider: 'liqpay' }, { paymentToken: 'replacement-token' }, { paymentToken: null, prepayEnabled: false }])('protects credentials needed by existing payments: %j', async (change) => {
  prisma.club.findUnique.mockResolvedValue({ prepayEnabled: true, paymentProvider: 'mono', paymentTokenEnc: 'encrypted' });
  prisma.payment.count.mockResolvedValue(1);
  const response = await request(app).patch('/club').send(change);
  expect(response.status).toBe(409);
  expect(response.body.error).toBe('PAYMENT_PROVIDER_IN_USE');
  expect(prisma.club.update).not.toHaveBeenCalled();
});
