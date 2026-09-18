import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { canReschedule } from '../lib/reschedule';

const tx = {
  bookingReschedule: { create: vi.fn() },
  booking: { findFirst: vi.fn(), updateMany: vi.fn() },
  block: { findFirst: vi.fn() }, court: { findFirst: vi.fn() }, passUsage: { findUnique: vi.fn() },
  $queryRaw: vi.fn(), bookingRental: { findMany: vi.fn() },
};
const prisma = { ...tx, $transaction: vi.fn(async (run: (db: typeof tx) => Promise<unknown>) => run(tx)) };
const verifyCustomerToken = vi.fn();
const notifyBooking = vi.fn(async () => {});
vi.mock('../lib/db', () => ({ prisma, isSlotTakenError: (e: {code: string}) => e.code === '23P01' }));
vi.mock('../lib/customerAuth', () => ({ verifyCustomerToken, signCustomerToken: vi.fn() }));
vi.mock('../lib/billing', () => ({ clubBilling: () => ({ online: true }) }));
vi.mock('../lib/notifyBooking', () => ({ notifyBooking }));
const { publicRouter } = await import('./public');
const app = express().use(express.json()).use('/api/public', publicRouter);
const id = '12345678-1234-4234-8234-123456789012';
const version = '2026-09-01T00:00:00.000Z';
const RACKET = '22222222-2222-4222-8222-222222222222';
const target = { courtId: id, start: '2099-10-02T10:00:00.000Z', end: '2099-10-02T11:00:00.000Z', version, expectedPrice: 10000 };
let booking: any;
const post = (data = {}) => request(app).post(`/api/public/customer/bookings/${id}/reschedule`)
  .set('Authorization', 'Bearer valid').send({ ...target, ...data });
