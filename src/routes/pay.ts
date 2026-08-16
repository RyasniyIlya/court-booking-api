import { Router } from 'express';
import { prisma } from '../lib/db';
import { providerFor, publicBase } from '../lib/payments';
import { applyPayEvent } from '../lib/payments/apply';

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
    const result = await applyPayEvent(provider.name, event);
    if (result !== 'applied') console.warn('[pay] webhook', event.providerRef, result);
  } catch (e) {
    console.error('[pay] apply failed', e);
    // 500 -> банк повторить. Тут це саме те, що треба.
    return res.status(500).json({ error: 'INTERNAL' });
  }

  res.json({ ok: true });
});

/* ── Заглушка для локальної розробки ──────────────────────────────────────
   Дві кнопки замість сторінки банку. Дьоргає той самий вебхук, що й моно,
   тому перевіряється весь ланцюжок, а не лише редірект.
   На проді провайдер mock вимкнено (див. lib/payments/index.ts).       */

const esc = (s: string) => s.replace(/[<>&"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string));

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
