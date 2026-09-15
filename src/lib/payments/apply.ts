import { prisma, notifyClub, isSlotTakenError } from '../db';
import { notifyBooking } from '../notifyBooking';
import type { WebhookEvent } from './types';

export type ApplyResult = 'applied' | 'unknown-invoice' | 'stale' | 'already-final' | 'amount-mismatch';

/** Lock order: payment -> parent booking -> seat. Re-read all state under locks. */
export async function applyPayEvent(provider: string, ev: WebhookEvent, clubId?: string): Promise<ApplyResult> {
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "provider" = ${provider} AND "providerRef" = ${ev.providerRef} FOR UPDATE`;
    const payment = await tx.payment.findUnique({
      where: { provider_providerRef: { provider, providerRef: ev.providerRef } },
      include: { booking: true, seat: true, club: { select: { telegramChatId: true } } },
    });
    const done = (status: ApplyResult) => ({
      status, notify: null as null | { bookingId: string; seatId?: string },
      lost: null as null | string, chatId: payment?.club.telegramChatId,
    });
    if (!payment || (clubId && payment.clubId !== clubId)) return done('unknown-invoice');
    if (ev.at && payment.providerAt && ev.at < payment.providerAt) return done('stale');
    if (payment.status === 'REFUNDED' || (payment.status === 'PAID' && ev.status !== 'refunded')) return done('already-final');
    const at = ev.at ?? new Date();
    if (ev.status === 'pending') {
      await tx.payment.update({ where: { id: payment.id }, data: { providerAt: at } });
      return done('applied');
    }
    if (ev.status === 'paid' && typeof ev.amountKop === 'number' && ev.amountKop < payment.amount) {
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', failReason: 'AMOUNT_MISMATCH', providerAt: at } });
      return done('amount-mismatch');
    }
    const bookingId = payment.bookingId ?? payment.seat?.bookingId;
    if (!bookingId) return done('unknown-invoice');
    await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId}::uuid FOR UPDATE`;
    const booking = await tx.booking.findUnique({ where: { id: bookingId } });
    if (!booking) return done('unknown-invoice');
    if (payment.seatId) await tx.$queryRaw`SELECT "id" FROM "BookingSeat" WHERE "id" = ${payment.seatId}::uuid FOR UPDATE`;
    const seat = payment.seatId ? await tx.bookingSeat.findUnique({ where: { id: payment.seatId } }) : null;
    const notice = { bookingId, ...(payment.seatId ? { seatId: payment.seatId } : {}) };

    if (ev.status === 'paid') {
      let lost: string | null = null;
      if (payment.seatId) {
        if (!seat) lost = 'SEAT_GONE';
        else if (seat.status === 'CANCELLED') lost = 'SEAT_CANCELLED';
        else if (booking.capacity == null) lost = 'GROUP_GONE';
        else if (['CANCELLED', 'EXPIRED'].includes(booking.status)) lost = 'GROUP_CANCELLED';
        else if (seat.status !== 'BOOKED') {
          const taken = await tx.bookingSeat.count({ where: { bookingId, id: { not: seat.id }, status: { in: ['BOOKED', 'PENDING'] } } });
          if (taken >= booking.capacity) lost = 'GROUP_FULL';
          else {
            await tx.bookingSeat.update({ where: { id: seat.id }, data: { status: 'BOOKED', expiresAt: null } });
            await tx.booking.update({ where: { id: bookingId }, data: { priceTotal: { increment: seat.price } } });
          }
        }
      } else if (booking.status === 'CANCELLED') {
        lost = 'BOOKING_CANCELLED';
      } else {
        // Preserve receipt of real money even if a court/trainer constraint rejects the booking.
        await tx.$executeRawUnsafe('SAVEPOINT payment_confirmation');
        try {
          await tx.booking.update({ where: { id: bookingId }, data: { status: 'CONFIRMED', expiresAt: null } });
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT payment_confirmation');
        } catch (error) {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT payment_confirmation');
          if (!isSlotTakenError(error)) throw error;
          lost = 'SLOT_LOST';
        }
      }
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'PAID', paidAt: at, providerAt: at, failReason: lost } });
      return { ...done('applied'), lost, notify: lost ? null : notice };
    }
    if (ev.status === 'failed' || ev.status === 'expired') {
      await tx.payment.update({ where: { id: payment.id }, data: {
        status: ev.status === 'failed' ? 'FAILED' : 'EXPIRED', providerAt: at, failReason: ev.failReason ?? null,
      } });
      if (payment.seatId) {
        await tx.bookingSeat.updateMany({ where: { id: payment.seatId, status: 'PENDING' }, data: { status: 'EXPIRED', expiresAt: null } });
      } else {
        await tx.booking.updateMany({ where: { id: bookingId, status: 'PENDING' }, data: { status: 'EXPIRED', expiresAt: null } });
      }
      return done('applied');
    }
    await tx.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED', refundedAt: at, providerAt: at } });
    if (payment.seatId) {
      const changed = await tx.bookingSeat.updateMany({ where: { id: payment.seatId, status: 'BOOKED' }, data: { status: 'CANCELLED', cancelledAt: at } });
      if (changed.count && seat) await tx.booking.update({ where: { id: bookingId }, data: { priceTotal: { decrement: seat.price } } });
    } else {
      await tx.booking.update({ where: { id: bookingId }, data: { status: 'CANCELLED', cancelledAt: at } });
    }
    return done('applied');
  }, { timeout: 15000, maxWait: 15000 });
  if (result.notify) void notifyBooking({ ...result.notify, event: 'paid' }).catch(() => console.error('[pay] notification failed'));
  if (result.lost) void notifyClub(result.chatId,
    '⚠️ <b>Оплата без запису</b>\nГроші отримано, але запис скасований або місце зайняте. Перевірте оплати в кабінеті та зв’яжіться з гравцем.');
  return result.status;
}
