import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Прокат, коли адміністратор переносить бронь або повертає її зі скасованих.
 *
 * Перенесення чек-листа НЕ торкається: переїжджає бронь, а видане лишається
 * виданим. Міняється тільки сума HOURLY-позицій — тривалість стала іншою.
 * Нестача на новий час іде кабінету попередженням, а не мовчазним урізанням:
 * це розмова адміністратора з клієнтом, а не рішення системи.
 *
 * Повернення зі скасованих — інша річ: там нестача повертається помилкою,
 * бо бронь ще можна не повертати.
 */

const BOOKING = '33333333-3333-4333-8333-333333333333';
const COURT = '11111111-1111-4111-8111-111111111111';
const RACKET = '22222222-2222-4222-8222-222222222222';

const prisma = {
  booking: { findFirst: vi.fn(), update: vi.fn() },
  court: { findFirst: vi.fn() },
  club: { findUniqueOrThrow: vi.fn(async () => ({ timezone: 'Europe/Kyiv', slotMinutes: 60, promos: [] })) },
  customer: { findUnique: vi.fn(async () => null) },
  bookingRental: { findMany: vi.fn(), deleteMany: vi.fn(), update: vi.fn() },
  user: { findUniqueOrThrow: vi.fn(async () => ({ email: 'admin@club.test', name: 'Admin', role: 'ADMIN' })) },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
};

vi.mock('../../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../../lib/notifyBooking', () => ({ notifyBooking: vi.fn(), notifySeriesCancelled: vi.fn() }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: 'admin', clubId: 'club', role: 'ADMIN', trainerId: null }; next();
  },
  requireStaff: (_req: unknown, _res: unknown, next: () => void) => next(),
  hasFeature: () => true,
  param: (req: { params: Record<string, string> }, key: string) => req.params[key],
}));

const { bookingsRouter } = await import('./bookings');
const app = express().use(express.json()).use(bookingsRouter);

/** Оплачена на місці година з двома ракетками HOURLY по 5 000. */
const booking = (over: Record<string, unknown> = {}) => ({
  id: BOOKING, clubId: 'club', courtId: COURT, capacity: null, status: 'CONFIRMED',
  startTime: new Date('2030-01-01T10:00:00Z'), endTime: new Date('2030-01-01T11:00:00Z'),
  priceTotal: 50_000, trainerPrice: 0, rentalTotal: 10_000, trainerId: null,
  expiresAt: null, payment: null, ledgerEntries: [{ kind: 'PAYMENT', amount: 50_000 }],
  rentals: [{
    id: 'line', itemId: RACKET, itemName: 'Ракетка', quantity: 2,
    mode: 'HOURLY', unitPrice: 5_000, amount: 10_000, returnable: true, status: 'RESERVED',
  }],
  ...over,
});

/** Чужа бронь на новому часі тримає стільки ракеток. */
const taken = (quantity: number) => prisma.bookingRental.findMany.mockResolvedValue([{
  itemId: RACKET, quantity, status: 'RESERVED', returnable: true,
  booking: { startTime: new Date('2030-01-02T10:00:00Z'), endTime: new Date('2030-01-02T12:00:00Z') },
}]);

const move = () => request(app).patch(`/bookings/${BOOKING}`)
  .send({ start: '2030-01-02T10:00:00Z', end: '2030-01-02T12:00:00Z' });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.booking.findFirst.mockResolvedValue(booking());
  prisma.court.findFirst.mockResolvedValue({ id: COURT, pricePerHour: 40_000 });
  prisma.$queryRaw.mockResolvedValue([
    { id: RACKET, name: 'Ракетка', quantity: 3, rentPrice: 5_000, rentMode: 'HOURLY', returnable: true },
  ]);
  prisma.bookingRental.findMany.mockResolvedValue([]);
});

