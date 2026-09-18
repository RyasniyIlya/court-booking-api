import { totals } from './settlements';

/**
 * Статус приватної броні після зміни її ціни чи статусу руками.
 *
 * Жило всередині PATCH /admin/bookings/:id. Винесено, коли зʼявилась друга
 * дія, що міняє ціну вже створеної броні, — прокат (PUT /bookings/:id/rentals):
 * додана до броні ракетка має міняти статус рівно за тим самим правилом, що
 * й зміна тренера, а не за своїм.
 *
 * Правило:
 *  - онлайн-холд (expiresAt або платіж PENDING) підтверджує тільки провайдер;
 *    руками підтвердити недоплачену таку бронь не можна — PAYMENT_REQUIRED;
 *  - оплачено повністю — CONFIRMED;
 *  - запис з оплатою на місці адміністратор може прийняти до оплати, і
 *    прийнята бронь такою лишається, поки її явно не повернули в PENDING;
 *  - безкоштовна бронь цим правилом не чіпається.
 */
export function paymentStatusPatch(args: {
  booking: {
    status: string;
    expiresAt: Date | null;
    payment: { status: string; amount: number } | null;
    ledgerEntries: { kind: string; amount: number }[];
  };
  finalPrice: number;
  requestedStatus?: 'PENDING' | 'CONFIRMED' | 'CANCELLED';
}): { ok: false; error: 'PAYMENT_REQUIRED' } | { ok: true; data: Record<string, unknown> } {
  const { booking, finalPrice, requestedStatus } = args;
  if (finalPrice <= 0) return { ok: true, data: {} };

  const paid = totals(
    booking.ledgerEntries,
    booking.payment?.status === 'PAID' ? booking.payment.amount : 0,
  ).net;

  const awaitingOnlinePayment = Boolean(booking.expiresAt) || booking.payment?.status === 'PENDING';
  if (requestedStatus === 'CONFIRMED' && paid < finalPrice && awaitingOnlinePayment) {
    return { ok: false, error: 'PAYMENT_REQUIRED' };
  }

  const paidInFull = paid >= finalPrice;
  const manuallyAccepted = !awaitingOnlinePayment &&
    (requestedStatus === 'CONFIRMED' || (requestedStatus !== 'PENDING' && booking.status === 'CONFIRMED'));

  const data: Record<string, unknown> = {
    status: paidInFull || manuallyAccepted ? 'CONFIRMED' : 'PENDING',
    expiresAt: paidInFull ? null : booking.expiresAt,
  };
  if (!paidInFull && !manuallyAccepted) {
    data.confirmedBy = null;
    data.confirmedAt = null;
  }
  return { ok: true, data };
}
