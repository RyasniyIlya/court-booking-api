import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/db';
import { settlementSchema, settlementSettingsSchema, totals } from '../../lib/settlements';
import { requireAuth, requireStaff, requireRole, param } from './shared';

export const settlementsRouter = Router();
class SettlementError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const fail = (message: string, status = 409): never => { throw new SettlementError(status, message); };

settlementsRouter.get('/settlement-settings', requireAuth, requireStaff, async (req, res) => {
  const club = await prisma.club.findUniqueOrThrow({ where: { id: req.auth!.clubId } });
  res.json(settlementSettingsSchema.parse(club.settlementSettings));
});
settlementsRouter.put('/settlement-settings', requireAuth, requireRole('OWNER'), async (req, res) => {
  const parsed = settlementSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const settings = { ...parsed.data, accounts: [...new Set(parsed.data.accounts)] };
  await prisma.club.update({ where: { id: req.auth!.clubId }, data: { settlementSettings: settings } });
  res.json(settings);
});

// Both private bookings and individual seats use the same accounting rules.
for (const kind of ['bookings', 'seats'] as const) {
  settlementsRouter.get(`/${kind}/:id/settlements`, requireAuth, requireStaff, async (req, res) => {
    const id = z.string().uuid().safeParse(param(req, 'id'));
    if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });
    const clubId = req.auth!.clubId;
    const seat = kind === 'seats' ? await prisma.bookingSeat.findFirst({
      where: { id: id.data, booking: { clubId } }, include: { customer: true, payment: true },
    }) : null;
    const booking = await prisma.booking.findFirst({
      where: { id: kind === 'seats' ? seat?.bookingId ?? id.data : id.data, clubId },
      include: { customer: true, payment: true },
    });
    if (!booking || (kind === 'seats' && !seat)) return res.status(404).json({ error: 'NOT_FOUND' });
    const entries = await prisma.bookingLedgerEntry.findMany({
      where: { clubId, bookingId: booking.id, seatId: seat?.id ?? null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const target = seat ?? booking;
    const payment = target.payment;
    const club = await prisma.club.findUniqueOrThrow({ where: { id: clubId } });
    res.json({ entries, ...totals(entries, payment?.status === 'PAID' ? payment.amount : 0),
      price: seat ? seat.price : booking.priceTotal,
      bonusBalance: target.customer?.bonusBalance ?? 0, customerId: target.customerId,
      settings: settlementSettingsSchema.parse(club.settlementSettings),
      createdBy: booking.createdBy, confirmedBy: booking.confirmedBy, confirmedAt: booking.confirmedAt,
    });
  });

  settlementsRouter.post(`/${kind}/:id/settlements`, requireAuth, requireStaff, async (req, res) => {
    const id = z.string().uuid().safeParse(param(req, 'id'));
    const parsed = settlementSchema.safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
    const d = parsed.data;
    const auth = req.auth!;
    try {
      const entry = await prisma.$transaction(async tx => {
        // One lock per club serializes receipt/refund limits and bonus balance changes.
        // Settings updates also acquire this row lock, so permissions cannot change mid-operation.
        await tx.$queryRaw`SELECT id FROM "Club" WHERE id = ${auth.clubId}::uuid FOR UPDATE`;
        const club = await tx.club.findUniqueOrThrow({ where: { id: auth.clubId } });
        const settings = settlementSettingsSchema.parse(club.settlementSettings);
        const seat = kind === 'seats' ? await tx.bookingSeat.findFirst({
          where: { id: id.data, booking: { clubId: auth.clubId } }, include: { payment: true },
        }) : null;
        const booking = await tx.booking.findFirst({
          where: { id: kind === 'seats' ? seat?.bookingId ?? id.data : id.data, clubId: auth.clubId },
          include: { payment: true },
        });
        if (!booking || (kind === 'seats' && !seat)) return fail('NOT_FOUND', 404);
        if (!seat && booking.capacity !== null) return fail('USE_SEAT_SETTLEMENTS');
        const scope = { clubId: auth.clubId, bookingId: booking.id, seatId: seat?.id ?? null };
        const prior = await tx.bookingLedgerEntry.findUnique({ where: { clubId_requestId: { clubId: auth.clubId, requestId: d.requestId } } });
        if (prior) {
          if (prior.bookingId !== scope.bookingId || prior.seatId !== scope.seatId || prior.kind !== d.kind || prior.method !== d.method || prior.amount !== d.amount || prior.account !== (d.method === 'BONUS' ? 'Бонусний баланс' : d.account) || prior.note !== d.note || prior.originalId !== (d.originalId ?? null)) return fail('IDEMPOTENCY_CONFLICT');
          return prior;
        }
        const target = seat ?? booking;
        const entries = await tx.bookingLedgerEntry.findMany({ where: scope });
        const online = target.payment;
        if (d.method !== 'BONUS' && !settings.accounts.includes(d.account)) return fail('ACCOUNT_REQUIRED', 400);
        if (d.kind === 'PAYMENT') {
          if (['CANCELLED', 'EXPIRED'].includes(target.status) || ['CANCELLED', 'EXPIRED'].includes(booking.status)) return fail('BOOKING_CLOSED');
          if (online?.status === 'PENDING' || online?.refundRequestedAt && online.status === 'PAID') return fail('ONLINE_PAYMENT_PENDING');
          const net = totals(entries, online?.status === 'PAID' ? online.amount : 0).net;
          if (d.amount > (seat ? seat.price : booking.priceTotal) - net) return fail('PAYMENT_EXCEEDS_DUE');
          if (d.originalId) return fail('BAD_REQUEST', 400);
        } else {
          if (auth.role !== 'OWNER' && !settings.moderatorRefunds) return fail('FORBIDDEN', 403);
          if ((d.method === 'CASH' && !settings.cashRefunds) || (['CARD', 'TRANSFER'].includes(d.method) && !settings.bankRefunds) || (d.method === 'BONUS' && !settings.bonusRefunds)) return fail('REFUND_METHOD_DISABLED');
          const original = entries.find(e => e.id === d.originalId && e.kind === 'PAYMENT');
          if (!original) return fail('NOTHING_TO_REFUND');
          if (original.method === 'BONUS' && d.method !== 'BONUS') return fail('BONUS_REFUND_ONLY');
          const refunded = entries.filter(e => e.originalId === original.id && e.kind === 'REFUND').reduce((sum, e) => sum + e.amount, 0);
          if (d.amount > original.amount - refunded) return fail('REFUND_EXCEEDS_PAID');
        }
        if (d.method === 'BONUS') {
          if (!target.customerId) return fail('CUSTOMER_REQUIRED');
          const changed = await tx.customer.updateMany({
            where: { id: target.customerId, clubId: auth.clubId, ...(d.kind === 'PAYMENT' ? { bonusBalance: { gte: d.amount } } : {}) },
            data: { bonusBalance: { increment: d.kind === 'REFUND' ? d.amount : -d.amount } },
          });
          if (changed.count !== 1) return fail('INSUFFICIENT_BONUS');
        }
        const actor = await tx.user.findFirst({ where: { id: auth.userId, clubId: auth.clubId } });
        if (!actor || !['OWNER', 'ADMIN'].includes(actor.role)) return fail('FORBIDDEN', 403);
        const entry = await tx.bookingLedgerEntry.create({ data: {
          ...scope, customerId: target.customerId, requestId: d.requestId, kind: d.kind,
          method: d.method, amount: d.amount, account: d.method === 'BONUS' ? 'Бонусний баланс' : d.account,
          note: d.note, originalId: d.originalId, actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
        } });

        /* Повна фактична оплата і є підтвердженням приватної броні.
           Після часткового повернення вона знову стає непідтвердженою. */
        if (!seat && booking.capacity === null && !['CANCELLED', 'EXPIRED'].includes(booking.status)) {
          const before = totals(entries, online?.status === 'PAID' ? online.amount : 0).net;
          const net = before + (d.kind === 'PAYMENT' ? d.amount : -d.amount);
          const paidInFull = booking.priceTotal === 0 || net >= booking.priceTotal;
          // A partial cash payment does not revoke an administrator's approval.
          if (!paidInFull && d.kind === 'PAYMENT' && booking.status === 'CONFIRMED') return entry;
          await tx.booking.update({
            where: { id: booking.id },
            data: paidInFull
              ? { status: 'CONFIRMED', expiresAt: null, confirmedBy: actor.email, confirmedAt: new Date() }
              : { status: 'PENDING', expiresAt: null, confirmedBy: null, confirmedAt: null },
          });
        }

        return entry;
      });
      res.json(entry);
    } catch (e) {
      if (e instanceof SettlementError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });
}