beforeEach(() => {
  vi.clearAllMocks();
  verifyCustomerToken.mockReturnValue({ customerId: 'customer', clubId: 'club' });
  booking = { id, clubId: 'club', customerId: 'customer', capacity: null, status: 'CONFIRMED',
    startTime: new Date('2099-10-01T10:00:00Z'), endTime: new Date('2099-10-01T11:00:00Z'),
    updatedAt: new Date(version), priceTotal: 10000, courtId: id, trainerId: null, trainer: null,
    payment: { status: 'PAID' }, expiresAt: null, customer: { discountPercent: 0 }, paymentPlan: { method: 'CASH' },
    rentals: [], rentalTotal: 0,
    club: { timezone: 'UTC', leadTimeMinutes: 15, slotMinutes: 60, promos: [],
      hours: Array.from({length: 7}, (_, weekday) => ({ weekday, openMinute: 0, closeMinute: 1440, isClosed: false })) } };
  tx.booking.findFirst.mockImplementation(async ({ where }) => where.customerId ? booking : null);
  tx.booking.updateMany.mockResolvedValue({ count: 1 });
  tx.court.findFirst.mockResolvedValue({ id, name: 'Корт', pricePerHour: 10000, slotMinutes: 60 });
  tx.block.findFirst.mockResolvedValue(null);
  tx.passUsage.findUnique.mockResolvedValue(null);
  tx.$queryRaw.mockResolvedValue([{ id: RACKET, name: 'Ракетка', quantity: 2, rentPrice: 5000, rentMode: 'FIXED' }]);
  tx.bookingRental.findMany.mockResolvedValue([]);
});
describe('перенесення', () => {
  it('рівно 6 годин дозволено, на мілісекунду пізніше — ні', () => {
    const now = new Date('2026-09-15T00:00:00Z');
    expect(canReschedule(new Date(now.getTime() + 21600000), now)).toBe(true);
    expect(canReschedule(new Date(now.getTime() + 21599999), now)).toBe(false);
  });
  it('без авторизації не змінює бронь', async () => {
    verifyCustomerToken.mockReturnValue(null);
    expect((await post()).status).toBe(401);
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });
  it('шукає лише власну бронь у своєму клубі', async () => {
    booking = null;
    expect((await post()).body.error).toBe('NOT_FOUND');
    expect(tx.booking.findFirst.mock.calls[0][0].where).toEqual({ id, customerId: 'customer', clubId: 'club' });
  });
  it('попередній розрахунок нічого не змінює', async () => {
    expect((await post({ preview: true })).body.price).toBe(10000);
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
    expect(notifyBooking).not.toHaveBeenCalled();
  });
  it('переносить той самий запис, зберігає оплату, додає історію', async () => {
    expect((await post()).status).toBe(200);
    const data = tx.booking.updateMany.mock.calls[0][0].data;
    expect(data.startTime).toEqual(new Date(target.start));
    expect(data.playerRemindedAt).toBeNull();
    expect(data).not.toHaveProperty('paymentPlan');
    expect(tx.bookingReschedule.create.mock.calls[0][0].data.customerId).toBe('customer');
    expect(data).not.toHaveProperty('priceTotal');
    expect(notifyBooking).toHaveBeenCalledWith({ bookingId: id, event: 'updated' });
  });
  it.each(['CLOSED', 'CHANGED', 'PAYMENT_PENDING', 'PRICE_DIFFERENCE', 'SLOT_TAKEN', 'TRAINER_UNAVAILABLE', 'PASS_EXPIRED'])('%s залишає стару бронь', async code => {
    if (code === 'CLOSED') booking.startTime = new Date(Date.now() + 10000);
    if (code === 'CHANGED') booking.updatedAt = new Date(0);
    if (code === 'PAYMENT_PENDING') booking.payment.status = 'PENDING';
    if (code === 'PRICE_DIFFERENCE') booking.priceTotal = 8000;
    if (code === 'SLOT_TAKEN') tx.block.findFirst.mockResolvedValue({ id });
    if (code === 'TRAINER_UNAVAILABLE') booking.trainer = { isActive: false };
    if (code === 'PASS_EXPIRED') tx.passUsage.findUnique.mockResolvedValue({ revertedAt: null, pass: { validFrom: new Date(0), validUntil: new Date(1) } });
    expect((await post()).body.error).toBe(code);
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
    expect(notifyBooking).not.toHaveBeenCalled();
  });
  it('гонка на новому слоті повертає конфлікт без сповіщення', async () => {
    tx.booking.updateMany.mockRejectedValueOnce({ code: '23P01' });
    expect((await post()).body.error).toBe('SLOT_TAKEN');
    expect(notifyBooking).not.toHaveBeenCalled();
  });
});

describe('перенесення з прокатом', () => {
  const withRackets = () => {
    booking = { ...booking, priceTotal: 20000, rentalTotal: 10000, rentals: [
      { id: 'line', itemId: RACKET, itemName: 'Ракетка', quantity: 2, mode: 'FIXED', unitPrice: 5000, amount: 10000 },
    ] };
  };
  const taken = (quantity: number) => tx.bookingRental.findMany.mockResolvedValue([{
    itemId: RACKET, quantity,
    booking: { startTime: new Date('2099-10-02T10:00:00Z'), endTime: new Date('2099-10-02T11:00:00Z') },
  }]);

  it('ракетки є — ціна включає прокат, бронь переїжджає разом із ним', async () => {
    withRackets();
    const res = await post({ expectedPrice: 20000 });
    expect(res.status).toBe(200);
    expect(res.body.price).toBe(20000);
    expect(tx.booking.updateMany).toHaveBeenCalled();
    // власний прокат не конкурує сам із собою
    expect(tx.bookingRental.findMany.mock.calls[0][0].where.booking.id).toEqual({ not: id });
  });

  it('не вистачає — попередній розрахунок каже, чого саме', async () => {
    withRackets();
    taken(1);
    const res = await post({ preview: true });
    expect(res.body.reason).toBe('RENTAL_SHORTAGE');
    expect(res.body.rentalShortages).toEqual([{ itemId: RACKET, itemName: 'Ракетка', requested: 2, free: 1 }]);
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it('не вистачає — гравець сам не переносить і суму не змінює', async () => {
    withRackets();
    taken(1);
    const res = await post({ expectedPrice: 20000 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('RENTAL_SHORTAGE');
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });
});
