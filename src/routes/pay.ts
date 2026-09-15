import { Router } from 'express';
import { prisma } from '../lib/db';
import { providerFor, publicBase } from '../lib/payments';
import { applyPayEvent } from '../lib/payments/apply';
import { LiqPayProvider } from '../lib/payments/liqpay';
import { randomUUID } from 'node:crypto';

export const payRouter = Router();

/**
 * Роути платіжки.
 *
 * ВАЖЛИВО: цей роутер монтується ДО express.json() і читає сире тіло —
 * підпис вебхука рахується від байтів. Якщо тіло пройде через
 * JSON.parse -> JSON.stringify, підпис не збіжиться (див. src/index.ts).
 */

/**
 * POST /api/pay/webhook/:clubId — сюди стукає банк.
 *
 * clubId у шляху, бо токен і публічний ключ у кожного клубу свої.
 * Це не секрет: підпис усе одно перевіряється, і без нього нічого не станеться.
 *
 * Завжди відповідаємо 200, якщо підпис валідний. Банк робить до трьох
 * спроб — не варто змушувати його повторювати через нашу ж помилку в даних.
 */
payRouter.post('/webhook/:clubId', async (req, res) => {
  const club = await prisma.club.findUnique({
    where: { id: req.params.clubId },
    select: { id: true, paymentProvider: true, paymentTokenEnc: true },
  });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

  const provider = providerFor(club);
  if (!provider) return res.status(404).json({ error: 'PAYMENTS_OFF' });

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));

  let event;
  try {
    event = await provider.parseWebhook(raw, req.headers);
  } catch (e) {
    // Невалідний підпис — це або чужий запит, або збій. 400 без подробиць.
    console.error('[pay] webhook rejected', (e as Error).message);
    return res.status(400).json({ error: 'BAD_WEBHOOK' });
  }

  try {
    const result = await applyPayEvent(provider.name, event, club.id);
    if (result !== 'applied') console.warn('[pay] webhook', event.providerRef, result);
  } catch (e) {
    console.error('[pay] apply failed', e);
    // 500 -> банк повторить. Тут це саме те, що треба.
    return res.status(500).json({ error: 'INTERNAL' });
  }

  res.json({ ok: true });
});

/* ── Куди повертається гравець ───────────────────────────────────────────── */

