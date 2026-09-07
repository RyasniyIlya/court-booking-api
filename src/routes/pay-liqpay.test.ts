import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { LiqPayProvider } from '../lib/payments/liqpay';

const keys = { publicKey: 'public_key_12345', privateKey: 'private_key_12345' };
const prisma = { payment: { findUnique: vi.fn() }, club: { findUnique: vi.fn() } };
const applyPayEvent = vi.fn();
vi.mock('../lib/db', () => ({ prisma }));
vi.mock('../lib/crypto', () => ({ decryptSecret: () => JSON.stringify(keys) }));
vi.mock('../lib/payments/apply', () => ({ applyPayEvent }));
const { payRouter } = await import('./pay');
const app = express().use('/api/pay', express.raw({ type: '*/*' }), payRouter);
const club = { id: 'club-1', paymentProvider: 'liqpay', paymentTokenEnc: 'encrypted' };
const target = () => ({ status: 'PENDING', expiresAt: new Date(Date.now() + 600000) });
async function checkout(overrides: Record<string, unknown> = {}) {
  const provider = new LiqPayProvider(JSON.stringify(keys), 'https://api.test');
  const invoice = await provider.createInvoice({ amountKop: 1999, reference: 'booking-1', destination: 'Корт', redirectUrl: 'https://app.test/done', webHookUrl: 'https://api.test/api/pay/webhook/club-1', ttlSeconds: 900 });
  prisma.payment.findUnique.mockResolvedValue({ providerRef: invoice.providerRef, status: 'PENDING', amount: 1999, club, booking: target(), seat: null, ...overrides });
  return new URL(invoice.pageUrl).pathname + new URL(invoice.pageUrl).search;
}
function callback(tampered = false) {
  const payload = { version: 7, public_key: keys.publicKey, action: 'pay', order_id: 'order-1', amount: '19.99', currency: 'UAH', status: 'success' };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = createHash('sha3-256').update(keys.privateKey + data + keys.privateKey).digest('base64');
  return new URLSearchParams({ data: tampered ? data + 'A' : data, signature }).toString();
}
beforeEach(() => {
  vi.clearAllMocks();
  prisma.club.findUnique.mockResolvedValue(club);
  applyPayEvent.mockResolvedValue('applied');
});
it('POSTs the signed checkout to LiqPay with no private key or cache', async () => {
  const response = await request(app).get(await checkout());
  expect(response.status).toBe(200);
  expect(response.text).toContain('method="POST" action="https://www.liqpay.ua/api/3/checkout"');
  expect(response.text).not.toContain(keys.privateKey);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
});
it.each([
  { status: 'PAID' }, { booking: { status: 'CANCELLED', expiresAt: new Date(Date.now() + 60000) } },
  { booking: { status: 'PENDING', expiresAt: new Date(0) } },
  { booking: null, seat: { status: 'PENDING', expiresAt: new Date(Date.now() + 60000), booking: { status: 'CANCELLED' } } },
])('blocks checkout for closed or expired bookings: %j', async (change) => {
  expect((await request(app).get(await checkout(change))).status).toBe(410);
});
it('supports group seat checkout', async () => {
  expect((await request(app).get(await checkout({ booking: null, seat: { ...target(), booking: { status: 'CONFIRMED' } } }))).status).toBe(200);
});
it('rejects a forged checkout signature', async () => {
  const url = new URL(await checkout(), 'https://api.test');
  url.searchParams.set('signature', 'fake');
  expect((await request(app).get(url.pathname + url.search)).status).toBe(400);
});
it('passes only verified form callbacks to the shared payment handler with club scope', async () => {
  const response = await request(app).post('/api/pay/webhook/club-1').type('form').send(callback());
  expect(response.status).toBe(200);
  expect(applyPayEvent).toHaveBeenCalledWith('liqpay', expect.objectContaining({ providerRef: 'order-1', amountKop: 1999, status: 'paid' }), 'club-1');
  applyPayEvent.mockClear();
  expect((await request(app).post('/api/pay/webhook/club-1').type('form').send(callback(true))).status).toBe(400);
  expect(applyPayEvent).not.toHaveBeenCalled();
});
it('asks the bank to retry when persistence fails', async () => {
  applyPayEvent.mockRejectedValueOnce(new Error('database unavailable'));
  expect((await request(app).post('/api/pay/webhook/club-1').type('form').send(callback())).status).toBe(500);
});
