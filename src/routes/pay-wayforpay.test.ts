import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { WayForPayProvider } from '../lib/payments/wayforpay';

const keys = { merchantAccount: 'club_example_com', secretKey: 'secret_key_12345', domain: 'club.example.com' };
const prisma = { payment: { findUnique: vi.fn() }, club: { findUnique: vi.fn() } };
const applyPayEvent = vi.fn();
vi.mock('../lib/db', () => ({ prisma }));
vi.mock('../lib/crypto', () => ({ decryptSecret: () => JSON.stringify(keys) }));
vi.mock('../lib/payments/apply', () => ({ applyPayEvent }));
const { payRouter } = await import('./pay');
const app = express().use('/api/pay', express.raw({ type: '*/*' }), payRouter);
const club = { id: 'club-1', paymentProvider: 'wayforpay', paymentTokenEnc: 'encrypted' };
const redirectUrl = 'https://app.test/club?cbPay=11111111-2222-3333-4444-555555555555';
const target = () => ({ status: 'PENDING', expiresAt: new Date(Date.now() + 600000) });
const pathOf = (pageUrl: string) => new URL(pageUrl).pathname + new URL(pageUrl).search;

async function checkout(overrides: Record<string, unknown> = {}, ttlSeconds = 900) {
  const provider = new WayForPayProvider(JSON.stringify(keys), 'https://api.test');
  const invoice = await provider.createInvoice({ amountKop: 1999, reference: 'booking-1', destination: 'Корт', redirectUrl, webHookUrl: 'https://api.test/api/pay/webhook/club-1', ttlSeconds });
  prisma.payment.findUnique.mockResolvedValue({ providerRef: invoice.providerRef, status: 'PENDING', amount: 1999, club, booking: target(), seat: null, ...overrides });
  return { invoice, path: pathOf(invoice.pageUrl) };
}
/** Адреса, на яку WayForPay поверне гравця: дістаємо її з полів форми */
async function returnPath() {
  const { invoice, path } = await checkout();
  const html = (await request(app).get(path)).text;
  const returnUrl = /name="returnUrl" value="([^"]+)"/.exec(html)![1].replace(/&amp;/g, '&');
  return { invoice, path: pathOf(returnUrl) };
}
beforeEach(() => {
  vi.clearAllMocks();
  prisma.club.findUnique.mockResolvedValue(club);
});

