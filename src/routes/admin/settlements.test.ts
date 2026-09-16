import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const prisma = {
  $transaction: vi.fn(), $queryRaw: vi.fn(),
  club: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
  booking: { findFirst: vi.fn(), update: vi.fn() }, bookingSeat: { findFirst: vi.fn() },
  bookingLedgerEntry: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  customer: { updateMany: vi.fn() }, user: { findFirst: vi.fn(), findUnique: vi.fn() },
};
vi.mock('../../lib/db', () => ({ prisma }));
const { settlementsRouter } = await import('./settlements');
const { signToken } = await import('./shared');
const app = express().use(express.json()).use(settlementsRouter);
const id = '11111111-1111-4111-8111-111111111111';
const clubId = '22222222-2222-4222-8222-222222222222';
const customerId = '33333333-3333-4333-8333-333333333333';
const userId = '44444444-4444-4444-8444-444444444444';
const originalId = '55555555-5555-4555-8555-555555555555';
const requestId = '66666666-6666-4666-8666-666666666666';
const auth = (role = 'ADMIN') => {
  prisma.user.findUnique.mockResolvedValue({ id: userId, clubId, role, trainerId: null, passwordHash: 'test-hash' });
  return `Bearer ${signToken({ userId, clubId, role, trainerId: null }, '1h', 'test-hash')}`;
};
const payment = { requestId, kind: 'PAYMENT', method: 'CASH', amount: 15000, account: 'Каса' };
const receipt = { ...payment, id: originalId, clubId, bookingId: id, seatId: null, customerId, originalId: null, note: '' };
const refund = { ...payment, kind: 'REFUND', originalId, note: 'Клієнт скасував заняття' };
const post = (body: object, role = 'ADMIN', path = `/bookings/${id}/settlements`) => request(app).post(path).set('Authorization', auth(role)).send(body);

beforeEach(() => {
  vi.resetAllMocks();
  prisma.$transaction.mockImplementation(async fn => fn(prisma));
  prisma.club.findUniqueOrThrow.mockResolvedValue({ settlementSettings: {} });
  prisma.booking.findFirst.mockResolvedValue({ id, clubId, customerId, capacity: null, priceTotal: 50000, status: 'CONFIRMED', payment: null });
  prisma.bookingLedgerEntry.findMany.mockResolvedValue([]);
  prisma.bookingLedgerEntry.findUnique.mockResolvedValue(null);
  prisma.bookingLedgerEntry.create.mockImplementation(async ({ data }) => ({ id: originalId, ...data }));
  prisma.customer.updateMany.mockResolvedValue({ count: 1 });
  prisma.user.findFirst.mockResolvedValue({ id: userId, email: 'moderator@club.test', role: 'ADMIN' });
});

