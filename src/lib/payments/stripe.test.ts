import { afterEach, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { StripeProvider, stripeKeys } from './stripe';

const keys = { secretKey: 'sk_test_abcdefghij1234567890', webhookSecret: 'whsec_abcdefghij1234567890' };
const provider = () => new StripeProvider(JSON.stringify(keys));
const NOW = Date.parse('2026-09-07T12:00:00Z');
const nowSeconds = Math.floor(NOW / 1000);
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const session = { id: 'cs_test_a1', object: 'checkout.session', currency: 'uah', amount_total: 1999, payment_status: 'paid', livemode: false };
function event(type: string, object: Record<string, unknown> = session, extra: Record<string, unknown> = {}) {
  return Buffer.from(JSON.stringify({ id: 'evt_1', object: 'event', type, created: nowSeconds - 5, livemode: false, data: { object }, ...extra }));
}
function signed(raw: Buffer, { secret = keys.webhookSecret, t = nowSeconds, extra = '' } = {}) {
  const v1 = createHmac('sha256', secret).update(`${t}.${raw.toString('utf8')}`).digest('hex');
  return { 'stripe-signature': `t=${t},${extra}v1=${v1},v0=deadbeef` };
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });
function clock() { vi.useFakeTimers(); vi.setSystemTime(NOW); }

const input = { amountKop: 1999, reference: 'booking-1', destination: 'Корт 1', redirectUrl: 'https://app.test/done', webHookUrl: 'https://api.test/hook', ttlSeconds: 900 };

it('creates a Checkout Session with a form-encoded body and at least 30 minutes of life', async () => {
  clock();
  const fetcher = vi.fn().mockResolvedValue(jsonResponse({ id: 'cs_test_a1', url: 'https://checkout.stripe.com/c/pay/cs_test_a1' }));
  vi.stubGlobal('fetch', fetcher);
  const invoice = await provider().createInvoice(input);
  expect(invoice).toEqual({ providerRef: 'cs_test_a1', pageUrl: 'https://checkout.stripe.com/c/pay/cs_test_a1' });
  const [url, request] = fetcher.mock.calls[0];
  expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
  expect(request.method).toBe('POST');
  expect(request.headers.Authorization).toBe(`Bearer ${keys.secretKey}`);
  expect(request.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  const form = new URLSearchParams(request.body);
  expect(Object.fromEntries(form)).toMatchObject({
    mode: 'payment', 'line_items[0][price_data][currency]': 'uah', 'line_items[0][price_data][unit_amount]': '1999',
    'line_items[0][price_data][product_data][name]': 'Корт 1', 'line_items[0][quantity]': '1',
    success_url: input.redirectUrl, cancel_url: input.redirectUrl, client_reference_id: 'booking-1', locale: 'auto',
  });
  expect(form.has('payment_method_types[0]')).toBe(false);
  // 900 с холду < мінімуму Stripe: сесія живе щонайменше 30 хвилин
  expect(Number(form.get('expires_at')) - nowSeconds).toBeGreaterThanOrEqual(1800);
  expect(request.body).not.toContain(keys.secretKey);
});
it('keeps a longer hold as is', async () => {
  clock();
  const fetcher = vi.fn().mockResolvedValue(jsonResponse({ id: 'cs_test_a1', url: 'https://checkout.stripe.com/x' }));
  vi.stubGlobal('fetch', fetcher);
  await provider().createInvoice({ ...input, ttlSeconds: 3600 });
  expect(Number(new URLSearchParams(fetcher.mock.calls[0][1].body).get('expires_at')) - nowSeconds).toBe(3600);
});
it('does not leak provider errors and rejects invalid input', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'secret internals' } }, 401)));
  await expect(provider().createInvoice(input)).rejects.toThrow(/^Stripe HTTP 401$/);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'cs_test_a1', url: 'http://insecure' })));
  await expect(provider().createInvoice(input)).rejects.toThrow('Invalid Stripe session');
  await expect(provider().createInvoice({ ...input, amountKop: 0 })).rejects.toThrow('Invalid Stripe amount');
  await expect(provider().createInvoice({ ...input, ttlSeconds: 0 })).rejects.toThrow('Invalid Stripe amount');
});