describe('PATCH /bookings/:id — перенесення з прокатом', () => {
  it('на новий час вільна 1 з 2 — попереджає, але чек-лист лишає як є', async () => {
    taken(2);

    const res = await move();

    expect(res.status).toBe(200);
    expect(res.body.rentalShortages).toEqual([
      { itemId: RACKET, itemName: 'Ракетка', requested: 2, free: 1 },
    ]);
    // нічого не знято: дві ракетки, тільки сума на дві години
    expect(prisma.bookingRental.deleteMany).not.toHaveBeenCalled();
    expect(prisma.bookingRental.update).toHaveBeenCalledWith({
      where: { id: 'line' }, data: { amount: 20_000 },
    });
    // корт 2 год × 40 000 = 80 000 + 2 ракетки × 2 год × 5 000 = 100 000
    expect(prisma.booking.update.mock.calls[0][0].data).toMatchObject({ priceTotal: 100_000, rentalTotal: 20_000 });
  });

  it('усе вільне — жодних попереджень, HOURLY рахується на нову тривалість', async () => {
    const res = await move();

    expect(res.body.rentalShortages).toBeUndefined();
    expect(prisma.booking.update.mock.calls[0][0].data).toMatchObject({ priceTotal: 100_000, rentalTotal: 20_000 });
  });

  it('позиції не лишилось зовсім — рядок усе одно лишається в броні', async () => {
    taken(3);

    const res = await move();

    expect(res.body.rentalShortages).toEqual([
      { itemId: RACKET, itemName: 'Ракетка', requested: 2, free: 0 },
    ]);
    expect(prisma.bookingRental.deleteMany).not.toHaveBeenCalled();
    expect(prisma.booking.update.mock.calls[0][0].data).toMatchObject({ priceTotal: 100_000, rentalTotal: 20_000 });
  });

  it('видане перенесення не чіпає — статус лишається ISSUED', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({
      rentals: [{
        id: 'line', itemId: RACKET, itemName: 'Ракетка', quantity: 2,
        mode: 'HOURLY', unitPrice: 5_000, amount: 10_000, returnable: true, status: 'ISSUED',
      }],
    }));

    await move();

    // у базу йде тільки сума — статус видачі ніхто не переписує
    expect(prisma.bookingRental.update).toHaveBeenCalledWith({
      where: { id: 'line' }, data: { amount: 20_000 },
    });
  });

  it('тривалість не змінилась — суму не переписуємо', async () => {
    await request(app).patch(`/bookings/${BOOKING}`)
      .send({ start: '2030-01-02T10:00:00Z', end: '2030-01-02T11:00:00Z' });

    expect(prisma.bookingRental.update).not.toHaveBeenCalled();
  });

  it('зміна коментаря прокат не чіпає і без транзакції', async () => {
    await request(app).patch(`/bookings/${BOOKING}`).send({ comment: 'ok' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('PATCH /bookings/:id — повернення зі скасованих', () => {
  it('ракетки за цей час узяли — 409 із деталями, бронь лишається скасованою', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ status: 'CANCELLED' }));
    prisma.bookingRental.findMany.mockResolvedValue([{
      itemId: RACKET, quantity: 2, status: 'RESERVED', returnable: true,
      booking: { startTime: new Date('2030-01-01T10:00:00Z'), endTime: new Date('2030-01-01T11:00:00Z') },
    }]);

    const res = await request(app).patch(`/bookings/${BOOKING}`).send({ status: 'CONFIRMED' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'RENTAL_BUSY', shortages: [{ itemId: RACKET, requested: 2, free: 1 }] });
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  it('ракетка на руках в іншого клієнта — так само зайнята, хоч його бронь скінчилась', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ status: 'CANCELLED' }));
    prisma.bookingRental.findMany.mockResolvedValue([{
      itemId: RACKET, quantity: 3, status: 'ISSUED', returnable: true,
      booking: { startTime: new Date('2029-12-31T10:00:00Z'), endTime: new Date('2029-12-31T11:00:00Z') },
    }]);

    const res = await request(app).patch(`/bookings/${BOOKING}`).send({ status: 'CONFIRMED' });

    expect(res.status).toBe(409);
    expect(res.body.shortages).toEqual([{ itemId: RACKET, requested: 2, free: 0 }]);
  });

  it('ракетки вільні — бронь повертається', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ status: 'CANCELLED' }));
    const res = await request(app).patch(`/bookings/${BOOKING}`).send({ status: 'CONFIRMED' });
    expect(res.status).toBe(200);
    expect(prisma.booking.update.mock.calls[0][0].data).toMatchObject({ status: 'CONFIRMED' });
  });
});
