import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { MonoProvider } from './mono';
import { PaymentError } from './types';

/**
 * Plata by mono — єдиний провайдер, через який реально підуть гроші клубів.
 *
 * Живого токена в тестах немає й бути не може, тому банк тут — заглушений
 * fetch. Перевіряємо рівно те, що ламається тихо і дорого:
 *
 *  - тіло запиту на виставлення рахунку (сума в копійках, ccy, validity);
 *  - підпис вебхука рахується від СИРИХ байтів — переспарений JSON має
 *    відлітати, інакше хтось зміг би підсунути нам «оплачено»;
 *  - зоопарк статусів mono лягає в наші п'ять;
 *  - помилка банку не витікає гравцю і не тягне за собою токен у лог.
 */

/* Ключі мерчанта у mono — ECDSA. Генеруємо свою пару: підписуємо нею тіло
   вебхука так само, як це робить банк, і віддаємо публічний ключ у base64
   від PEM — рівно у тому вигляді, в якому його віддає /merchant/pubkey. */
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PUBKEY_B64 = Buffer.from(
  publicKey.export({ type: 'spki', format: 'pem' }).toString(),
).toString('base64');

const sign = (raw: Buffer) =>
  createSign('SHA256').update(raw).sign(privateKey).toString('base64');

/* Друга пара — «ключ після ротації». Нею ж підписуємо підробки: для
   старого ключа чужий підпис і підпис зловмисника нерозрізненні. */
const rotated = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const ROTATED_B64 = Buffer.from(
  rotated.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
).toString('base64');

const signRotated = (raw: Buffer) =>
  createSign('SHA256').update(raw).sign(rotated.privateKey).toString('base64');

const pubkeyCalls = (f: { mock: { calls: unknown[][] } }) =>
  f.mock.calls.filter(([u]) => String(u).endsWith('/api/merchant/pubkey'));

/**
 * Керований годинник для перевірки кулдауну.
 *
 * Саме Date.now, а не vi.useFakeTimers(): кулдаун — єдине, що тут залежить
 * від часу, і mono.ts дивиться на годинник рівно через Date.now(). Підміняти
 * заразом усі таймери процесу означало б чіпати те, чого тест не перевіряє.
 */
function clock() {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return { advance: (ms: number) => { now += ms; } };
}

/** Кожен тест бере свій токен: кеш публічного ключа живе на рівні модуля. */
let seq = 0;
const freshToken = () => `test-token-${++seq}`;

type Route = { status?: number; body?: unknown; text?: string };

/**
 * Заглушка банку. routes — по шляху, який викликає провайдер.
 * За замовчуванням /merchant/pubkey віддає наш згенерований ключ.
 */
function stubMono(routes: Record<string, Route> = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    const path = new URL(String(url)).pathname;
    const r = routes[path] ?? (path === '/api/merchant/pubkey'
      ? { body: { key: PUBKEY_B64 } }
      : { body: {} });

    const text = r.text ?? JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status ?? 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const INVOICE_IN = {
  amountKop: 45000,
  reference: 'booking-1',
  destination: 'Клуб Ракетка: Корт 1, 15.08 19:00–20:00',
  redirectUrl: 'https://club.test/back?cbPay=abc',
  webHookUrl: 'https://api.test/api/pay/webhook/club-1',
  ttlSeconds: 900,
};

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('MonoProvider — виставлення рахунку', () => {
  it('шле банку саме те, що ми пообіцяли гравцю', async () => {
    const f = stubMono({
      '/api/merchant/invoice/create': { body: { invoiceId: 'inv_1', pageUrl: 'https://pay.mbnk.biz/inv_1' } },
    });

    const token = freshToken();
    const inv = await new MonoProvider(token).createInvoice(INVOICE_IN);

    expect(inv).toEqual({ providerRef: 'inv_1', pageUrl: 'https://pay.mbnk.biz/inv_1' });

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.monobank.ua/api/merchant/invoice/create');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Token']).toBe(token);

    /* Сума — в копійках і без перерахунків по дорозі: 450 грн має піти
       як 45000, а не 450 і не 4500000. Помилка тут коштує рівно стільки,
       скільки коштує бронь. */
    expect(JSON.parse(String(init.body))).toEqual({
      amount: 45000,
      ccy: 980,
      paymentType: 'debit',
      redirectUrl: INVOICE_IN.redirectUrl,
      webHookUrl: INVOICE_IN.webHookUrl,
      validity: 900,
      merchantPaymInfo: {
        reference: 'booking-1',
        destination: INVOICE_IN.destination,
      },
    });
  });

  /* 200 з порожнім тілом — не «все добре». Без цієї перевірки ми б
     створили Payment із providerRef undefined і відправили гравця
     на pageUrl undefined. */
  it('порожня відповідь банку — це помилка, а не рахунок', async () => {
    stubMono({ '/api/merchant/invoice/create': { body: { invoiceId: 'inv_1' } } });
    await expect(new MonoProvider(freshToken()).createInvoice(INVOICE_IN))
      .rejects.toThrow(PaymentError);
  });

  it('відмова банку не тягне його errText у повідомлення', async () => {
    stubMono({
      '/api/merchant/invoice/create': {
        status: 403,
        text: '{"errCode":"FORBIDDEN","errText":"внутрішні деталі мерчанта"}',
      },
    });

    await expect(new MonoProvider(freshToken()).createInvoice(INVOICE_IN))
      .rejects.toThrow(/mono \/api\/merchant\/invoice\/create -> 403/);
  });

  it('банк недоступний — PaymentError, а не сирий network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    await expect(new MonoProvider(freshToken()).createInvoice(INVOICE_IN))
      .rejects.toThrow('Банк недоступний');
  });

  it('порожній токен не доживає до банку', () => {
    expect(() => new MonoProvider('')).toThrow(PaymentError);
  });
});