it('accepts a valid signature, any matching v1 and maps the paid session', async () => {
  clock();
  const raw = event('checkout.session.completed');
  expect(await provider().parseWebhook(raw, signed(raw))).toEqual({
    providerRef: 'cs_test_a1', status: 'paid', amountKop: 1999, at: new Date((nowSeconds - 5) * 1000),
  });
  const withOther = signed(raw, { extra: 'v1=0000,' });
  expect((await provider().parseWebhook(raw, withOther)).status).toBe('paid');
});
it('rejects forged, missing, v0-only and stale signatures', async () => {
  clock();
  const raw = event('checkout.session.completed');
  await expect(provider().parseWebhook(raw, signed(raw, { secret: 'whsec_wrongwrongwrong' }))).rejects.toThrow('signature');
  await expect(provider().parseWebhook(raw, {})).rejects.toThrow('signature');
  await expect(provider().parseWebhook(raw, { 'stripe-signature': `t=${nowSeconds},v0=abc` })).rejects.toThrow('signature');
  await expect(provider().parseWebhook(event('checkout.session.completed', { ...session, amount_total: 1 }), signed(raw))).rejects.toThrow('signature');
  await expect(provider().parseWebhook(raw, signed(raw, { t: nowSeconds - 301 }))).rejects.toThrow('signature');
  await expect(provider().parseWebhook(raw, signed(raw, { t: nowSeconds + 301 }))).rejects.toThrow('signature');
  expect((await provider().parseWebhook(raw, signed(raw, { t: nowSeconds - 299 }))).status).toBe('paid');
});
it.each([
  ['checkout.session.completed', { payment_status: 'paid' }, 'paid'],
  ['checkout.session.completed', { payment_status: 'unpaid' }, 'pending'],
  ['checkout.session.async_payment_succeeded', { payment_status: 'paid' }, 'paid'],
  ['checkout.session.async_payment_failed', { payment_status: 'unpaid' }, 'failed'],
  ['checkout.session.expired', { payment_status: 'unpaid' }, 'expired'],
])('maps %s %j to %s', async (type, change, expected) => {
  clock();
  const raw = event(type, { ...session, ...change });
  expect(await provider().parseWebhook(raw, signed(raw))).toMatchObject({ providerRef: 'cs_test_a1', status: expected, amountKop: 1999 });
});
it.each([{ currency: 'usd' }, { amount_total: 0 }, { amount_total: 19.99 }, { id: '' }])('rejects invalid signed session data: %j', async (change) => {
  clock();
  const raw = event('checkout.session.completed', { ...session, ...change });
  await expect(provider().parseWebhook(raw, signed(raw))).rejects.toThrow();
});

const charge = { id: 'ch_1', object: 'charge', currency: 'uah', payment_intent: 'pi_1', refunded: true, amount: 1999, amount_refunded: 1999 };
it('resolves the session for a full refund through the payment intent', async () => {
  clock();
  const fetcher = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'cs_test_a1' }] }));
  vi.stubGlobal('fetch', fetcher);
  const raw = event('charge.refunded', charge);
  expect(await provider().parseWebhook(raw, signed(raw))).toMatchObject({ providerRef: 'cs_test_a1', status: 'refunded', amountKop: 1999 });
  expect(fetcher.mock.calls[0][0]).toBe('https://api.stripe.com/v1/checkout/sessions?payment_intent=pi_1&limit=1');
});
it('does not cancel anything on a partial refund', async () => {
  clock();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'cs_test_a1' }] })));
  const raw = event('charge.refunded', { ...charge, refunded: false, amount_refunded: 500 });
  expect(await provider().parseWebhook(raw, signed(raw))).toMatchObject({ providerRef: 'cs_test_a1', status: 'pending' });
});
it('answers a refund of an unknown payment with an inert pending event', async () => {
  clock();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [] })));
  const raw = event('charge.refunded', charge);
  expect(await provider().parseWebhook(raw, signed(raw))).toMatchObject({ providerRef: 'evt_1', status: 'pending' });
});
it('turns unrelated event types into an inert pending event instead of an error', async () => {
  clock();
  const raw = event('customer.created', { id: 'cus_1' });
  expect(await provider().parseWebhook(raw, signed(raw))).toMatchObject({ providerRef: 'evt_1', status: 'pending' });
});
it('rejects test-mode events in production but not elsewhere', async () => {
  clock();
  const raw = event('checkout.session.completed');
  vi.stubEnv('NODE_ENV', 'production');
  const live = new StripeProvider(JSON.stringify({ ...keys, secretKey: 'sk_live_abcdefghij1234567890' }));
  await expect(live.parseWebhook(raw, signed(raw))).rejects.toThrow('test event');
  vi.stubEnv('NODE_ENV', 'test');
  expect((await provider().parseWebhook(raw, signed(raw))).status).toBe('paid');
});
it('rejects test keys in production', () => {
  vi.stubEnv('NODE_ENV', 'production');
  expect(() => provider()).toThrow('Stripe test keys are disabled in production');
  expect(() => new StripeProvider(JSON.stringify({ ...keys, secretKey: 'sk_live_abcdefghij1234567890' }))).not.toThrow();
});

