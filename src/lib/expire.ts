import { prisma } from './db';
import { providerFor } from './payments';

/**
 * Прибирання неоплачених броней.
 *
 * Слот тримається під бронь, поки гравець платить (за замовчуванням
 * 15 хвилин). Якщо не заплатив — бронь стає EXPIRED і час повертається
 * у сітку. Без цього кожна покинута оплата назавжди зʼїдала б слот.
 *
 * Вебхук зазвичай приходить швидше, ніж спрацює прибирання. Ця задача —
 * страховка на випадок, коли гравець просто закрив вкладку і банк узагалі
 * нічого не надішле.
 *
 * expiresAt заповнений ТІЛЬКИ у броней, що чекають оплати. Бронь, яка
 * чекає підтвердження адміністратора, має expiresAt = null і сюди не потрапляє.
 */

const BATCH = 200;

export async function sweepExpired(now = new Date()): Promise<number> {
  const stale = await prisma.booking.findMany({
    where: { status: 'PENDING', expiresAt: { lt: now } },
    include: {
      payment: true,
      club: { select: { paymentProvider: true, paymentTokenEnc: true } },
    },
    take: BATCH,
  });
  if (stale.length === 0) return 0;

  for (const b of stale) {
    try {
      /* updateMany зі статусом у where, а не update по id.
         Між SELECT вище і UPDATE тут минає час, і саме в цю щілину може
         прилетіти вебхук «оплачено»: він переводить бронь у CONFIRMED, а
         ми одразу після нього писали б EXPIRED поверх — гравець заплатив,
         а слот повернувся у сітку. Умова `status: 'PENDING'` робить запис
         холостим, якщо оплата встигла раніше: count = 0, і ми просто
         нічого не чіпаємо. */
      const { count } = await prisma.booking.updateMany({
        where: { id: b.id, status: 'PENDING' },
        data: { status: 'EXPIRED', expiresAt: null },
      });

      if (count === 0) {
        console.log(`[expire] ${b.id} встиг оплатитись — не чіпаємо`);
        continue;
      }

      if (b.payment && b.payment.status === 'PENDING') {
        await prisma.payment.updateMany({
          where: { id: b.payment.id, status: 'PENDING' },
          data: { status: 'EXPIRED', failReason: 'HOLD_TIMEOUT' },
        });
      }

      // Погасити рахунок у банку — по можливості. Якщо не вийшло, нічого
      // страшного: слот уже вільний, а рахунок протухне сам.
      if (b.payment?.status === 'PENDING') {
        const provider = providerFor(b.club);
        if (provider) {
          void provider.cancelUnpaid(b.payment.providerRef)
            .catch((e) => console.warn('[expire] cancelUnpaid', b.payment?.providerRef, e.message));
        }
      }
    } catch (e) {
      // Одна проблемна бронь не має зупиняти прибирання решти
      console.error('[expire] booking', b.id, e);
    }
  }

  console.log(`[expire] звільнено слотів: ${stale.length}`);
  return stale.length;
}

/**
 * Те саме прибирання, але для місць у групових заняттях.
 *
 * Окрема функція, а не гілка в sweepExpired: місце не звільняє корт (його
 * тримає сам контейнер заняття) і не має власного інтервалу — звільняється
 * рівно одиниця місткості. Спільним тут лишається тільки правило: холд, за
 * який не заплатили, віддається назад.
 *
 * Виручку не чіпаємо: PENDING у priceTotal ніколи й не входило (див.
 * lib/payments/apply.ts) — заняття дорожчає в момент оплати, а не запису.
 */
export async function sweepExpiredSeats(now = new Date()): Promise<number> {
  const stale = await prisma.bookingSeat.findMany({
    where: { status: 'PENDING', expiresAt: { lt: now } },
    include: {
      payment: true,
      booking: { select: { club: { select: { paymentProvider: true, paymentTokenEnc: true } } } },
    },
    take: BATCH,
  });
  if (stale.length === 0) return 0;

  for (const s of stale) {
    try {
      /* updateMany зі статусом в умові — з тієї ж причини, що й у броней:
         між SELECT і UPDATE може прилетіти вебхук «оплачено». Умова
         `status: 'PENDING'` робить запис холостим, якщо оплата встигла. */
      const { count } = await prisma.bookingSeat.updateMany({
        where: { id: s.id, status: 'PENDING' },
        data: { status: 'EXPIRED', expiresAt: null },
      });

      if (count === 0) {
        console.log(`[expire] місце ${s.id} встигло оплатитись — не чіпаємо`);
        continue;
      }

      if (s.payment?.status === 'PENDING') {
        await prisma.payment.updateMany({
          where: { id: s.payment.id, status: 'PENDING' },
          data: { status: 'EXPIRED', failReason: 'HOLD_TIMEOUT' },
        });

        const provider = providerFor(s.booking.club);
        if (provider) {
          void provider.cancelUnpaid(s.payment.providerRef)
            .catch((e) => console.warn('[expire] cancelUnpaid', s.payment?.providerRef, e.message));
        }
      }
    } catch (e) {
      // Одне проблемне місце не має зупиняти прибирання решти
      console.error('[expire] seat', s.id, e);
    }
  }

  console.log(`[expire] звільнено місць у групах: ${stale.length}`);
  return stale.length;
}

/** Запускається з index.ts. Хвилини достатньо: холд і так 15 хвилин. */
export function startExpirySweeper(everyMs = 60_000) {
  const tick = () => {
    void sweepExpired().catch((e) => console.error('[expire]', e));
    void sweepExpiredSeats().catch((e) => console.error('[expire seats]', e));
  };
  tick();
  const t = setInterval(tick, everyMs);
  // Не тримати процес живим лише заради таймера
  t.unref?.();
  return t;
}