describe('MonoProvider — вебхук', () => {
  const hook = (over: Record<string, unknown> = {}) => JSON.stringify({
    invoiceId: 'inv_1',
    status: 'success',
    amount: 45000,
    modifiedDate: '2026-08-30T10:15:00Z',
    ...over,
  });

  it('валідний підпис — подія «оплачено» з сумою і часом банку', async () => {
    stubMono();
    const raw = Buffer.from(hook());

    const ev = await new MonoProvider(freshToken())
      .parseWebhook(raw, { 'x-sign': sign(raw) });

    expect(ev).toEqual({
      providerRef: 'inv_1',
      status: 'paid',
      amountKop: 45000,
      at: new Date('2026-08-30T10:15:00Z'),
      failReason: undefined,
    });
  });

  /**
   * Головний тест файлу.
   *
   * Підпис рахується від байтів. Якщо тіло десь по дорозі пройде через
   * JSON.parse -> JSON.stringify (а це рівно те, що зробить express.json()),
   * байти зміняться — пробіли, порядок ключів — і підпис не збіжиться.
   * Тест ловить саме цей регрес: варто комусь підняти payRouter після
   * express.json(), і всі вебхуки почнуть відлітати з 400.
   */
  it('підпис від переспареного JSON не приймається', async () => {
    stubMono();
    const original = Buffer.from(hook());
    const respared = Buffer.from(JSON.stringify(JSON.parse(original.toString()), null, 2));

    await expect(
      new MonoProvider(freshToken()).parseWebhook(respared, { 'x-sign': sign(original) }),
    ).rejects.toThrow('Підпис вебхука не збігся');
  });

  it('підмінена сума ламає підпис', async () => {
    stubMono();
    const raw = Buffer.from(hook());
    const tampered = Buffer.from(hook({ amount: 1 }));

    await expect(
      new MonoProvider(freshToken()).parseWebhook(tampered, { 'x-sign': sign(raw) }),
    ).rejects.toThrow('Підпис вебхука не збігся');
  });

  it('без заголовка x-sign — відмова до походу за ключем', async () => {
    const f = stubMono();
    await expect(new MonoProvider(freshToken()).parseWebhook(Buffer.from(hook()), {}))
      .rejects.toThrow('Вебхук без підпису');
    expect(f).not.toHaveBeenCalled();
  });

  /* Node віддає заголовок масивом, якщо він прийшов двічі. */
  it('x-sign масивом теж читається', async () => {
    stubMono();
    const raw = Buffer.from(hook());
    const ev = await new MonoProvider(freshToken()).parseWebhook(raw, { 'x-sign': [sign(raw)] });
    expect(ev.status).toBe('paid');
  });

  it('увесь зоопарк статусів mono лягає в наші п’ять', async () => {
    stubMono();
    const p = new MonoProvider(freshToken());
    const one = async (status: string) => {
      const raw = Buffer.from(hook({ status }));
      return (await p.parseWebhook(raw, { 'x-sign': sign(raw) })).status;
    };

    expect(await one('created')).toBe('pending');
    expect(await one('processing')).toBe('pending');
    expect(await one('hold')).toBe('pending');
    expect(await one('success')).toBe('paid');
    expect(await one('failure')).toBe('failed');
    expect(await one('reversed')).toBe('refunded');
    expect(await one('expired')).toBe('expired');
  });

  /* Новий статус у банку — краще гучна помилка і повтор з боку mono,
     ніж мовчазне «pending» на оплаченій броні. */
  it('незнайомий статус — помилка, а не мовчазний pending', async () => {
    stubMono();
    const raw = Buffer.from(hook({ status: 'partially_reversed' }));
    await expect(new MonoProvider(freshToken()).parseWebhook(raw, { 'x-sign': sign(raw) }))
      .rejects.toThrow(/Невідомий статус mono/);
  });

  it('причина відмови доїжджає з failureReason і з errCode', async () => {
    stubMono();
    const p = new MonoProvider(freshToken());

    const a = Buffer.from(hook({ status: 'failure', failureReason: 'Недостатньо коштів' }));
    expect((await p.parseWebhook(a, { 'x-sign': sign(a) })).failReason).toBe('Недостатньо коштів');

    const b = Buffer.from(hook({ status: 'failure', errCode: '4441' }));
    expect((await p.parseWebhook(b, { 'x-sign': sign(b) })).failReason).toBe('4441');
  });

  it('тіло без invoiceId не проходить навіть з валідним підписом', async () => {
    stubMono();
    const raw = Buffer.from(JSON.stringify({ status: 'success' }));
    await expect(new MonoProvider(freshToken()).parseWebhook(raw, { 'x-sign': sign(raw) }))
      .rejects.toThrow(/без invoiceId/);
  });

  it('не-JSON з валідним підписом — PaymentError, а не SyntaxError назовні', async () => {
    stubMono();
    const raw = Buffer.from('не json');
    await expect(new MonoProvider(freshToken()).parseWebhook(raw, { 'x-sign': sign(raw) }))
      .rejects.toThrow('Вебхук не є JSON');
  });

  /* Вебхуки приходять пачками. Ключ мерчанта — раз на годину, не раз на подію. */
  it('публічний ключ береться один раз на токен', async () => {
    const f = stubMono();
    const token = freshToken();
    const raw = Buffer.from(hook());

    await new MonoProvider(token).parseWebhook(raw, { 'x-sign': sign(raw) });
    await new MonoProvider(token).parseWebhook(raw, { 'x-sign': sign(raw) });

    const pubkeyCalls = f.mock.calls.filter(([u]) => String(u).endsWith('/api/merchant/pubkey'));
    expect(pubkeyCalls).toHaveLength(1);
  });

  /* Кеш — по токену, а не глобальний: у кожного клубу свій мерчант, і
     ключ одного клубу не має перевіряти вебхуки іншого. */
  it('у різних клубів ключі не переплутуються', async () => {
    const f = stubMono();
    const raw = Buffer.from(hook());

    await new MonoProvider(freshToken()).parseWebhook(raw, { 'x-sign': sign(raw) });
    await new MonoProvider(freshToken()).parseWebhook(raw, { 'x-sign': sign(raw) });

    const pubkeyCalls = f.mock.calls.filter(([u]) => String(u).endsWith('/api/merchant/pubkey'));
    expect(pubkeyCalls).toHaveLength(2);
  });

  it('банк не віддав ключ — вебхук не приймається', async () => {
    stubMono({ '/api/merchant/pubkey': { body: {} } });
    const raw = Buffer.from(hook());
    await expect(new MonoProvider(freshToken()).parseWebhook(raw, { 'x-sign': sign(raw) }))
      .rejects.toThrow('mono не віддав публічний ключ');
  });
});