it('POSTs the signed Purchase form to WayForPay with no secret and a locked-down CSP', async () => {
  const { invoice, path } = await checkout();
  const response = await request(app).get(path);
  expect(response.status).toBe(200);
  expect(response.text).toContain('method="POST" action="https://secure.wayforpay.com/pay"');
  for (const name of ['merchantAccount', 'merchantSignature', 'orderReference', 'orderDate', 'amount', 'currency', 'orderTimeout', 'returnUrl', 'serviceUrl', 'productName[]', 'productPrice[]', 'productCount[]']) {
    expect(response.text).toContain(`name="${name}"`);
  }
  expect(response.text).toContain(`name="orderReference" value="${invoice.providerRef}"`);
  expect(response.text).toContain('name="amount" value="19.99"');
  expect(response.text).not.toContain(keys.secretKey);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  const csp = response.headers['content-security-policy'];
  expect(csp).toContain('form-action https://secure.wayforpay.com;');
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toMatch(/script-src 'nonce-[0-9a-f-]{36}'/);
});
it('supports group seat checkout', async () => {
  const { path } = await checkout({ booking: null, seat: { ...target(), booking: { status: 'CONFIRMED' } } });
  expect((await request(app).get(path)).status).toBe(200);
});
it.each([
  { status: 'PAID' }, { booking: { status: 'CANCELLED', expiresAt: new Date(Date.now() + 60000) } },
  { booking: { status: 'PENDING', expiresAt: new Date(0) } }, { booking: { status: 'EXPIRED', expiresAt: null } },
  { booking: null, seat: { status: 'PENDING', expiresAt: new Date(Date.now() + 60000), booking: { status: 'CANCELLED' } } },
])('blocks checkout for closed or expired bookings: %j', async (change) => {
  const response = await request(app).get((await checkout(change)).path);
  expect(response.status).toBe(410);
  expect(response.text).toContain('Ця оплата вже завершена');
});
it('blocks checkout once the order lifetime in the signed form has passed', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const { path } = await checkout({}, 60);
    vi.setSystemTime(Date.now() + 120000);
    prisma.payment.findUnique.mockResolvedValue({ status: 'PENDING', amount: 1999, club, booking: { status: 'PENDING', expiresAt: new Date(Date.now() + 600000) }, seat: null, providerRef: 'x' });
    expect((await request(app).get(path)).status).toBe(410);
  } finally { vi.useRealTimers(); }
});
it('rejects tampered checkout data, tags and parameters', async () => {
  const { invoice, path } = await checkout();
  const url = new URL(path, 'https://api.test');
  const get = (mutate: (u: URL) => void) => { const u = new URL(url); mutate(u); return request(app).get(u.pathname + u.search); };
  const d = JSON.parse(Buffer.from(url.searchParams.get('d')!, 'base64url').toString('utf8'));
  expect((await get((u) => u.searchParams.set('d', Buffer.from(JSON.stringify({ ...d, amount: '1' })).toString('base64url')))).status).toBe(400);
  expect((await get((u) => u.searchParams.set('t', 'f'.repeat(64)))).status).toBe(400);
  expect((await get((u) => u.searchParams.delete('t'))).status).toBe(400);
  expect((await get((u) => u.searchParams.set('d', 'x'.repeat(9000)))).status).toBe(400);
  expect((await get((u) => u.searchParams.set('ref', 'not-a-uuid'))).status).toBe(400);
  expect(invoice.providerRef).toBeTruthy();
});
it('rejects a validly signed form whose amount differs from the stored payment', async () => {
  const { path } = await checkout({ amount: 5000 });
  expect((await request(app).get(path)).status).toBe(400);
});
it('answers 404 for an unknown order at checkout', async () => {
  const { path } = await checkout();
  prisma.payment.findUnique.mockResolvedValue(null);
  expect((await request(app).get(path)).status).toBe(404);
});
it('refuses checkout when the club no longer uses WayForPay', async () => {
  const { path } = await checkout({ club: { ...club, paymentProvider: 'mono' } });
  expect((await request(app).get(path)).status).toBe(409);
});

it.each(['get', 'post'] as const)('sends the player back to the signed club URL on %s', async (method) => {
  const { path } = await returnPath();
  const response = await request(app)[method](path).send(method === 'post' ? 'transactionStatus=Approved&orderReference=x' : undefined);
  expect(response.status).toBe(303);
  expect(response.headers.location).toBe(redirectUrl);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(applyPayEvent).not.toHaveBeenCalled();
});
it('does not follow a tampered or unsigned return target', async () => {
  const { path } = await returnPath();
  const url = new URL(path, 'https://api.test');
  const get = (mutate: (u: URL) => void) => { const u = new URL(url); mutate(u); return request(app).get(u.pathname + u.search); };
  expect((await get((u) => u.searchParams.set('to', 'https://evil.test/'))).status).toBe(400);
  expect((await get((u) => u.searchParams.set('t', 'f'.repeat(64)))).status).toBe(400);
  expect((await get((u) => u.searchParams.delete('t'))).status).toBe(400);
  expect((await get((u) => u.searchParams.delete('to'))).status).toBe(400);
  expect((await get((u) => u.searchParams.set('ref', 'not-a-uuid'))).status).toBe(400);
});
it('never redirects to a non-http target even if it were signed', async () => {
  const provider = new WayForPayProvider(JSON.stringify(keys), 'https://api.test');
  const { invoice } = await checkout();
  const evil = 'javascript:alert(1)';
  // чужа мітка з іншого призначення також не годиться
  const checkoutTag = new URL(invoice.pageUrl).searchParams.get('t')!;
  expect(provider.verifyReturn(invoice.providerRef, evil, checkoutTag)).toBe(false);
  const path = `/api/pay/wayforpay/return?${new URLSearchParams({ ref: invoice.providerRef, to: evil, t: checkoutTag })}`;
  expect((await request(app).get(path)).status).toBe(400);
});
it('answers 400 for an unknown order on return', async () => {
  const { path } = await returnPath();
  prisma.payment.findUnique.mockResolvedValue(null);
  expect((await request(app).get(path)).status).toBe(400);
});