const esc = (s: string) => s.replace(/[<>&"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string));

payRouter.get('/liqpay/checkout', async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  const { data, signature } = req.query;
  if (typeof data !== 'string' || typeof signature !== 'string' || data.length > 12000) return res.sendStatus(400);
  let orderId;
  try { orderId = JSON.parse(Buffer.from(data, 'base64').toString('utf8')).order_id; }
  catch { return res.sendStatus(400); }
  if (typeof orderId !== 'string' || !/^[a-f0-9-]{36}$/.test(orderId)) return res.sendStatus(400);
  // Untrusted ID is used only to find credentials; nothing is sent to LiqPay
  // before the signature, merchant, and live booking have been checked.
  const payment = await prisma.payment.findUnique({
    where: { provider_providerRef: { provider: 'liqpay', providerRef: orderId } },
    include: { club: true, booking: true, seat: { include: { booking: true } } },
  });
  if (!payment) return res.sendStatus(404);
  const provider = providerFor(payment.club);
  if (!(provider instanceof LiqPayProvider)) return res.sendStatus(409);
  let body;
  try { body = provider.readSigned(data, signature); }
  catch { return res.sendStatus(400); }
  if (body.action !== 'pay' || body.currency !== 'UAH' || Math.round(Number(body.amount) * 100) !== payment.amount || body.order_id !== payment.providerRef) return res.sendStatus(400);
  const target = payment.seat ?? payment.booking;
  const expires = typeof body.expired_date === 'string' ? Date.parse(body.expired_date.replace(' ', 'T') + 'Z') : NaN;
  if (payment.status !== 'PENDING' || !target || target.status !== 'PENDING'
    || !target.expiresAt || target.expiresAt.getTime() <= Date.now()
    || !Number.isFinite(expires) || expires <= Date.now()
    || (payment.seat && ['CANCELLED', 'EXPIRED'].includes(payment.seat.booking.status))) {
    return res.status(410).type('text').send('Ця оплата вже завершена або час бронювання минув. Поверніться до розкладу.');
  }
  const nonce = randomUUID();
  res.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; form-action https://www.liqpay.ua; base-uri 'none'; frame-ancestors 'none'`);
  return res.type('html').send(`<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Оплата LiqPay</title></head><body>
    <p>Переходимо до безпечної оплати LiqPay…</p>
    <form id="checkout" method="POST" action="https://www.liqpay.ua/api/3/checkout" accept-charset="utf-8">
    <input type="hidden" name="data" value="${esc(data)}"><input type="hidden" name="signature" value="${esc(signature)}">
    <button type="submit">Перейти до оплати</button></form>
    <script nonce="${nonce}">document.getElementById('checkout').submit()</script></body></html>`);
});

const page = (title: string, body: string) => `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4F6F4;padding:20px;
      font:15px/1.5 ui-sans-serif,system-ui,sans-serif;color:#101418}
 .c{width:340px;max-width:100%;background:#fff;border:1px solid #E4E7E4;border-radius:16px;padding:24px;text-align:center}
 h1{margin:0 0 8px;font-size:19px;font-weight:650}
 p{margin:0;font-size:14px;color:#6E7671}
 .d{margin:0 0 14px;font-size:13px;color:#6E7671;font-variant-numeric:tabular-nums}
</style></head><body><div class="c">${body}</div></body></html>`;

/**
 * GET /api/pay/done — запасна сторінка повернення з платіжки.
 *
 * Зазвичай банк повертає гравця на сайт клубу: віджет сам підставляє свою
 * адресу в `returnUrl`, ловить `?cbPay=` і показує результат у собі
 * (див. bookingStore.checkReturn). Але `safeReturnUrl` відкидає чужий
 * origin — це захист від відкритого редіректу, — і тоді падає сюди. Досі
 * тут не було нічого: гравець, який щойно заплатив, бачив 404 від Express
 * і не знав, пройшли гроші чи ні.
 *
 * Джерело правди — вебхук, а не факт повернення. Тому статус беремо з бази,
 * а не з параметрів у адресі: підмінити їх у рядку браузера може будь-хто.
 */
payRouter.get('/done', async (req, res) => {
  const bookingToken = String(req.query.cbPay ?? '');
  const seatToken = String(req.query.cbSeat ?? '');
  const uuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

  /* Місце в груповому занятті повертається з ?cbSeat, бронь корту — з
     ?cbPay. Два параметри, а не один: за токеном не видно, що це, а
     шукати спершу в одній таблиці, потім в іншій означало б зайвий
     запит на кожне повернення. */
  const seat = uuid(seatToken)
    ? await prisma.bookingSeat.findUnique({
        where: { cancelToken: seatToken },
        include: {
          booking: {
            select: {
              title: true, startTime: true,
              club: { select: { name: true, phone: true, timezone: true } },
            },
          },
        },
      })
    : null;

  if (seat) {
    const club = seat.booking.club;
    const when = seat.booking.startTime.toLocaleString('uk-UA', {
      timeZone: club.timezone,
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const tel = club.phone
      ? `<p>Питання — <a href="tel:${esc(club.phone)}">${esc(club.phone)}</a></p>`
      : '';

    const text =
      seat.status === 'BOOKED'
        ? '<h1>Оплачено</h1><p>Місце на занятті за вами. Чекаємо вас.</p>'
        : seat.status === 'PENDING'
          ? '<h1>Оплата обробляється</h1><p>Щойно банк підтвердить платіж, місце стане вашим. Зазвичай це кілька секунд.</p>'
          : seat.status === 'EXPIRED'
            ? '<h1>Оплату не завершено</h1><p>Місце повернулось у вільні. Спробуйте записатись ще раз.</p>'
            : '<h1>Запис скасовано</h1><p>Скасування не означає автоматичного повернення грошей. Якщо оплату списано — зверніться до клубу.</p>';

    return res.type('html').send(page(
      'Оплата',
      `${text}<p class="d">${esc(club.name)} · ${esc(seat.booking.title ?? 'заняття')} · ${esc(when)}</p>${tel}`,
    ));
  }

  const booking = uuid(bookingToken)
    ? await prisma.booking.findUnique({
        where: { cancelToken: bookingToken },
        include: { club: { select: { name: true, phone: true, timezone: true } } },
      })
    : null;

  if (!booking) {
    return res.type('html').send(page(
      'Готово',
      '<h1>Готово</h1><p>Цю вкладку можна закрити й повернутись на сайт клубу.</p>',
    ));
  }

  const when = booking.startTime.toLocaleString('uk-UA', {
    timeZone: booking.club.timezone,
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const tel = booking.club.phone
    ? `<p>Питання — <a href="tel:${esc(booking.club.phone)}">${esc(booking.club.phone)}</a></p>`
    : '';

  const text =
    booking.status === 'CONFIRMED'
      ? '<h1>Оплачено</h1><p>Бронь підтверджена. Чекаємо вас.</p>'
      : booking.status === 'PENDING'
        ? '<h1>Оплата обробляється</h1><p>Щойно банк підтвердить платіж, бронь стане підтвердженою. Зазвичай це кілька секунд.</p>'
        : booking.status === 'EXPIRED'
          ? '<h1>Оплату не завершено</h1><p>Час повернувся у сітку. Спробуйте забронювати ще раз.</p>'
          : '<h1>Бронь скасована</h1><p>Скасування не означає автоматичного повернення грошей. Якщо оплату списано — зверніться до клубу.</p>';

  res.type('html').send(page(
    'Оплата',
    `${text}<p class="d">${esc(booking.club.name)} · ${esc(when)}</p>${tel}`,
  ));
});

/* ── Заглушка для локальної розробки ──────────────────────────────────────
   Дві кнопки замість сторінки банку. Дьоргає той самий вебхук, що й моно,
   тому перевіряється весь ланцюжок, а не лише редірект.
   На проді провайдер mock вимкнено (див. lib/payments/index.ts).       */

payRouter.get('/mock/:ref', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).end();

  const { ref } = req.params;
  const amount = Number(req.query.amount ?? 0);
  const back = String(req.query.back ?? '');
  const hook = String(req.query.hook ?? '');
  const what = String(req.query.what ?? 'Бронювання');

  const link = (status: string) =>
    `${publicBase()}/api/pay/mock/${encodeURIComponent(ref)}/complete` +
    `?status=${status}&back=${encodeURIComponent(back)}&hook=${encodeURIComponent(hook)}&amount=${amount}`;

  res.type('html').send(`<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Тестова оплата</title>
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4F6F4;
      font:15px/1.45 ui-sans-serif,system-ui,sans-serif;color:#101418}
 .c{width:340px;background:#fff;border:1px solid #E4E7E4;border-radius:16px;overflow:hidden}
 .t{background:#0E1316;color:#fff;padding:18px 20px}
 .t p{margin:0 0 3px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.5)}
 .t h1{margin:0;font-size:20px;font-weight:650}
 .b{padding:18px 20px 20px}
 .w{font-size:13px;color:#6E7671;margin:0 0 14px}
 a.btn{display:block;text-align:center;padding:12px;border-radius:10px;font-weight:600;
       text-decoration:none;margin-bottom:8px}
 .ok{background:#0F7A5A;color:#fff}
 .no{background:#FCF0ED;color:#8F3624;border:1px solid #F0D6CF}
 .n{font-size:12px;color:#6E7671;margin:12px 0 0}
</style></head><body>
<div class="c">
  <div class="t"><p>Тестова платіжка</p><h1>${(amount / 100).toFixed(2)} грн</h1></div>
  <div class="b">
    <p class="w">${esc(what)}</p>
    <a class="btn ok" href="${esc(link('success'))}">Оплатити</a>
    <a class="btn no" href="${esc(link('failure'))}">Відхилити оплату</a>
    <p class="n">Це заглушка для розробки. Справжніх грошей тут немає.</p>
  </div>
</div></body></html>`);
});

/**
 * Завершення тестової оплати. GET зі спонукою — свідомо: це dev-заглушка,
 * форму заради двох кнопок городити немає сенсу.
 */
payRouter.get('/mock/:ref/complete', async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).end();

  const { ref } = req.params;
  const status = String(req.query.status ?? 'failure');
  const back = String(req.query.back ?? '');
  const hook = String(req.query.hook ?? '');
  const amount = Number(req.query.amount ?? 0);

  if (hook) {
    try {
      await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: ref, status, amount }),
      });
    } catch (e) {
      console.error('[pay] mock hook failed', e);
    }
  }

  if (back) return res.redirect(302, back);
  res.type('html').send('<p>Готово. Можна закрити вкладку.</p>');
});