describe('MonoProvider — повернення і гасіння', () => {
  it('повернення йде на /invoice/cancel із сумою в копійках', async () => {
    const f = stubMono();
    await new MonoProvider(freshToken()).refund('inv_1', 45000);

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.monobank.ua/api/merchant/invoice/cancel');
    expect(JSON.parse(String(init.body))).toEqual({ invoiceId: 'inv_1', amount: 45000 });
  });

  /* Повернення, яке «пройшло» тільки в нас, — гірше за помилку: адмін
     побачить «гроші повернуто», а гравець їх не отримає. */
  it('відмова банку у поверненні не ковтається', async () => {
    stubMono({ '/api/merchant/invoice/cancel': { status: 400, text: '{"errCode":"BAD"}' } });
    await expect(new MonoProvider(freshToken()).refund('inv_1', 45000))
      .rejects.toThrow(PaymentError);
  });

  it('невикористаний рахунок гаситься через /invoice/remove', async () => {
    const f = stubMono();
    await new MonoProvider(freshToken()).cancelUnpaid('inv_1');

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.monobank.ua/api/merchant/invoice/remove');
    expect(JSON.parse(String(init.body))).toEqual({ invoiceId: 'inv_1' });
  });
});

/**
 * Ротація ключа мерчанта.
 *
 * Два вимоги, які тягнуть у різні боки. Ключ провернувся — треба перечитати
 * його достроково, інакше годину (TTL кеша) ми відбивали б кожен вебхук:
 * гроші списані, броні висять у PENDING, і ніхто цього не бачить. Але роут
 * вебхука публічний і без рейт-ліміту, тож «не збіглось -> йдемо в банк»
 * у лоб перетворює будь-яку підробку на наш запит до mono з токеном клуба.
 * Компроміс — не частіше разу на хвилину; тести стережуть обидві межі.
 */
