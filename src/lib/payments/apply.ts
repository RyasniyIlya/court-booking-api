import { prisma, notifyClub, isSlotTakenError } from '../db';
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
 */

export type ApplyResult =
  | 'applied' | 'unknown-invoice' | 'stale' | 'already-final' | 'amount-mismatch';

export async function applyPayEvent(provider: string, ev: WebhookEvent): Promise<ApplyResult> {
  const payment = await prisma.payment.findUnique({
    where: { provider_providerRef: { provider, providerRef: ev.providerRef } },
    include: { booking: true, club: { select: { telegramChatId: true, timezone: true } } },
  });
  if (!payment) return 'unknown-invoice';

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

  const b = payment.booking;
  const fmt = (d: Date) => d.toLocaleString('uk-UA', {
    timeZone: payment.club.timezone, day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });

  if (ev.status === 'paid') {
    // Недоплату не приймаємо: у нас 100% передоплата, часткових немає.
    if (typeof ev.amountKop === 'number' && ev.amountKop < payment.amount) {
      console.error(
        `[pay] недоплата по ${payment.providerRef}: прийшло ${ev.amountKop}, чекали ${payment.amount}`,
      );
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', failReason: 'AMOUNT_MISMATCH', providerAt: at },
      });
      return 'amount-mismatch';
    }

    try {
      await prisma.$transaction([
        prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'PAID', paidAt: at, providerAt: at, failReason: null },
        }),
        prisma.booking.update({
          where: { id: payment.bookingId },
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
        `<b>⚠️ Оплата без броні</b>\n${fmt(b.startTime)}\n${b.customerName}, ${b.customerPhone}\n` +
        `${(payment.amount / 100).toFixed(2)} грн\n\n` +
        'Гравець заплатив, але час устигли зайняти, поки йшли гроші. ' +
        'Передзвоніть: запропонуйте інший час або поверніть оплату.',
      );

      // 'applied', а не помилка: подію ми обробили як змогли, і банк
      // не має ганяти цей вебхук по колу.
      return 'applied';
    }

    void notifyClub(
      payment.club.telegramChatId,
      `<b>Оплачено</b>\n${fmt(b.startTime)}\n${b.customerName}, ${b.customerPhone}\n` +
      `${(payment.amount / 100).toFixed(2)} грн`,
    );
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
        where: { id: payment.bookingId },
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
      where: { id: payment.bookingId },
      data: { status: 'CANCELLED', cancelledAt: at },
    }),
  ]);
  return 'applied';
}
