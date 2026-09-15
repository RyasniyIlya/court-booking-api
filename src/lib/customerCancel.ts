import { prisma } from './db';
import { notifyBooking } from './notifyBooking';

/**
 * Гравець сам знімає свою бронь корту або місце в груповому занятті.
 *
 * Дві дороги до однієї дії: віджет (за токеном або з кабінету) і кнопка
 * «Скасувати» під нагадуванням у Telegram. Правило строку, сповіщення
 * клубу й повернення виручки мають бути однакові в обох — тому вони тут,
 * а маршрути перевіряють лише одне: чиє це.
 */

export type CancelResult =
  | { ok: true; changed: boolean }
  | { ok: false; status: 400 | 404; code: 'NOT_FOUND' | 'CANCEL_CLOSED' | 'ALREADY_STARTED' };

/**
 * Чи може гравець сам скасувати запис зараз.
 *
 * Одне правило на дві сутності — бронь корту й місце в груповому занятті:
 * для гравця це та сама дія «я не прийду», і різні строки в них він читав
 * би як помилку. cutoff = 0 означає «до самого початку».
 *
 * Адміністратора це не стосується: клуб домовляється голосом і має могти
 * зняти запис навіть за хвилину до початку.
 */
export function canCancelNow(startTime: Date, cutoffMinutes: number): boolean {
  return Date.now() < startTime.getTime() - cutoffMinutes * 60_000;
}

class CancelError extends Error {
  constructor(public status: 400 | 404, public code: 'NOT_FOUND' | 'CANCEL_CLOSED' | 'ALREADY_STARTED') {
    super(code);
  }
}

const closed = (cutoff: number): 'CANCEL_CLOSED' | 'ALREADY_STARTED' =>
  (cutoff > 0 ? 'CANCEL_CLOSED' : 'ALREADY_STARTED');

/**
 * Скасувати бронь корту. Власника перевіряє виклик: за cancelToken у віджеті
 * або за чатом гравця в боті.
 */
export async function cancelBookingByCustomer(bookingId: string): Promise<CancelResult> {
  const result: CancelResult = await prisma.$transaction(async tx => {
  await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId}::uuid FOR UPDATE`;
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    include: { club: { select: { cancelCutoffMinutes: true } } },
  });
  if (!booking) return { ok: false, status: 404, code: 'NOT_FOUND' } as const;
  if (['CANCELLED', 'EXPIRED'].includes(booking.status)) return { ok: true, changed: false } as const;

  const cutoff = booking.club.cancelCutoffMinutes;
  if (!canCancelNow(booking.startTime, cutoff)) {
    return { ok: false, status: 400, code: closed(cutoff) } as const;
  }

  await tx.booking.update({
    where: { id: booking.id },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });

  /* Найважливіше сповіщення з усіх. Гравець знімає бронь сам, за годину
     чи за три дні, і без цього рядка клуб дізнавався про це, лише
     відкривши сітку, а викликаний тренер — приїхавши на заняття,
     якого вже немає. */
  return { ok: true, changed: true } as const;
  });
  if (result.ok && result.changed) void notifyBooking({ bookingId, event: 'cancelled' }).catch(() => console.error('[cancel] notification failed'));
  return result;
}

/**
 * Звільнити місце в груповому занятті.
 *
 * `owns` — перевірка власника всередині транзакції, на вже прочитаному
 * рядку: інакше між «це твоє» і «знімаю» хтось міг би встигнути більше,
 * ніж ми перевірили.
 */
export async function cancelSeatByCustomer(
  seatId: string,
  owns: (seat: { cancelToken: string; customerId: string | null; clubId: string }) => boolean,
): Promise<CancelResult> {
  try {
    /* Транзакція каже, чи справді щось знято: повторний виклик і місце під
       оплатою виходять із неї через `return null` і сповіщення не варті —
       нічого не сталось. */
    const cancelled = await prisma.$transaction(async (tx) => {
      const target = await tx.bookingSeat.findUnique({ where: { id: seatId }, select: { bookingId: true } });
      if (!target) throw new CancelError(404, 'NOT_FOUND');
      await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${target.bookingId}::uuid FOR UPDATE`;
      const seat = await tx.bookingSeat.findUnique({
        where: { id: seatId },
        include: {
          booking: {
            select: {
              id: true,
              startTime: true,
              clubId: true,
              club: { select: { cancelCutoffMinutes: true } },
            },
          },
        },
      });
      if (!seat) throw new CancelError(404, 'NOT_FOUND');

      /* Чиє це місце. Інакше сусід по групі зміг би зняти чужий запис,
         знаючи лише id. */
      if (!owns({ cancelToken: seat.cancelToken, customerId: seat.customerId, clubId: seat.booking.clubId })) {
        throw new CancelError(404, 'NOT_FOUND');
      }

      /* Знімати можна тільки те, що справді за гравцем. Повторний виклик
         не має бути помилкою (гравець міг двічі тицьнути), а місце під
         оплатою чи вже протухле знімати немає з чого: перше відпустить
         вебхук або прибирання, друге вже відпущене. */
      if (seat.status !== 'BOOKED') return null;

      const cutoff = seat.booking.club.cancelCutoffMinutes;
      if (!canCancelNow(seat.booking.startTime, cutoff)) {
        throw new CancelError(400, closed(cutoff));
      }

      const changed = await tx.bookingSeat.updateMany({
        where: { id: seat.id, status: 'BOOKED' },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });

      /* Виручка йде разом із місцем — інакше скасовані записи назавжди
         лишились би в підсумку дня. */
      if (changed.count !== 1) return null;
      await tx.booking.update({
        where: { id: seat.booking.id },
        data: { priceTotal: { decrement: seat.price } },
      });

      return { bookingId: seat.booking.id, seatId: seat.id };
    });

    /* Після коміту, а не всередині: транзакція може відкотитись, і
       повідомлення про зняте місце пішло б у чат раніше, ніж стало
       правдою — а забрати його звідти вже не можна. */
    if (cancelled) {
      void notifyBooking({ ...cancelled, event: 'cancelled' }).catch(() => console.error('[cancel] notification failed'));
    }

    return { ok: true, changed: Boolean(cancelled) };
  } catch (e) {
    if (e instanceof CancelError) return { ok: false, status: e.status, code: e.code };
    throw e;
  }
}
