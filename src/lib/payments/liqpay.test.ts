import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { LiqPayProvider } from './liqpay';

const keys = { publicKey: 'public_key_12345', privateKey: 'private_key_12345' };
const provider = () => new LiqPayProvider(JSON.stringify(keys), 'https://api.test');
const body = { version: 7, public_key: keys.publicKey, action: 'pay', order_id: 'order-1', status: 'success', currency: 'UAH', amount: '19.99', end_date: '1788800000000' };
function callback(overrides = {}, secret = keys.privateKey, algorithm = 'sha3-256') {
  const data = Buffer.from(JSON.stringify({ ...body, ...overrides })).toString('base64');
  const signature = createHash(algorithm).update(secret + data + secret).digest('base64');
  return Buffer.from(new URLSearchParams({ data, signature }).toString());
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it('builds signed v7 checkout data with exact amount, expiry and a unique order', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-07T12:00:00Z'));
  const input = { amountKop: 1999, reference: 'booking-1', destination: 'Корт', redirectUrl: 'https://app.test/done', webHookUrl: 'https://api.test/hook', ttlSeconds: 900 };
  const p = provider();
  const invoice = await p.createInvoice(input);
  const url = new URL(invoice.pageUrl);
  const payload = p.readSigned(url.searchParams.get('data')!, url.searchParams.get('signature')!);
  expect(payload).toMatchObject({ version: 7, amount: 19.99, order_id: invoice.providerRef, currency: 'UAH', action: 'pay', expired_date: '2026-09-07 12:15:00', server_url: input.webHookUrl, result_url: input.redirectUrl });
  expect(invoice.pageUrl).not.toContain(keys.privateKey);
  expect((await p.createInvoice(input)).providerRef).not.toBe(invoice.providerRef);
});
it('verifies a signed form callback and converts hryvnias to kopecks', async () => {
  expect(await provider().parseWebhook(callback())).toMatchObject({ providerRef: 'order-1', status: 'paid', amountKop: 1999, at: new Date(1788800000000) });
});
it.each(['wrong-secret', keys.privateKey])('rejects forged or legacy signatures', async (secret) => {
  await expect(provider().parseWebhook(callback({}, secret, secret === keys.privateKey ? 'sha1' : 'sha3-256'))).rejects.toThrow('signature');
});
it.each([
  { public_key: 'another-merchant' }, { currency: 'USD' }, { amount: '' }, { amount: null },
  { amount: -1 }, { amount: 'NaN' }, { amount: '1.001' }, { end_date: 'bad' },
  { status: 'sandbox' }, { sandbox: '1' }, { status: 'new-unknown-status' },
  { action: 'subscribe' }, { version: 3 }, { order_id: '' },
])('rejects invalid signed payment data: %j', async (change) => {
  vi.stubEnv('NODE_ENV', 'production');
  await expect(provider().parseWebhook(callback(change))).rejects.toThrow();
});
it.each([['reversed', 'refunded'], ['wait_compensation', 'paid'], ['failure', 'failed'], ['processing', 'pending'], ['wait_accept', 'pending'], ['try_again', 'pending']])('normalizes %s to %s', async (status, expected) => {
  expect((await provider().parseWebhook(callback({ status }))).status).toBe(expected);
});
it('rejects duplicate callback fields', async () => {
  await expect(provider().parseWebhook(Buffer.from(callback().toString() + '&data=other'))).rejects.toThrow();
});
it('sends a signed refund and checks the business response', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: 'ok', status: 'reversed' })));
  vi.stubGlobal('fetch', fetcher);
  const p = provider();
  await p.refund('order-1', 1999);
  const [url, request] = fetcher.mock.calls[0];
  expect(url).toBe('https://www.liqpay.ua/api/request');
  const form = new URLSearchParams(request.body);
  expect(p.readSigned(form.get('data')!, form.get('signature')!)).toMatchObject({ action: 'refund', amount: 19.99, order_id: 'order-1' });
  fetcher.mockResolvedValue(new Response(JSON.stringify({ result: 'error', status: 'failure' })));
  await expect(p.refund('order-1', 1999)).rejects.toThrow('rejected');
});
it('tests credentials through the API, not by generating local checkout data', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ err_code: 'payment_not_found' })));
  vi.stubGlobal('fetch', fetcher);
  await provider().testConnection();
  fetcher.mockResolvedValue(new Response(JSON.stringify({ err_code: 'err_signature' })));
  await expect(provider().testConnection()).rejects.toThrow();
});
it('rejects production sandbox keys', () => {
  vi.stubEnv('NODE_ENV', 'production');
  expect(() => new LiqPayProvider(JSON.stringify({ ...keys, publicKey: 'sandbox_1234567' }), 'https://api.test')).toThrow('sandbox');
});
it('allows sandbox confirmation only outside production', async () => {
  vi.stubEnv('NODE_ENV', 'test');
  expect((await provider().parseWebhook(callback({ sandbox: '1', status: 'sandbox' }))).status).toBe('paid');
});
