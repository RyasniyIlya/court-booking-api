import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
const prisma = { club: { findUnique: vi.fn(), update: vi.fn() }, payment: { count: vi.fn() } };
vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('../../lib/payments', () => ({ KNOWN_PROVIDERS: ['mono', 'liqpay', 'mock'], providerFor: vi.fn(), publicBase: () => 'http://localhost' }));
vi.mock('../../lib/crypto', () => ({ encryptSecret: () => 'encrypted', paymentsSecretReady: () => true }));
vi.mock('../public', () => ({ logoSrcOf: () => null }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => { req.auth = { clubId: 'club', level: 3 }; next(); },
  requireStaff: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireLevel: () => (_req: unknown, _res: unknown, next: () => void) => next(),
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
