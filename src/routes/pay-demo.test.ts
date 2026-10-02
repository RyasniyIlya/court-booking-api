import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
const prisma = { payment: { findUnique: vi.fn() } };
const applyPayEvent = vi.fn();
vi.mock('../lib/db', () => ({ prisma }));
vi.mock('../lib/payments/apply', () => ({ applyPayEvent }));
const { payRouter } = await import('./pay');
const { providerFor } = await import('../lib/payments');
const app = express().use(payRouter);
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DEMO_PAYMENTS', 'true');
  prisma.payment.findUnique.mockResolvedValue({ amount: 50000, clubId: 'demo-club', pageUrl: 'https://api.test/api/pay/mock/mock_123?back=https%3A%2F%2Fsite.test%2Fc%2Fdemo&what=Court' });
  applyPayEvent.mockResolvedValue('applied');
});
afterEach(() => vi.unstubAllEnvs());
/* Клуб обрав тестову оплату в налаштуваннях — вона працює й на
   опублікованому прототипі. Закрити її можна явним DEMO_PAYMENTS=false. */
it('production demo is allowed by default; only explicit false closes it', () => {
  expect(providerFor({ paymentProvider: 'mock', paymentTokenEnc: null })?.name).toBe('mock');
  vi.stubEnv('DEMO_PAYMENTS', '');
  expect(providerFor({ paymentProvider: 'mock', paymentTokenEnc: null })?.name).toBe('mock');
  vi.stubEnv('DEMO_PAYMENTS', 'false');
  expect(providerFor({ paymentProvider: 'mock', paymentTokenEnc: null })).toBeNull();
});
it('keeps both demo endpoints closed when the operator switched them off', async () => {
  vi.stubEnv('DEMO_PAYMENTS', 'false');
  expect((await request(app).get('/mock/mock_123')).status).toBe(404);
  expect((await request(app).post('/mock/mock_123/complete?status=success')).status).toBe(404);
  expect(applyPayEvent).not.toHaveBeenCalled();
});
it('renders the saved amount and clear no-money disclosure', async () => {
  const res = await request(app).get('/mock/mock_123?amount=1&what=Forged');
  expect(res.status).toBe(200);
  expect(res.text).toContain('500.00');
  expect(res.text).toContain('Гроші не списуються');
  expect(res.text).toContain('Це тестова оплата.');
  expect(res.text).toContain('Бронь при цьому створюється по-справжньому');
  expect(res.text).not.toContain('Forged');
});
it.each([['success', 'paid'], ['failure', 'failed']])('applies %s to the stored mock invoice only', async (status, expected) => {
  const res = await request(app).post(`/mock/mock_123/complete?status=${status}&amount=1&hook=http://internal.test&back=https://evil.test`);
  expect(res.status).toBe(303);
  expect(res.headers.location).toBe('https://site.test/c/demo');
  expect(applyPayEvent).toHaveBeenCalledWith('mock', expect.objectContaining({ providerRef: 'mock_123', status: expected, amountKop: 50000 }), 'demo-club');
});
it('cannot complete a payment by following a GET link', async () => {
  expect((await request(app).get('/mock/mock_123/complete?status=success')).status).toBe(404);
  expect(applyPayEvent).not.toHaveBeenCalled();
});
it('rejects nonexistent invoices without confirming a booking', async () => {
  prisma.payment.findUnique.mockResolvedValue(null);
  expect((await request(app).post('/mock/unknown/complete?status=success')).status).toBe(404);
  expect(applyPayEvent).not.toHaveBeenCalled();
});