it('requires authentication and rejects trainers', async () => {
  expect((await request(app).post(`/bookings/${id}/settlements`).send(payment)).status).toBe(401);
  expect((await post(payment, 'TRAINER')).status).toBe(403);
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
it('records the authenticated account, amount and destination; ignores a forged actor', async () => {
  const res = await post({ ...payment, actorEmail: 'forged' });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ actorId: userId, actorEmail: 'moderator@club.test', amount: 15000, account: 'Каса' });
  expect(prisma.$queryRaw).toHaveBeenCalledOnce();
  expect(prisma.booking.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id, clubId } }));
});
it('confirms a private booking as soon as the full amount is actually received', async () => {
  const res = await post({ ...payment, amount: 50000 });
  expect(res.status).toBe(200);
  expect(prisma.booking.update).toHaveBeenCalledWith({
    where: { id },
    data: expect.objectContaining({ status: 'CONFIRMED', expiresAt: null, confirmedBy: 'moderator@club.test' }),
  });
});
it('keeps an accepted cash booking confirmed after a partial payment', async () => {
  const res = await post(payment);
  expect(res.status).toBe(200);
  expect(prisma.bookingLedgerEntry.create).toHaveBeenCalled();
  expect(prisma.booking.update).not.toHaveBeenCalled();
});
it('returns a private booking to pending after a refund leaves an unpaid balance', async () => {
  prisma.bookingLedgerEntry.findMany.mockResolvedValue([receipt]);
  const res = await post(refund, 'OWNER');
  expect(res.status).toBe(200);
  expect(prisma.booking.update).toHaveBeenCalledWith({
    where: { id },
    data: { status: 'PENDING', expiresAt: null, confirmedBy: null, confirmedAt: null },
  });
});
it.each([0, -1, 0.5, 100_000_001, '15000'])('rejects invalid money %s', async amount => {
  expect((await post({ ...payment, amount })).status).toBe(400);
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
it('does not expose or write another club booking', async () => {
  prisma.booking.findFirst.mockResolvedValue(null);
  expect((await post(payment)).status).toBe(404);
  expect(prisma.bookingLedgerEntry.create).not.toHaveBeenCalled();
});
it('enforces outstanding balance including online and manual receipts', async () => {
  prisma.booking.findFirst.mockResolvedValue({ id, clubId, customerId, capacity: null, priceTotal: 50000, status: 'CONFIRMED', payment: { status: 'PAID', amount: 30000 } });
  prisma.bookingLedgerEntry.findMany.mockResolvedValue([{ kind: 'PAYMENT', amount: 10000 }]);
  expect((await post(payment)).body.error).toBe('PAYMENT_EXCEEDS_DUE');
});
it('blocks manual payment while an online invoice is pending', async () => {
  prisma.booking.findFirst.mockResolvedValue({ id, capacity: null, status: 'PENDING', payment: { status: 'PENDING' } });
  expect((await post(payment)).body.error).toBe('ONLINE_PAYMENT_PENDING');
});
it('replays the same request without creating another receipt', async () => {
  prisma.bookingLedgerEntry.findUnique.mockResolvedValue(receipt);
  expect((await post(payment)).status).toBe(200);
  expect(prisma.bookingLedgerEntry.create).not.toHaveBeenCalled();
  expect(prisma.customer.updateMany).not.toHaveBeenCalled();
});
it('rejects reusing an idempotency key for different money', async () => {
  prisma.bookingLedgerEntry.findUnique.mockResolvedValue(receipt);
  expect((await post({ ...payment, amount: 10000 })).body.error).toBe('IDEMPOTENCY_CONFLICT');
});
it('requires an owner role for refunds unless the club delegates them', async () => {
  prisma.bookingLedgerEntry.findMany.mockResolvedValue([receipt]);
  expect((await post(refund)).status).toBe(403);
  expect((await post(refund, 'OWNER')).status).toBe(200);
  prisma.club.findUniqueOrThrow.mockResolvedValue({ settlementSettings: { moderatorRefunds: true } });
  expect((await post(refund)).status).toBe(200);
});
it('rejects a missing refund reason and missing source', async () => {
  expect((await post({ ...refund, note: '' }, 'OWNER')).status).toBe(400);
  expect((await post({ ...refund, originalId: undefined }, 'OWNER')).status).toBe(400);
});
it('limits partial refunds to the original receipt remainder', async () => {
  prisma.bookingLedgerEntry.findMany.mockResolvedValue([receipt, { kind: 'REFUND', originalId, amount: 10000 }]);
  expect((await post(refund, 'OWNER')).body.error).toBe('REFUND_EXCEEDS_PAID');
  expect((await post({ ...refund, amount: 5000 }, 'OWNER')).status).toBe(200);
});
it('rejects another booking receipt as a refund source', async () => {
  expect((await post(refund, 'OWNER')).body.error).toBe('NOTHING_TO_REFUND');
});
it('respects club refund method settings', async () => {
  prisma.club.findUniqueOrThrow.mockResolvedValue({ settlementSettings: { cashRefunds: false } });
  expect((await post(refund, 'OWNER')).body.error).toBe('REFUND_METHOD_DISABLED');
});
it('credits bonus refunds atomically with the receipt and never cancels the booking', async () => {
  prisma.bookingLedgerEntry.findMany.mockResolvedValue([receipt]);
  expect((await post({ ...refund, method: 'BONUS' }, 'OWNER')).status).toBe(200);
  expect(prisma.customer.updateMany).toHaveBeenCalledWith({ where: { id: customerId, clubId }, data: { bonusBalance: { increment: 15000 } } });
});
it('debits a bonus payment only when the customer has enough credit', async () => {
  prisma.customer.updateMany.mockResolvedValue({ count: 0 });
  expect((await post({ ...payment, method: 'BONUS' })).body.error).toBe('INSUFFICIENT_BONUS');
  expect(prisma.customer.updateMany).toHaveBeenCalledWith({ where: { id: customerId, clubId, bonusBalance: { gte: 15000 } }, data: { bonusBalance: { increment: -15000 } } });
  expect(prisma.bookingLedgerEntry.create).not.toHaveBeenCalled();
});
it('does not convert refunded bonuses to cash', async () => {
  prisma.bookingLedgerEntry.findMany.mockResolvedValue([{ ...receipt, method: 'BONUS' }]);
  expect((await post(refund, 'OWNER')).body.error).toBe('BONUS_REFUND_ONLY');
});
it('rejects unknown accounts', async () => {
  expect((await post({ ...payment, account: 'Чужий рахунок' })).body.error).toBe('ACCOUNT_REQUIRED');
});
it('handles individual seats and scopes their lookup to the club', async () => {
  prisma.bookingSeat.findFirst.mockResolvedValue({ id: originalId, bookingId: id, customerId, price: 20000, status: 'BOOKED', payment: null });
  const res = await post(payment, 'ADMIN', `/seats/${originalId}/settlements`);
  expect(res.status).toBe(200);
  expect(res.body.seatId).toBe(originalId);
  expect(prisma.bookingSeat.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: originalId, booking: { clubId } } }));
});
it('requires an owner role to change settings', async () => {
  expect((await request(app).put('/settlement-settings').set('Authorization', auth()).send({})).status).toBe(403);
  expect((await request(app).put('/settlement-settings').set('Authorization', auth('OWNER')).send({ accounts: ['Каса', 'Каса'] })).body.accounts).toEqual(['Каса']);
});
it('staff can read totals but trainers cannot read financial history', async () => {
  prisma.bookingLedgerEntry.findMany.mockResolvedValue([receipt, { kind: 'REFUND', amount: 5000 }]);
  const res = await request(app).get(`/bookings/${id}/settlements`).set('Authorization', auth('ADMIN'));
  expect(res.body).toMatchObject({ received: 15000, refunded: 5000, net: 10000 });
  expect((await request(app).get(`/bookings/${id}/settlements`).set('Authorization', auth('TRAINER'))).status).toBe(403);
});
