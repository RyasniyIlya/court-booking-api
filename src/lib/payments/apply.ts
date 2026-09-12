import { prisma, notifyClub, isSlotTakenError } from '../db';
import { bookingWho } from '../bookingLabel';
import { notifyBooking } from '../notifyBooking';
import type { WebhookEvent } from './types';

/**
 * Єдине місце, де подія від банку перетворюється на зміну в базі.
 * Сюди сходяться і справжній вебхук, і заглушка — щоб не було двох
 * різних правд про те, що означає «оплачено».
 *
 * Три речі, які тут важливі:
 *  1. Ідемпотентність. Провайдер шле повтори — обробка того самого
 *     стану вдруге не має нічого зламати.
 *  2. Порядок. Доставка не впорядкована: подія, старіша за вже збережену,
 *     ігнорується (порівнюємо providerAt).
 *  3. Сума. Якщо прийшло менше, ніж виставили, бронь НЕ підтверджуємо.
 *
 * Платіж веде рівно до одного з двох: приватної броні корту (payment.bookingId)
 * або одного місця в груповому занятті (payment.seatId). За «рівно одне»
 * стежить CHECK payment_booking_or_seat, тому тут достатньо розвилки, а не
 * перевірки «а раптом обидва».
 */

export type ApplyResult =
  | 'applied' | 'unknown-invoice' | 'stale' | 'already-final' | 'amount-mismatch';

/**
 * Платіж разом з усім, що потрібно для рішення: те, за що заплачено
 * (бронь АБО місце із своїм заняттям), і клуб для повідомлення.
 *
 * Окрема функція, а не інлайн у виклику, — щоб з її типу вивелись типи
 * обробників нижче. Дублювати `include` у двох місцях означало б, що
 * одного дня вони розійдуться.
 */
function loadPayment(provider: string, providerRef: string) {
  return prisma.payment.findUnique({
    where: { provider_providerRef: { provider, providerRef } },
    include: {
      booking: true,
      seat: { include: { booking: true } },
      club: { select: { telegramChatId: true, timezone: true } },
    },
  });
}

type LoadedPayment = NonNullable<Awaited<ReturnType<typeof loadPayment>>>;
type LoadedBooking = NonNullable<LoadedPayment['booking']>;
type LoadedSeat = NonNullable<LoadedPayment['seat']>;
type Fmt = (d: Date) => string;
type Hrn = (kop: number) => string;

