import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';

/**
 * Приймальна перевірка онлайн-оплати клубу — через справжній HTTP-API,
 * справжні ключі клубу й справжню БД тестового клубу.
 *
 *   PAYCHECK_CONFIRMED=yes          — підтвердження, що це ТЕСТОВИЙ клуб і тестова БД
 *   PAYCHECK_API_URL                — адреса API (типово http://localhost:3000)
 *   PAYCHECK_CLUB_SLUG              — slug тестового клубу з увімкненою передоплатою
 *   PAYCHECK_PROVIDER               — liqpay | wayforpay | mono
 *   PAYCHECK_CREDENTIALS            — ті самі ключі, що введені в кабінеті клубу:
 *                                     liqpay    {"publicKey":"…","privateKey":"…"}
 *                                     wayforpay {"merchantAccount":"…","secretKey":"…","domain":"…"}
 *                                     mono      токен рядком
 *   PAYCHECK_REAL=1                 — режим із живими грошами (людина платить карткою, скрипт повертає)
 *
 * Режим за замовчуванням (без грошей) для liqpay/wayforpay підписує вебхуки справжніми
 * ключами клубу — перевіряє весь ланцюг «рахунок → вебхук → бронь» без банку.
 * mono підписує вебхуки банківським RSA-ключем, тож для нього є лише PAYCHECK_REAL=1.
 *
 * Sandbox-ключі LiqPay та тестовий мерчант WayForPay API відхиляє на NODE_ENV=production
 * (так задумано). Перевіряти ними треба локально або на staging, не на проді.
 */

type Kind = 'liqpay' | 'wayforpay' | 'mono';

