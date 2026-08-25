import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { providerFor } from '../../lib/payments';
import { requireAuth, requireRole, requireLevel, param } from './shared';

export const refundsRouter = Router();

/**
 * Повернення грошей гравцю.
 *
 * ── Чому це окремий файл і найсуворіші права в кабінеті ──────────────────
 *
 * Це єдина дія в системі, яка ЗАБИРАЄ гроші з рахунку клуба. Усе інше
 * кабінет або показує, або переставляє в нашій базі; тут ми звертаємось до
 * чужого еквайрингу з проханням віддати назад справжні гривні.
 *
 * Тому: тільки OWNER (`requireRole`) і тільки під PIN власника
 * (`requireLevel(3)`) — рівно ті самі права, що й на переприв'язку токена
 * еквайрингу. Модератор веде клуб, але не розпоряджається його рахунком.
 *
 * ── Чому кнопка, а не автоматика при скасуванні ──────────────────────────
 *
 * Спокуса була повертати гроші самим, коли клуб скасовує оплачену бронь.
 * Не робимо: «скасували» і «повертаємо гроші» — різні рішення. Гравець не
 * прийшов за годину до заняття, клуб готував зал і має право лишити оплату
 * собі; або навпаки, клуб сам зачинився на ремонт і повертає все. Правила
 * тут у кожного свої, і вгадувати їх за клуб, розпоряджаючись його
 * рахунком, ми не будемо.
 *
 * Кабінет натомість каже вголос, що на скасованій броні лишились гроші, —
 * і дає кнопку поруч.
 *
 * ── Чому статус не стає REFUNDED одразу ──────────────────────────────────
 *
 * Джерело правди про гроші — вебхук банку, а не факт вдалого HTTP-запиту.
 * Той самий принцип, що й при оплаті: `applyPayEvent` побачить `reversed`
 * і переведе платіж у REFUNDED, а бронь — у CANCELLED. Ми лише фіксуємо
 * `refundRequestedAt`, щоб кабінет показав «повернення в дорозі» і не
 * запропонував натиснути вдруге.
 */

/** Спільна відповідь на «тут нема чого повертати». */
const NOTHING = { error: 'NOTHING_TO_REFUND' };

type Target =
  | { kind: 'booking'; label: string }
  | { kind: 'seat'; label: string };

async function refundPayment(
  paymentId: string,
  clubId: string,
  target: Target,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, clubId },
    include: {
      club: { select: { paymentProvider: true, paymentTokenEnc: true } },
    },
  });
  if (!payment) return { status: 404, body: { error: 'NOT_FOUND' } };

  // Повертати можна тільки те, що дійшло. PENDING сам протухне, FAILED і
  // EXPIRED грошей не забирали, REFUNDED уже повернутий.
  if (payment.status !== 'PAID') {
    return { status: 409, body: { ...NOTHING, paymentStatus: payment.status } };
  }
  if (payment.refundRequestedAt) {
    return {
      status: 409,
      body: { error: 'REFUND_ALREADY_REQUESTED', at: payment.refundRequestedAt.toISOString() },
    };
  }

  const provider = providerFor(payment.club);
  if (!provider) return { status: 409, body: { error: 'PAYMENTS_OFF' } };

  /* Порядок важливий: спершу банк, потім наша позначка. Якщо зробити
     навпаки і банк відмовить, кабінет показував би «повернення в дорозі»
     за грошима, які нікуди не поїхали, — і власник дізнався б про це від
     гравця, а не від нас. */
  try {
    await provider.refund(payment.providerRef, payment.amount);
  } catch (e) {
    console.error(`[refund] банк відмовив по ${payment.providerRef}`, e);
    return { status: 502, body: { error: 'REFUND_FAILED' } };
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: { refundRequestedAt: new Date() },
  });

  console.log(`[refund] запит прийнято: ${target.kind} ${target.label}, ${payment.amount} коп.`);

  return { status: 200, body: { ok: true, amount: payment.amount, requested: true } };
}

/**
 * POST /api/admin/bookings/:id/refund — повернути оплату за бронь корту.
 *
 * LEVEL 3, тільки OWNER.
 */
refundsRouter.post(
  '/bookings/:id/refund',
  requireAuth,
  requireRole('OWNER'),
  requireLevel(3),
  async (req, res) => {
    const id = z.string().uuid().safeParse(param(req, 'id'));
    if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const booking = await prisma.booking.findFirst({
      where: { id: id.data, clubId: req.auth!.clubId },
      select: { id: true, payment: { select: { id: true } } },
    });
    if (!booking) return res.status(404).json({ error: 'NOT_FOUND' });
    if (!booking.payment) return res.status(409).json(NOTHING);

    const out = await refundPayment(
      booking.payment.id,
      req.auth!.clubId,
      { kind: 'booking', label: booking.id },
    );
    res.status(out.status).json(out.body);
  },
);

/**
 * POST /api/admin/seats/:id/refund — повернути оплату за місце в групі.
 *
 * Те саме, але платіж лежить на місці, а не на броні: групове заняття — це
 * одна бронь корту на вісьмох людей, і кожен платив за себе окремо
 * (див. ГРУПОВІ-ЗАНЯТТЯ.md). Повертати заняття цілком нема чого — назад
 * просить конкретна людина.
 */
refundsRouter.post(
  '/seats/:id/refund',
  requireAuth,
  requireRole('OWNER'),
  requireLevel(3),
  async (req, res) => {
    const id = z.string().uuid().safeParse(param(req, 'id'));
    if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const seat = await prisma.bookingSeat.findUnique({
      where: { id: id.data },
      select: {
        id: true,
        booking: { select: { clubId: true } },
        payment: { select: { id: true } },
      },
    });
    // 404, а не 403: чуже місце не має підтверджувати навіть своє існування
    if (!seat || seat.booking.clubId !== req.auth!.clubId) {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }
    if (!seat.payment) return res.status(409).json(NOTHING);

    const out = await refundPayment(
      seat.payment.id,
      req.auth!.clubId,
      { kind: 'seat', label: seat.id },
    );
    res.status(out.status).json(out.body);
  },
);