export async function applyPayEvent(provider: string, ev: WebhookEvent, clubId?: string): Promise<ApplyResult> {
  const payment = await loadPayment(provider, ev.providerRef);
  if (!payment) return 'unknown-invoice';
  if (clubId && payment.clubId !== clubId) return 'unknown-invoice';

  if (ev.at && payment.providerAt && ev.at.getTime() < payment.providerAt.getTime()) {
    return 'stale';
  }
  // PAID і REFUNDED — кінцеві. З PAID можна піти тільки у REFUNDED.
  if (payment.status === 'REFUNDED') return 'already-final';
  if (payment.status === 'PAID' && ev.status !== 'refunded') return 'already-final';

  const at = ev.at ?? new Date();

  if (ev.status === 'pending') {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { providerAt: at },
    });
    return 'applied';
  }

  /* Недоплату не приймаємо: у нас 100% передоплата, часткових немає.
     Правило спільне для броні й для місця — гроші однакові. */
  if (ev.status === 'paid' && typeof ev.amountKop === 'number' && ev.amountKop < payment.amount) {
    console.error(
      `[pay] недоплата по ${payment.providerRef}: прийшло ${ev.amountKop}, чекали ${payment.amount}`,
    );
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'FAILED', failReason: 'AMOUNT_MISMATCH', providerAt: at },
    });
    return 'amount-mismatch';
  }

  const fmt: Fmt = (d) => d.toLocaleString('uk-UA', {
    timeZone: payment.club.timezone, day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const hrn: Hrn = (kop) => `${(kop / 100).toFixed(2)} грн`;

  if (payment.seat) return applyToSeat(payment, payment.seat, ev, at, fmt, hrn);
  if (payment.booking) return applyToBooking(payment, payment.booking, ev, at, fmt, hrn);

  /* Сюди не потрапити, поки живий CHECK payment_booking_or_seat. Але якщо
     таке станеться, краще голосна помилка в логах, ніж тихе 'applied'
     без жодної зміни. */
  console.error(`[pay] платіж ${payment.id} не веде ні до броні, ні до місця`);
  return 'unknown-invoice';
}

/* -------------------------------------------------------------------------- */
/* Приватна бронь корту                                                       */
/* -------------------------------------------------------------------------- */

async function applyToBooking(
  payment: LoadedPayment, b: LoadedBooking, ev: WebhookEvent, at: Date, fmt: Fmt, hrn: Hrn,
): Promise<ApplyResult> {
  if (ev.status === 'paid') {
    try {
      await prisma.$transaction([
        prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'PAID', paidAt: at, providerAt: at, failReason: null },
        }),
        prisma.booking.update({
          where: { id: b.id },
          // expiresAt знімаємо: бронь більше не протухає
          data: { status: 'CONFIRMED', expiresAt: null },
        }),
      ]);
    } catch (e) {
      /* Слот уже зайняли, поки гроші йшли.
       *
       * Як сюди можна потрапити. Гравець платить на останній хвилині холду,
       * прибирання (lib/expire.ts) встигає першим і переводить бронь у
       * EXPIRED — слот повертається у сітку, і його займає хтось інший.
       * Аж тоді долітає вебхук «оплачено» і намагається повернути нашу
       * бронь у CONFIRMED. Констрейнт booking_no_overlap цього не дозволяє
       * (EXPIRED час не займає, CONFIRMED — займає) і кидає 23P01.
       *
       * Раніше виняток летів нагору, роут віддавав 500, банк повторював
       * вебхук — і так по колу. Гроші при цьому списані, броні немає, і
       * ніхто про це не дізнавався: у логах лежав стек, а клуб бачив
       * звичайний вільний слот.
       *
       * Автоматичного повернення тут свідомо немає: гроші пішли на рахунок
       * клубу повз нас, і рішення про повернення — його. Наша справа —
       * зафіксувати оплату (щоб вона не загубилась у звітності) і сказати
       * про це вголос, поки ще можна передзвонити гравцю. Статус броні
       * лишається EXPIRED: вигадувати їй місце в сітці, де вже хтось грає,
       * ми не маємо права.
       */
      if (!isSlotTakenError(e)) throw e;

      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'PAID', paidAt: at, providerAt: at, failReason: 'SLOT_LOST' },
      });

      console.error(`[pay] оплата ${payment.providerRef} прийшла на вже зайнятий слот, бронь ${b.id}`);

      void notifyClub(
        payment.club.telegramChatId,
        `<b>⚠️ Оплата без броні</b>\n${fmt(b.startTime)}\n${bookingWho(b)}\n` +
        `${hrn(payment.amount)}\n\n` +
        'Гравець заплатив, але час устигли зайняти, поки йшли гроші. ' +
        'Передзвоніть: запропонуйте інший час або поверніть оплату.',
      );

      // 'applied', а не помилка: подію ми обробили як змогли, і банк
      // не має ганяти цей вебхук по колу.
      return 'applied';
    }

    /* Тут і тільки тут дізнається про передоплачену бронь той, кого вона
       стосується. Раніше це повідомлення йшло рівно в клубну групу, а
       тренер не отримував нічого: гілка з платіжкою в public.ts робить
       return до блоку сповіщень, тож викликаного тренера не повідомляв
       НІХТО — ні при створенні, ні при оплаті. */
    void notifyBooking({ bookingId: b.id, event: 'paid' });
    return 'applied';
  }

  if (ev.status === 'failed' || ev.status === 'expired') {
    await prisma.$transaction([
      prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: ev.status === 'failed' ? 'FAILED' : 'EXPIRED',
          providerAt: at,
          failReason: ev.failReason ?? null,
        },
      }),
      // EXPIRED звільняє слот — EXCLUDE-констрейнт його не рахує
      prisma.booking.update({
        where: { id: b.id },
        data: { status: 'EXPIRED', expiresAt: null },
      }),
    ]);
    return 'applied';
  }

  // refunded
  await prisma.$transaction([
    prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'REFUNDED', refundedAt: at, providerAt: at },
    }),
    prisma.booking.update({
      where: { id: b.id },
      data: { status: 'CANCELLED', cancelledAt: at },
    }),
  ]);
  return 'applied';
}

/* -------------------------------------------------------------------------- */
/* Місце в груповому занятті                                                  */
/* -------------------------------------------------------------------------- */

/**
 * У місця свій аналог «слот уже зайняли»: поки гравець платив, його PENDING
 * устигло протухнути, і останнє місце пішло іншому. Констрейнта, який
 * упіймав би це сам, тут немає — місткість декларативно в Postgres не
 * виражається, — тому перерахунок робиться руками під тим самим FOR UPDATE,
 * що й запис у групу (див. routes/public.ts).
 *
 * Виручка заняття росте саме тут, при оплаті, а не при створенні PENDING:
 * покинутий кошик не має підіймати підсумок дня на чверть години.
 */
