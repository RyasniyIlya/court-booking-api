import { afterEach, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { WayForPayProvider, wayForPayKeys } from './wayforpay';

const keys = { merchantAccount: 'club_example_com', secretKey: 'secret_key_12345', domain: 'club.example.com' };
const BASE = 'https://api.test';
const provider = () => new WayForPayProvider(JSON.stringify(keys), BASE);
const md5 = (fields: Array<string | number>, secret = keys.secretKey) => createHmac('md5', secret).update(fields.join(';')).digest('hex');
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body));

const base = {
  merchantAccount: keys.merchantAccount, orderReference: 'order-1', amount: 19.99, currency: 'UAH',
  authCode: '123456', cardPan: '41****1111', transactionStatus: 'Approved', reasonCode: 1100, reason: 'Ok', processingDate: 1788800000,
};
function callback(overrides: Record<string, unknown> = {}, secret = keys.secretKey) {
  const body: Record<string, unknown> = { ...base, ...overrides };
  body.merchantSignature = md5([body.merchantAccount, body.orderReference, body.amount, body.currency, body.authCode ?? '', body.cardPan ?? '', body.transactionStatus, body.reasonCode].map(String), secret);
  return Buffer.from(JSON.stringify(body));
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

const input = { amountKop: 1999, reference: 'booking-1', destination: 'Корт 1', redirectUrl: 'https://app.test/done', webHookUrl: 'https://api.test/hook', ttlSeconds: 900 };

const checkoutOf = (pageUrl: string) => {
  const url = new URL(pageUrl);
  return { url, ref: url.searchParams.get('ref')!, d: url.searchParams.get('d')!, t: url.searchParams.get('t')! };
};

it('builds signed Purchase fields without any network call', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-07T12:00:00Z'));
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const p = provider();
  const invoice = await p.createInvoice(input);
  expect(fetcher).not.toHaveBeenCalled();
  const { url, ref, d, t } = checkoutOf(invoice.pageUrl);
  expect(url.origin + url.pathname).toBe(`${BASE}/api/pay/wayforpay/checkout`);
  expect(ref).toBe(invoice.providerRef);
  const fields = p.readCheckout(ref, d, t);
  const orderDate = Math.floor(Date.parse('2026-09-07T12:00:00Z') / 1000);
  expect(fields).toMatchObject({
    merchantAccount: keys.merchantAccount, merchantDomainName: keys.domain, merchantTransactionType: 'AUTO', merchantTransactionSecureType: 'AUTO',
    orderReference: invoice.providerRef, orderDate: String(orderDate), amount: '19.99', currency: 'UAH', orderTimeout: '900', language: 'UA',
    serviceUrl: input.webHookUrl, 'productName[]': ['Корт 1'], 'productPrice[]': ['19.99'], 'productCount[]': ['1'],
  });
  expect(fields.merchantSignature).toBe(md5([keys.merchantAccount, keys.domain, invoice.providerRef, orderDate, '19.99', 'UAH', 'Корт 1', 1, '19.99'].map(String)));
  expect(invoice.pageUrl).not.toContain(keys.secretKey);
  expect(JSON.stringify(fields)).not.toContain(keys.secretKey);
  expect((await p.createInvoice(input)).providerRef).not.toBe(invoice.providerRef);
});
it('points returnUrl at the signed return route that leads back to the club site', async () => {
  const p = provider();
  const { ref, d, t } = checkoutOf((await p.createInvoice(input)).pageUrl);
  const returnUrl = new URL(p.readCheckout(ref, d, t).returnUrl as string);
  expect(returnUrl.origin + returnUrl.pathname).toBe(`${BASE}/api/pay/wayforpay/return`);
  expect(returnUrl.searchParams.get('ref')).toBe(ref);
  expect(returnUrl.searchParams.get('to')).toBe(input.redirectUrl);
  expect(p.verifyReturn(ref, input.redirectUrl, returnUrl.searchParams.get('t')!)).toBe(true);
  // мітка прив'язана до рахунку, адреси та призначення
  expect(p.verifyReturn(ref, 'https://evil.test/', returnUrl.searchParams.get('t')!)).toBe(false);
  expect(p.verifyReturn(randomUUID(), input.redirectUrl, returnUrl.searchParams.get('t')!)).toBe(false);
  expect(p.verifyReturn(ref, input.redirectUrl, t)).toBe(false);
  expect(p.verifyReturn(ref, input.redirectUrl, '')).toBe(false);
});
it('refuses tampered or foreign checkout data', async () => {
  const p = provider();
  const { ref, d, t } = checkoutOf((await p.createInvoice(input)).pageUrl);
  const forged = Buffer.from(JSON.stringify({ ...p.readCheckout(ref, d, t), amount: '1' })).toString('base64url');
  expect(() => p.readCheckout(ref, forged, t)).toThrow('signature');
  expect(() => p.readCheckout(ref, d, 'f'.repeat(64))).toThrow('signature');
  expect(() => p.readCheckout(randomUUID(), d, t)).toThrow('mismatch');
  const other = new WayForPayProvider(JSON.stringify({ ...keys, secretKey: 'another_secret_1' }), BASE);
  expect(() => other.readCheckout(ref, d, t)).toThrow('signature');
});
it.each([{ amountKop: 0 }, { amountKop: 1.5 }, { ttlSeconds: 0 }])('rejects invalid invoice input: %j', async (change) => {
  await expect(provider().createInvoice({ ...input, ...change })).rejects.toThrow('Invalid WayForPay amount');
});