describe('MonoProvider — ключ мерчанта провернувся', () => {
  const hook = (over: Record<string, unknown> = {}) => JSON.stringify({
    invoiceId: 'inv_1', status: 'success', amount: 45000, ...over,
  });

  it('новий ключ підхоплюється, вебхук приймається', async () => {
    const time = clock();
    const routes: Record<string, Route> = { '/api/merchant/pubkey': { body: { key: PUBKEY_B64 } } };
    const f = stubMono(routes);
    const p = new MonoProvider(freshToken());

    // Перший вебхук зі старим ключем — кладе його в кеш
    const first = Buffer.from(hook());
    await p.parseWebhook(first, { 'x-sign': sign(first) });
    expect(pubkeyCalls(f)).toHaveLength(1);

    // Банк провернув ключ; кулдаун минув
    routes['/api/merchant/pubkey'] = { body: { key: ROTATED_B64 } };
    time.advance(61_000);

    const second = Buffer.from(hook({ invoiceId: 'inv_2' }));
    const ev = await p.parseWebhook(second, { 'x-sign': signRotated(second) });

    expect(ev.providerRef).toBe('inv_2');
    expect(ev.status).toBe('paid');
    expect(pubkeyCalls(f)).toHaveLength(2);
  });

  /* Головна причина, чому тут кулдаун, а не просте перечитування. */
  it('шквал підробок не жене нас у банк за ключем щоразу', async () => {
    const f = stubMono();
    const p = new MonoProvider(freshToken());

    const raw = Buffer.from(hook());
    await p.parseWebhook(raw, { 'x-sign': sign(raw) });
    expect(pubkeyCalls(f)).toHaveLength(1);

    for (let i = 0; i < 5; i++) {
      await expect(p.parseWebhook(raw, { 'x-sign': signRotated(raw) }))
        .rejects.toThrow('Підпис вебхука не збігся');
    }

    expect(pubkeyCalls(f)).toHaveLength(1);
  });

  it('після кулдауну підробка коштує рівно один похід за ключем', async () => {
    const time = clock();
    const f = stubMono();
    const p = new MonoProvider(freshToken());

    const raw = Buffer.from(hook());
    await p.parseWebhook(raw, { 'x-sign': sign(raw) });

    time.advance(61_000);
    await expect(p.parseWebhook(raw, { 'x-sign': signRotated(raw) }))
      .rejects.toThrow('Підпис вебхука не збігся');
    expect(pubkeyCalls(f)).toHaveLength(2);

    // Невдале перечитування перезапускає кулдаун, а не відкриває шлюз
    await expect(p.parseWebhook(raw, { 'x-sign': signRotated(raw) }))
      .rejects.toThrow('Підпис вебхука не збігся');
    expect(pubkeyCalls(f)).toHaveLength(2);
  });

  /* Перший вебхук клуба: ключа в кеші не було, він щойно з банку —
     перечитувати його вдруге безглуздо. */
  it('свіжий ключ не перечитується на тому ж вебхуку', async () => {
    const f = stubMono();
    const raw = Buffer.from(hook());

    await expect(new MonoProvider(freshToken()).parseWebhook(raw, { 'x-sign': signRotated(raw) }))
      .rejects.toThrow('Підпис вебхука не збігся');

    expect(pubkeyCalls(f)).toHaveLength(1);
  });
});