async function applyToSeat(
  payment: LoadedPayment, seat: LoadedSeat, ev: WebhookEvent, at: Date, fmt: Fmt, hrn: Hrn,
): Promise<ApplyResult> {
  const g = seat.booking;
  const who = `${seat.customerName}, ${seat.customerPhone}`;
  const what = g.title || 'Групове заняття';

  if (ev.status === 'paid') {
    const lost = await prisma.$transaction(async (tx) => {
      /* Той самий замок, що й у записі: рахувати вільні місця можна лише
         тоді, коли ніхто паралельно не займає останнє. */
      const rows = await tx.$queryRaw<{ capacity: number | null; status: string }[]>`
        SELECT "capacity", "status"::text FROM "Booking"
         WHERE "id" = ${g.id}::uuid FOR UPDATE`;
      const row = rows[0];

      const fresh = await tx.bookingSeat.findUnique({
        where: { id: seat.id },
        select: { status: true, price: true },
      });
      if (!fresh) return 'SEAT_GONE';

      // Повтор вебхука по вже проведеному місцю — нічого не робимо.
      if (fresh.status === 'BOOKED') return null;
      // Гравець устиг зняти запис сам, поки йшли гроші.
      if (fresh.status === 'CANCELLED') return 'SEAT_CANCELLED';

      // Заняття скасував клуб.
      if (!row || row.capacity == null) return 'GROUP_GONE';
      if (row.status === 'CANCELLED' || row.status === 'EXPIRED') return 'GROUP_CANCELLED';

      /* PENDING усе ще тримає місткість — перераховувати нічого. А от
         EXPIRED її вже відпустив, і повертати місце можна тільки якщо
         воно досі вільне. */
      if (fresh.status === 'EXPIRED') {
        const taken = await tx.bookingSeat.count({
          where: { bookingId: g.id, status: { in: ['BOOKED', 'PENDING'] } },
        });
        if (taken >= row.capacity) return 'GROUP_FULL';
      }

      await tx.bookingSeat.update({
        where: { id: seat.id },
        data: { status: 'BOOKED', expiresAt: null },
      });
      await tx.booking.update({
        where: { id: g.id },
        data: { priceTotal: { increment: fresh.price } },
      });
      return null;
    });

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'PAID', paidAt: at, providerAt: at, failReason: lost ?? null },
    });

    if (lost) {
      console.error(`[pay] оплата ${payment.providerRef} прийшла на місце ${seat.id}: ${lost}`);
      void notifyClub(
        payment.club.telegramChatId,
        `<b>⚠️ Оплата без місця</b>\n${what}\n${fmt(g.startTime)}\n${who}\n` +
        `${hrn(payment.amount)}\n\n` +
        'Гроші прийшли, але місця в занятті вже немає. ' +
        'Передзвоніть: запропонуйте інше заняття або поверніть оплату.',
      );
      // 'applied': подію ми обробили як змогли, ганяти вебхук по колу нема сенсу.
      return 'applied';
    }

    void notifyBooking({ bookingId: g.id, seatId: seat.id, event: 'paid' });
    return 'applied';
  }

  if (ev.status === 'failed' || ev.status === 'expired') {
    await prisma.$transaction([
      prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: ev.status === 'failed' ? 'FAILED' : 'EXPIRED',
          providerAt: at,
          failReason: ev.failReason ?? null,
        },
      }),
      /* updateMany зі статусом в умові, а не update по id: місце могло вже
         стати BOOKED (вебхук «оплачено» прилетів раніше за «не вдалось» —
         порядок доставки не гарантований), і затирати оплачене місце
         протухлим ми не маємо права. */
      prisma.bookingSeat.updateMany({
        where: { id: seat.id, status: 'PENDING' },
        data: { status: 'EXPIRED', expiresAt: null },
      }),
    ]);
    return 'applied';
  }

  // refunded
  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'REFUNDED', refundedAt: at, providerAt: at },
    });
    const { count } = await tx.bookingSeat.updateMany({
      where: { id: seat.id, status: 'BOOKED' },
      data: { status: 'CANCELLED', cancelledAt: at },
    });
    // Виручка йде разом із місцем — але тільки якщо воно в неї входило.
    if (count > 0) {
      await tx.booking.update({
        where: { id: g.id },
        data: { priceTotal: { decrement: seat.price } },
      });
    }
  });
  return 'applied';
}