it('verifies a signed callback and converts hryvnias to kopecks', async () => {
  expect(await provider().parseWebhook(callback())).toMatchObject({ providerRef: 'order-1', status: 'paid', amountKop: 1999, at: new Date(1788800000000), failReason: undefined });
});
it('accepts the JSON delivered as the only key of a form-encoded body', async () => {
  const form = Buffer.from(new URLSearchParams({ [callback().toString()]: '' }).toString());
  expect(await provider().parseWebhook(form)).toMatchObject({ providerRef: 'order-1', status: 'paid', amountKop: 1999 });
});
it('verifies the amount exactly as written in the body', async () => {
  const fields = [base.merchantAccount, 'order-1', '10.00', 'UAH', base.authCode, base.cardPan, 'Approved', '1100'];
  const text = `{"merchantAccount":"${keys.merchantAccount}","orderReference":"order-1","amount":10.00,"currency":"UAH","authCode":"${base.authCode}","cardPan":"${base.cardPan}","transactionStatus":"Approved","reasonCode":1100,"merchantSignature":"${md5(fields)}"}`;
  expect(await provider().parseWebhook(Buffer.from(text))).toMatchObject({ amountKop: 1000 });
});
it('rejects forged signatures and tampered bodies', async () => {
  await expect(provider().parseWebhook(callback({}, 'wrong-secret-123'))).rejects.toThrow('signature');
  const tampered = JSON.parse(callback().toString());
  tampered.amount = 1;
  await expect(provider().parseWebhook(Buffer.from(JSON.stringify(tampered)))).rejects.toThrow('signature');
  await expect(provider().parseWebhook(Buffer.from(JSON.stringify({ ...base })))).rejects.toThrow('signature');
  await expect(provider().parseWebhook(Buffer.from('not json'))).rejects.toThrow();
});
it.each([
  { merchantAccount: 'another_merchant' }, { currency: 'USD' }, { amount: '' }, { amount: null }, { amount: -1 },
  { amount: 'NaN' }, { amount: '1.001' }, { transactionStatus: 'BrandNew' }, { orderReference: '' }, { processingDate: 'bad' },
])('rejects validly signed but invalid payment data: %j', async (change) => {
  await expect(provider().parseWebhook(callback(change))).rejects.toThrow();
});
it.each([
  ['Approved', 'paid'], ['Declined', 'failed'], ['Expired', 'expired'], ['Refunded', 'refunded'], ['Voided', 'refunded'],
  ['InProcessing', 'pending'], ['Pending', 'pending'], ['WaitingAuthComplete', 'pending'], ['RefundInProcessing', 'pending'],
])('normalizes %s to %s', async (transactionStatus, expected) => {
  expect((await provider().parseWebhook(callback({ transactionStatus }))).status).toBe(expected);
});
it('reports the bank reason for unsuccessful payments', async () => {
  const event = await provider().parseWebhook(callback({ transactionStatus: 'Declined', reasonCode: 1104, reason: 'Insufficient Funds' }));
  expect(event.failReason).toBe('1104 Insufficient Funds');
});