it('refunds through the payment intent with a stable idempotency key', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ id: 'cs_test_a1', payment_intent: 'pi_1' }))
    .mockResolvedValueOnce(jsonResponse({ id: 're_1', status: 'succeeded' }))
    .mockResolvedValueOnce(jsonResponse({ id: 'cs_test_a1', payment_intent: 'pi_1' }))
    .mockResolvedValueOnce(jsonResponse({ id: 're_1', status: 'pending' }));
  vi.stubGlobal('fetch', fetcher);
  const p = provider();
  await p.refund('cs_test_a1', 1999);
  expect(fetcher.mock.calls[0][0]).toBe('https://api.stripe.com/v1/checkout/sessions/cs_test_a1');
  const [url, request] = fetcher.mock.calls[1];
  expect(url).toBe('https://api.stripe.com/v1/refunds');
  expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({ payment_intent: 'pi_1', amount: '1999' });
  const key = request.headers['Idempotency-Key'];
  expect(key).toMatch(/^cb-refund-[a-f0-9]{40}$/);
  expect(key).toBe(`cb-refund-${createHash('sha256').update('cs_test_a1:1999').digest('hex').slice(0, 40)}`);
  await p.refund('cs_test_a1', 1999);
  expect(fetcher.mock.calls[3][1].headers['Idempotency-Key']).toBe(key);
});
it('rejects failed, canceled and non-2xx refunds', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const p = provider();
  for (const refund of [jsonResponse({ status: 'failed' }), jsonResponse({ status: 'canceled' }), jsonResponse({ error: {} }, 400)]) {
    fetcher.mockResolvedValueOnce(jsonResponse({ payment_intent: 'pi_1' })).mockResolvedValueOnce(refund);
    await expect(p.refund('cs_test_a1', 1999)).rejects.toThrow('Stripe refund rejected');
  }
  fetcher.mockResolvedValueOnce(jsonResponse({ payment_intent: null }));
  await expect(p.refund('cs_test_a1', 1999)).rejects.toThrow('Stripe refund rejected');
  await expect(p.refund('cs_test_a1', 0)).rejects.toThrow('Invalid refund amount');
  await expect(p.refund('../evil', 100)).rejects.toThrow('Invalid refund amount');
});

it('expires an unpaid session', async () => {
  const fetcher = vi.fn().mockResolvedValue(jsonResponse({ id: 'cs_test_a1', status: 'expired' }));
  vi.stubGlobal('fetch', fetcher);
  await provider().cancelUnpaid('cs_test_a1');
  expect(fetcher.mock.calls[0][0]).toBe('https://api.stripe.com/v1/checkout/sessions/cs_test_a1/expire');
  expect(fetcher.mock.calls[0][1].method).toBe('POST');
  await expect(provider().cancelUnpaid('nope')).rejects.toThrow('Invalid Stripe session');
});

it('tests credentials with a read-only list request', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: 'list', data: [] }));
  vi.stubGlobal('fetch', fetcher);
  await provider().testConnection();
  expect(fetcher.mock.calls[0][0]).toBe('https://api.stripe.com/v1/checkout/sessions?limit=1');
  expect(fetcher.mock.calls[0][1].method).toBe('GET');
  fetcher.mockResolvedValue(jsonResponse({ error: { type: 'invalid_request_error' } }, 401));
  await expect(provider().testConnection()).rejects.toThrow('Stripe credential check failed');
});

it('validates credentials', () => {
  expect(stripeKeys(JSON.stringify({ secretKey: ` rk_live_abcdefghij1234 `, webhookSecret: keys.webhookSecret }))).toEqual({
    secretKey: 'rk_live_abcdefghij1234', webhookSecret: keys.webhookSecret,
  });
  for (const change of [
    { secretKey: 'pk_test_abcdefghij1234' }, { secretKey: 'sk_test_short' }, { secretKey: 'sk_prod_abcdefghij1234' },
    { secretKey: 'sk_test_abc def ghij1234' }, { webhookSecret: 'whsec_short' }, { webhookSecret: 'abcdefghij1234567890' },
    { webhookSecret: undefined }, { secretKey: 5 },
  ]) expect(() => stripeKeys(JSON.stringify({ ...keys, ...change }))).toThrow('Invalid Stripe credentials');
  for (const value of ['sk_test_abcdefghij1234567890', 'null', '[]']) expect(() => stripeKeys(value)).toThrow('Invalid Stripe credentials');
});
