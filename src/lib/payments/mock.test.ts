import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockProvider } from './mock';

/**
 * Заглушка банку для локальної розробки.
 *
 * Перевіряти тут майже нічого — крім однієї речі, яка ламається тихо:
 * `refund()` не отримує адреси вебхука (справжньому банку вона не потрібна,
 * він пам'ятає мерчанта сам), тому заглушка мусить запам'ятати її при
 * виставленні рахунку. Якщо ця памʼять зникне, повернення локально буде
 * «проходити» — і мовчки не доходити до бази. Дізнались би про це на
 * першому живому клубі.
 */

const invoice = (p: MockProvider) => p.createInvoice({
  amountKop: 25000,
  reference: 'seat-1',
  destination: 'Клуб: йога',
  redirectUrl: 'https://club.test/back',
  webHookUrl: 'https://api.test/api/pay/webhook/club-1',
  ttlSeconds: 900,
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MockProvider', () => {
  it('повернення шле вебхук на адресу з того ж рахунку', async () => {
    const p = new MockProvider('https://api.test');
    const inv = await invoice(p);

    await p.refund(inv.providerRef, 25000);
    // fetch запускається без await всередині — даємо мікрозадачі проїхати
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.test/api/pay/webhook/club-1');
    expect(JSON.parse(String(init!.body))).toEqual({
      invoiceId: inv.providerRef,
      status: 'reversed',
      amount: 25000,
    });
  });

  /* Рахунок не з цієї памʼяті (перезапуск процесу) — мовчки нічого не
     робимо, а не падаємо: це dev-заглушка, і найгірше, що станеться, —
     повернення доведеться підтвердити руками. */
  it('невідомий рахунок — жодного запиту, жодного винятку', async () => {
    const p = new MockProvider('https://api.test');
    await expect(p.refund('mock_нема_такого', 100)).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('розбирає reversed як повернення', async () => {
    const p = new MockProvider('https://api.test');
    const ev = await p.parseWebhook(
      Buffer.from(JSON.stringify({ invoiceId: 'mock_1', status: 'reversed', amount: 25000 })),
    );
    expect(ev.status).toBe('refunded');
  });

  it('решта статусів не поїхала: success -> paid, failure -> failed', async () => {
    const p = new MockProvider('https://api.test');
    const one = async (status: string) => (await p.parseWebhook(
      Buffer.from(JSON.stringify({ invoiceId: 'mock_1', status })),
    )).status;

    expect(await one('success')).toBe('paid');
    expect(await one('failure')).toBe('failed');
    expect(await one('expired')).toBe('expired');
  });
});