it('builds a signed acknowledgement', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-07T12:00:00Z'));
  const time = Math.floor(Date.parse('2026-09-07T12:00:00Z') / 1000);
  expect(provider().webhookAck({ providerRef: 'order-1', status: 'paid' })).toEqual({
    orderReference: 'order-1', status: 'accept', time, signature: md5(['order-1', 'accept', time].map(String)),
  });
});

it('sends a signed refund and accepts only documented outcomes', async () => {
  const fetcher = vi.fn().mockResolvedValue(jsonResponse({ transactionStatus: 'Refunded', reasonCode: 1100 }));
  vi.stubGlobal('fetch', fetcher);
  const p = provider();
  await p.refund('order-1', 1999);
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body).toMatchObject({ transactionType: 'REFUND', orderReference: 'order-1', amount: 19.99, currency: 'UAH', apiVersion: 1 });
  expect(body.comment).toBeTruthy();
  expect(body.merchantSignature).toBe(md5([keys.merchantAccount, 'order-1', '19.99', 'UAH']));
  fetcher.mockResolvedValue(jsonResponse({ transactionStatus: 'RefundInProcessing', reasonCode: 1138 }));
  await p.refund('order-1', 1999);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const rejected of [{ transactionStatus: 'Declined', reasonCode: 1123 }, { transactionStatus: 'Approved', reasonCode: 1100 }, {}]) {
    fetcher.mockResolvedValue(jsonResponse(rejected));
    await expect(p.refund('order-1', 1999)).rejects.toThrow('WayForPay refund rejected');
  }
  await expect(p.refund('order-1', 0)).rejects.toThrow('Invalid refund amount');
});

it('has nothing to cancel for an unpaid Purchase order', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await provider().cancelUnpaid('order-1');
  expect(fetcher).not.toHaveBeenCalled();
});

it('tests credentials with a signed read-only status request', async () => {
  const fetcher = vi.fn().mockResolvedValue(jsonResponse({ reasonCode: 1127, reason: 'Order Not Found' }));
  vi.stubGlobal('fetch', fetcher);
  await provider().testConnection();
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body).toMatchObject({ transactionType: 'CHECK_STATUS', merchantAccount: keys.merchantAccount });
  expect(body.merchantSignature).toBe(md5([keys.merchantAccount, body.orderReference]));
  for (const reasonCode of [1113, 1121, 1100]) {
    fetcher.mockResolvedValue(jsonResponse({ reasonCode }));
    await expect(provider().testConnection()).rejects.toThrow('WayForPay credential check failed');
  }
});

it('rejects the public test merchant in production', () => {
  vi.stubEnv('NODE_ENV', 'production');
  expect(() => new WayForPayProvider(JSON.stringify({ ...keys, merchantAccount: 'test_merch_n1' }), BASE)).toThrow('production');
  expect(() => provider()).not.toThrow();
});

it('validates credentials', () => {
  expect(wayForPayKeys(JSON.stringify({ ...keys, domain: 'Club.Example.com ' }))).toEqual(keys);
  for (const change of [
    { merchantAccount: 'ab' }, { merchantAccount: 'bad account' }, { secretKey: 'short' }, { secretKey: 'has white space 1234' },
    { domain: 'https://club.example.com' }, { domain: 'club.example.com/path' }, { domain: 'club.example.com:8080' }, { domain: 'ab' },
    { domain: '-bad.example.com' }, { secretKey: 7 }, { domain: undefined },
  ]) expect(() => wayForPayKeys(JSON.stringify({ ...keys, ...change }))).toThrow('Invalid WayForPay credentials');
  for (const value of ['plain-token', 'null', '[]', '{}']) expect(() => wayForPayKeys(value)).toThrow('Invalid WayForPay credentials');
});