async function main() {
  assert.equal(process.env.PAYCHECK_CONFIRMED, 'yes', 'Підтвердіть, що ціль це тестовий клуб і тестова БД (PAYCHECK_CONFIRMED=yes)');
  const api = (process.env.PAYCHECK_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  const slug = process.env.PAYCHECK_CLUB_SLUG;
  const kind = process.env.PAYCHECK_PROVIDER as Kind;
  const credentials = process.env.PAYCHECK_CREDENTIALS ?? '';
  const real = process.env.PAYCHECK_REAL === '1';
  assert(slug, 'Задайте PAYCHECK_CLUB_SLUG');
  assert(['liqpay', 'wayforpay', 'mono'].includes(kind), 'PAYCHECK_PROVIDER = liqpay | wayforpay | mono');
  assert(credentials, 'Задайте PAYCHECK_CREDENTIALS');
  assert(real || kind !== 'mono', 'mono без грошей перевірити не можна: вебхук підписує банк. Запустіть із PAYCHECK_REAL=1');

  const { prisma } = await import('../src/lib/db');
  const provider = await (async () => {
    if (kind === 'liqpay') return new (await import('../src/lib/payments/liqpay')).LiqPayProvider(credentials, api);
    if (kind === 'wayforpay') return new (await import('../src/lib/payments/wayforpay')).WayForPayProvider(credentials, api);
    return new (await import('../src/lib/payments/mono')).MonoProvider(credentials);
  })();

  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true, name: true, paymentProvider: true, prepayEnabled: true } });
  assert(club, `Клуб ${slug} не знайдено в БД`);
  assert.equal(club.paymentProvider, kind, `У клубу в кабінеті обрано "${club.paymentProvider}", а перевіряємо ${kind}`);
  assert(club.prepayEnabled, 'У клубу вимкнено передоплату (prepayEnabled)');

  const created: string[] = [];
  let passed = 0;
  let step = 0;
  const check = async (label: string, fn: () => Promise<void>) => {
    await fn(); passed++; console.log(`PASS ${label}`);
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ── допоміжні виклики ────────────────────────────────────────────────
  const json = async (path: string, init?: RequestInit) => {
    const r = await fetch(`${api}${path}`, init);
    const text = await r.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* не JSON */ }
    return { status: r.status, body, text };
  };

  type Slot = { courtId: string; start: string; end: string; pricePerHour: number };
  const freeSlots = async (need: number): Promise<Slot[]> => {
    const found: Slot[] = [];
    for (let d = 2; d <= 13 && found.length < need; d++) {
      const date = new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
      const r = await json(`/api/public/clubs/${slug}/availability?date=${date}`);
      if (r.status !== 200) continue;
      for (const c of (r.body.courts ?? []) as any[]) {
        const free = (c.slots as any[]).filter((s) => s.available && !s.group);
        // З кінця дня: менше шансів зачепити живого гравця, якщо клуб не зовсім порожній.
        for (const s of free.reverse()) {
          if (found.length < need && !found.some((f) => f.start === s.start)) {
            found.push({ courtId: c.courtId, start: s.start, end: s.end, pricePerHour: c.pricePerHour });
          }
        }
      }
    }
    assert(found.length >= need, `Потрібно ${need} вільних слотів у найближчі 2 тижні, знайдено ${found.length}. Додайте години роботи тестовому клубу.`);
    return found;
  };

  const book = async (slot: Slot) => {
    const phone = `+38050${String(1000000 + (++step))}`;
    const r = await json(`/api/public/clubs/${slug}/bookings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courtId: slot.courtId, start: slot.start, end: slot.end,
        customerName: 'PAYCHECK Test', customerPhone: phone, birthDate: '1990-01-15',
        payChoice: 'online', acceptedTerms: true,
      }),
    });
    assert.equal(r.status, 201, `Створення броні: ${r.status} ${r.text.slice(0, 200)}`);
    assert(!r.body.payUnavailable, 'Банк не видав рахунок (payUnavailable): ключі, домен або PUBLIC_API_URL налаштовані неправильно');
    assert(r.body.payUrl, 'У відповіді немає payUrl: у клубу не ввімкнено онлайн-оплату для цієї броні');
    created.push(r.body.id);
    const payment = await prisma.payment.findUnique({ where: { bookingId: r.body.id } });
    assert(payment, 'Платіж у БД не створено');
    return { id: r.body.id as string, token: r.body.cancelToken as string, payUrl: r.body.payUrl as string, payment, amountKop: r.body.priceTotal as number };
  };

  const status = async (token: string) => (await json(`/api/public/bookings/${token}/status`)).body as { status: string; paymentStatus: string | null };

  // ── підписані вебхуки (без банку), лише liqpay / wayforpay ──────────
  let tick = Date.now();
  const webhook = async (opts: { ref: string; amountKop: number; state: 'paid' | 'failed' | 'refunded'; forge?: boolean; clubId?: string }) => {
    const at = (tick += 5000);
    const url = `/api/pay/webhook/${opts.clubId ?? club.id}`;
    if (kind === 'liqpay') {
      const keys = JSON.parse(credentials);
      const payload = {
        version: 7, public_key: keys.publicKey, action: 'pay', order_id: opts.ref,
        amount: (opts.amountKop / 100).toFixed(2), currency: 'UAH', end_date: at,
        status: { paid: 'success', failed: 'failure', refunded: 'reversed' }[opts.state],
      };
      const data = Buffer.from(JSON.stringify(payload)).toString('base64');
      const signature = createHash('sha3-256').update(keys.privateKey + data + keys.privateKey).digest('base64');
      return fetch(`${api}${url}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data, signature: opts.forge ? signature.split('').reverse().join('') : signature }).toString(),
      });
    }
    const keys = JSON.parse(credentials);
    const amount = opts.amountKop / 100;
    const body: Record<string, unknown> = {
      merchantAccount: keys.merchantAccount, orderReference: opts.ref, amount, currency: 'UAH',
      authCode: '123456', cardPan: '41****1111', reasonCode: 1100, reason: 'Ok', processingDate: Math.floor(at / 1000),
      transactionStatus: { paid: 'Approved', failed: 'Declined', refunded: 'Refunded' }[opts.state],
    };
    const sign = [body.merchantAccount, body.orderReference, String(amount), body.currency, body.authCode, body.cardPan, body.transactionStatus, body.reasonCode].join(';');
    const signature = createHmac('md5', keys.secretKey).update(sign, 'utf8').digest('hex');
    return fetch(`${api}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, merchantSignature: opts.forge ? 'f'.repeat(32) : signature }),
    });
  };

  try {
    // ── 0. Передумови ────────────────────────────────────────────────
    await check('API відповідає, клуб публічно видно', async () => {
      const r = await json(`/api/public/clubs/${slug}`);
      assert.equal(r.status, 200, `GET клуб: ${r.status}`);
    });
    await check('PUBLIC_API_URL публічний HTTPS (банк має куди слати вебхуки)', async () => {
      const u = new URL(process.env.PUBLIC_API_URL ?? '');
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if (!real && local) { console.log('  (локально: вебхуки імітуємо самі, це нормально)'); return; }
      assert(u.protocol === 'https:' && !local, `PUBLIC_API_URL=${process.env.PUBLIC_API_URL}: банк не достукається`);
    });
    if (provider.testConnection) {
      await check(`${kind}: ключі приймає сам банк (testConnection)`, () => provider.testConnection!());
    }

    // ── Живі гроші: людина платить, скрипт повертає ──────────────────
    if (real) {
      const [slot] = await freeSlots(1);
      const b = await book(slot);
      await check('рахунок створено у банку, сторінка оплати відкривається', async () => {
        const r = await fetch(b.payUrl);
        assert.equal(r.status, 200);
        if (kind === 'mono') assert(new URL(b.payUrl).hostname.endsWith('monobank.ua'), `Чужий домен оплати: ${b.payUrl}`);
        assert(!(await r.text()).includes(credentials.slice(0, 20)), 'Сторінка оплати світить ключ');
      });
      console.log(`\n>>> ОПЛАТІТЬ СВОЄЮ КАРТКОЮ (${(b.amountKop / 100).toFixed(2)} грн): ${b.payUrl}\n>>> Чекаю до 10 хвилин…`);
      await check('вебхук банку підтвердив бронь без участі браузера', async () => {
        const deadline = Date.now() + 10 * 60_000;
        for (;;) {
          const s = await status(b.token);
          if (s.status === 'CONFIRMED' && s.paymentStatus === 'PAID') return;
          assert(Date.now() < deadline, `Не дочекались оплати (status=${s.status}, payment=${s.paymentStatus}). Вебхук не дійшов? Перевірте PUBLIC_API_URL і логи API.`);
          await sleep(3000);
        }
      });
      await check('сума в БД збігається з рахунком', async () => {
        const p = await prisma.payment.findUniqueOrThrow({ where: { id: b.payment.id } });
        assert.equal(p.amount, b.amountKop); assert(p.paidAt);
      });
      await check('повернення коштів проходить і доходить вебхуком', async () => {
        await provider.refund(b.payment.providerRef, b.amountKop);
        const deadline = Date.now() + 5 * 60_000;
        for (;;) {
          const p = await prisma.payment.findUniqueOrThrow({ where: { id: b.payment.id } });
          if (p.status === 'REFUNDED') return;
          assert(Date.now() < deadline, `Повернення не підтверджено вебхуком (status=${p.status}). Деякі банки повертають із затримкою — перевірте в кабінеті банку.`);
          await sleep(3000);
        }
      });
      created.length = 0; // реальні гроші: записи лишаємо як облікові, не чистимо
      console.log(`\nГотово: ${passed} перевірок. Запис броні ${b.id} лишено як обліковий.`);
      return;
    }

    // ── Без грошей: справжній банк для рахунку, підписані вебхуки ────
    const [slotA, slotB] = await freeSlots(2);
    const a = await book(slotA);
    await check('рахунок створено, сторінка оплати відкривається і не світить ключ', async () => {
      const r = await fetch(a.payUrl);
      assert.equal(r.status, 200);
      const html = await r.text();
      const secret = kind === 'liqpay' ? JSON.parse(credentials).privateKey : JSON.parse(credentials).secretKey;
      assert(!html.includes(secret), 'Приватний ключ потрапив у HTML сторінки оплати');
    });
    await check('нова бронь PENDING, оплата PENDING', async () => {
      const s = await status(a.token);
      assert.equal(s.status, 'PENDING'); assert.equal(s.paymentStatus, 'PENDING');
    });
    await check('підроблений підпис вебхука відхилено (400), бронь не змінилась', async () => {
      const r = await webhook({ ref: a.payment.providerRef, amountKop: a.amountKop, state: 'paid', forge: true });
      assert.equal(r.status, 400);
      assert.equal((await status(a.token)).status, 'PENDING');
    });
    await check('вебхук для невідомого рахунку не чіпає бронь', async () => {
      await webhook({ ref: randomUUID(), amountKop: a.amountKop, state: 'paid' });
      assert.equal((await status(a.token)).status, 'PENDING');
    });

    const b = await book(slotB);
    await check('недоплата (на 1 коп менше) не підтверджує бронь', async () => {
      await webhook({ ref: b.payment.providerRef, amountKop: Math.max(1, b.amountKop - 1), state: 'paid' });
      const s = await status(b.token);
      assert.notEqual(s.status, 'CONFIRMED');
      const p = await prisma.payment.findUniqueOrThrow({ where: { id: b.payment.id } });
      assert.equal(p.status, 'FAILED'); assert.equal(p.failReason, 'AMOUNT_MISMATCH');
    });

    await check('повна оплата: бронь CONFIRMED, платіж PAID', async () => {
      const r = await webhook({ ref: a.payment.providerRef, amountKop: a.amountKop, state: 'paid' });
      assert.equal(r.status, 200);
      const s = await status(a.token);
      assert.equal(s.status, 'CONFIRMED'); assert.equal(s.paymentStatus, 'PAID');
    });
    await check('повтор того самого вебхука нічого не ламає (ідемпотентність)', async () => {
      const before = await prisma.payment.findUniqueOrThrow({ where: { id: a.payment.id } });
      const r = await webhook({ ref: a.payment.providerRef, amountKop: a.amountKop, state: 'paid' });
      assert.equal(r.status, 200);
      const after = await prisma.payment.findUniqueOrThrow({ where: { id: a.payment.id } });
      assert.equal(after.status, 'PAID'); assert.equal(+after.paidAt!, +before.paidAt!);
    });
    await check('запізнілий failed після оплати не скасовує оплачену бронь', async () => {
      await webhook({ ref: a.payment.providerRef, amountKop: a.amountKop, state: 'failed' });
      const s = await status(a.token);
      assert.equal(s.status, 'CONFIRMED'); assert.equal(s.paymentStatus, 'PAID');
    });
    await check('повернення: бронь CANCELLED, платіж REFUNDED', async () => {
      await webhook({ ref: a.payment.providerRef, amountKop: a.amountKop, state: 'refunded' });
      const s = await status(a.token);
      assert.equal(s.status, 'CANCELLED'); assert.equal(s.paymentStatus, 'REFUNDED');
    });

    console.log(`\nГотово: ${passed} перевірок пройдено.`);
    console.log('Це перевірка коду й ключів. Живі гроші: PAYCHECK_REAL=1 (див. docs/payments-go-live.md).');
  } finally {
    if (created.length) {
      await prisma.payment.deleteMany({ where: { bookingId: { in: created } } }).catch(() => {});
      await prisma.booking.deleteMany({ where: { id: { in: created } } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error('FAIL', e instanceof Error ? e.message : e); process.exit(1); });
