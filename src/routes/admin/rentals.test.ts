import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Прокат у кабінеті.
 *
 * Правка набору — це гроші: додали ракетку до оплаченої броні — має
 * зʼявитись борг (статус — за тим самим правилом, що при зміні тренера),
 * зняли — переплата. Видача — лише позначка, але
 * «Видано» двічі або з кінця ланцюжка писати не можна.
 */

const BOOKING = '33333333-3333-4333-8333-333333333333';
const RACKET = '22222222-2222-4222-8222-222222222222';
const BALLS = '44444444-4444-4444-8444-444444444444';
const RENTAL = '55555555-5555-4555-8555-555555555555';
const WATER = '66666666-6666-4666-8666-666666666666';
const WATER_LINE = '77777777-7777-4777-8777-777777777777';

const prisma = {
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  booking: { findUniqueOrThrow: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
  bookingRental: {
    findMany: vi.fn(), deleteMany: vi.fn(), update: vi.fn(), create: vi.fn(),
    updateMany: vi.fn(), findFirst: vi.fn(), findUniqueOrThrow: vi.fn(),
  },
  inventoryItem: { findMany: vi.fn() },
  user: { findUniqueOrThrow: vi.fn(async () => ({ email: 'admin@club.test' })) },
};

vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: 'admin', clubId: 'club', role: 'ADMIN', trainerId: null }; next();
  },
  requireStaff: (_req: unknown, _res: unknown, next: () => void) => next(),
  param: (req: { params: Record<string, string> }, key: string) => req.params[key],
}));

const { rentalsRouter } = await import('./rentals');
const app = express().use(express.json()).use(rentalsRouter);

const racketItem = { id: RACKET, name: 'Ракетка Wilson', quantity: 4, rentPrice: 12_000, rentMode: 'HOURLY', returnable: true };
const ballsItem = { id: BALLS, name: 'Мʼячі', quantity: 10, rentPrice: 5_000, rentMode: 'FIXED', returnable: true };
/** Витратна: видача списує її зі складу назавжди. */
const waterItem = { id: WATER, name: 'Вода', quantity: 30, rentPrice: 2_000, rentMode: 'FIXED', returnable: false };

/** Оплачена бронь на годину з однією ракеткою за старою ціною 10 000. */
const booking = (over: Record<string, unknown> = {}) => ({
  id: BOOKING, clubId: 'club', capacity: null, status: 'CONFIRMED',
  startTime: new Date('2030-01-01T10:00:00Z'), endTime: new Date('2030-01-01T11:00:00Z'),
  priceTotal: 50_000, rentalTotal: 10_000, expiresAt: null, payment: null,
  ledgerEntries: [{ kind: 'PAYMENT', amount: 50_000 }],
  rentals: [{
    id: RENTAL, itemId: RACKET, itemName: 'Ракетка Wilson', quantity: 1,
    mode: 'HOURLY', unitPrice: 10_000, amount: 10_000, status: 'ISSUED', returnable: true,
  }],
  ...over,
});

const put = (rentals: unknown) => request(app).put(`/bookings/${BOOKING}/rentals`).send({ rentals });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
    strings.join('').includes('"Booking"') ? [{ id: BOOKING }] : [racketItem, ballsItem, waterItem]);
  prisma.booking.findUniqueOrThrow.mockResolvedValue(booking());
  prisma.booking.update.mockImplementation(async ({ data }) => ({ id: BOOKING, ...data }));
  prisma.bookingRental.findMany.mockResolvedValue([]);
});

describe('PUT /bookings/:id/rentals', () => {
  it('додали мʼячі до оплаченої броні — борг у касі, прийнята бронь лишається CONFIRMED; наявна ракетка за знімком', async () => {
    const res = await put([{ itemId: RACKET, quantity: 2 }, { itemId: BALLS, quantity: 1 }]);

    expect(res.status).toBe(200);
    // 50 000 − 10 000 старого прокату + (2 × 10 000 за знімком + 5 000) = 65 000
    expect(prisma.booking.update.mock.calls[0][0].data).toMatchObject({
      priceTotal: 65_000, rentalTotal: 25_000, status: 'CONFIRMED',
    });
    expect(prisma.bookingRental.update).toHaveBeenCalledWith({
      where: { id: RENTAL }, data: { quantity: 2, amount: 20_000 },
    });
    expect(prisma.bookingRental.create.mock.calls[0][0].data).toMatchObject({
      itemId: BALLS, quantity: 1, mode: 'FIXED', unitPrice: 5_000, amount: 5_000, bookingId: BOOKING, returnable: true,
    });
  });

  it('зняли весь прокат — рядок видаляється, бронь лишається оплаченою', async () => {
    const res = await put([]);

    expect(res.status).toBe(200);
    expect(prisma.bookingRental.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [RENTAL] } } });
    expect(prisma.booking.update.mock.calls[0][0].data).toMatchObject({
      priceTotal: 40_000, rentalTotal: 0, status: 'CONFIRMED',
    });
  });

  it('не вистачає — 409 із деталями, нічого не пишеться', async () => {
    prisma.bookingRental.findMany.mockResolvedValue([{
      itemId: RACKET, quantity: 3, status: 'RESERVED', returnable: true,
      booking: { startTime: new Date('2030-01-01T10:00:00Z'), endTime: new Date('2030-01-01T11:00:00Z') },
    }]);

    const res = await put([{ itemId: RACKET, quantity: 2 }]);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'RENTAL_BUSY', shortages: [{ itemId: RACKET, requested: 2, free: 1 }] });
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(prisma.bookingRental.update).not.toHaveBeenCalled();
    // власна бронь не конкурує сама з собою
    expect(prisma.bookingRental.findMany.mock.calls[0][0].where.booking.id).toEqual({ not: BOOKING });
  });

  it('бронь під онлайн-холдом лишається PENDING, поки не доплатять', async () => {
    prisma.booking.findUniqueOrThrow.mockResolvedValue(booking({
      status: 'PENDING', expiresAt: new Date('2030-01-01T09:00:00Z'), ledgerEntries: [],
    }));
    const res = await put([{ itemId: RACKET, quantity: 1 }]);
    expect(res.status).toBe(200);
    expect(prisma.booking.update.mock.calls[0][0].data.status).toBe('PENDING');
  });

  it('групове заняття — 400', async () => {
    prisma.booking.findUniqueOrThrow.mockResolvedValue(booking({ capacity: 8, rentals: [] }));
    expect((await put([{ itemId: RACKET, quantity: 1 }])).body.error).toBe('RENTALS_PRIVATE_ONLY');
  });

  it('скасована бронь — 409', async () => {
    prisma.booking.findUniqueOrThrow.mockResolvedValue(booking({ status: 'CANCELLED' }));
    expect((await put([])).body.error).toBe('BOOKING_INACTIVE');
  });

  it('чужа бронь — 404', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    expect((await put([])).status).toBe(404);
  });
});

describe('видача й повернення', () => {
  it('RESERVED → ISSUED з автором; поворотна річ зі складу не списується', async () => {
    prisma.bookingRental.findFirst.mockResolvedValue({
      id: RENTAL, itemId: RACKET, quantity: 1, returnable: true, status: 'RESERVED',
    });
    prisma.bookingRental.updateMany.mockResolvedValue({ count: 1 });
    prisma.bookingRental.findUniqueOrThrow.mockResolvedValue({ id: RENTAL, status: 'ISSUED' });

    const res = await request(app).post(`/rentals/${RENTAL}/issue`);

    expect(res.status).toBe(200);
    const call = prisma.bookingRental.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: RENTAL, clubId: 'club', status: 'RESERVED' });
    expect(call.data).toMatchObject({ status: 'ISSUED', issuedBy: 'admin@club.test' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('видача витратної позиції списує її зі складу', async () => {
    prisma.bookingRental.findFirst.mockResolvedValue({
      id: WATER_LINE, itemId: WATER, quantity: 2, returnable: false, status: 'RESERVED',
    });
    prisma.bookingRental.updateMany.mockResolvedValue({ count: 1 });
    prisma.bookingRental.findUniqueOrThrow.mockResolvedValue({ id: WATER_LINE, status: 'ISSUED' });

    expect((await request(app).post(`/rentals/${WATER_LINE}/issue`)).status).toBe(200);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw.mock.calls[0].slice(1)).toContain(-2);
  });

  it('вдруге «Видано» — 409, а не друга видача', async () => {
    prisma.bookingRental.findFirst.mockResolvedValue({
      id: RENTAL, itemId: RACKET, quantity: 1, returnable: true, status: 'ISSUED',
    });
    prisma.bookingRental.updateMany.mockResolvedValue({ count: 0 });
    expect((await request(app).post(`/rentals/${RENTAL}/issue`)).body.error).toBe('BAD_TRANSITION');
  });

  it('повернення лише з ISSUED', async () => {
    prisma.bookingRental.findFirst.mockResolvedValue({
      id: RENTAL, itemId: RACKET, quantity: 1, returnable: true, status: 'ISSUED',
    });
    prisma.bookingRental.updateMany.mockResolvedValue({ count: 1 });
    prisma.bookingRental.findUniqueOrThrow.mockResolvedValue({ id: RENTAL, status: 'RETURNED' });
    await request(app).post(`/rentals/${RENTAL}/return`);
    expect(prisma.bookingRental.updateMany.mock.calls[0][0].where.status).toBe('ISSUED');
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('undo з RETURNED повертає в ISSUED і стирає позначку повернення', async () => {
    prisma.bookingRental.findFirst.mockResolvedValue({
      id: RENTAL, itemId: RACKET, quantity: 1, returnable: true, status: 'RETURNED',
    });
    prisma.bookingRental.updateMany.mockResolvedValue({ count: 1 });
    prisma.bookingRental.findUniqueOrThrow.mockResolvedValue({ id: RENTAL, status: 'ISSUED' });

    await request(app).post(`/rentals/${RENTAL}/undo`);

    expect(prisma.bookingRental.updateMany.mock.calls[0][0].data)
      .toEqual({ status: 'ISSUED', returnedAt: null, returnedBy: null });
  });

  it('скасована видача витратної повертає її на склад', async () => {
    prisma.bookingRental.findFirst.mockResolvedValue({
      id: WATER_LINE, itemId: WATER, quantity: 2, returnable: false, status: 'ISSUED',
    });
    prisma.bookingRental.updateMany.mockResolvedValue({ count: 1 });
    prisma.bookingRental.findUniqueOrThrow.mockResolvedValue({ id: WATER_LINE, status: 'RESERVED' });

    await request(app).post(`/rentals/${WATER_LINE}/undo`);

    expect(prisma.$executeRaw.mock.calls[0].slice(1)).toContain(2);
  });

  it('чужий рядок — 404', async () => {
    prisma.bookingRental.findFirst.mockResolvedValue(null);
    expect((await request(app).post(`/rentals/${RENTAL}/return`)).status).toBe(404);
  });
});

describe('чек-лист і приймання інвентарю', () => {
  const checklistBooking = (rentals: unknown[]) => ({
    id: BOOKING, status: 'CONFIRMED',
    startTime: new Date('2030-01-01T10:00:00Z'), endTime: new Date('2030-01-01T11:00:00Z'),
    rentalTotal: 10_000, rentals,
  });

  it('GET checklist каже, що лишилось на руках', async () => {
    prisma.booking.findFirst.mockResolvedValue(checklistBooking([
      { id: RENTAL, itemId: RACKET, itemName: 'Ракетка Wilson', quantity: 2, status: 'ISSUED', returnable: true, depositAmount: 50_000 },
      { id: WATER_LINE, itemId: WATER, itemName: 'Вода', quantity: 1, status: 'ISSUED', returnable: false, depositAmount: null },
    ]));

    const res = await request(app).get(`/bookings/${BOOKING}/checklist`);

    expect(res.status).toBe(200);
    expect(res.body.open).toBe(true);
    expect(res.body.onHand).toEqual([
      { id: RENTAL, itemId: RACKET, itemName: 'Ракетка Wilson', quantity: 2 },
    ]);
    expect(res.body.depositTotal).toBe(50_000);
  });

  it('усе повернено — чек-лист закритий', async () => {
    prisma.booking.findFirst.mockResolvedValue(checklistBooking([
      { id: RENTAL, itemId: RACKET, itemName: 'Ракетка Wilson', quantity: 2, status: 'RETURNED', returnable: true, depositAmount: null },
    ]));
    expect((await request(app).get(`/bookings/${BOOKING}/checklist`)).body.open).toBe(false);
  });

  it('«Прийняти інвентар» повертає лише поворотне, витратне не чіпає', async () => {
    prisma.booking.findFirst.mockResolvedValue({
      id: BOOKING,
      rentals: [
        { id: RENTAL, quantity: 2, status: 'ISSUED', returnable: true },
        { id: WATER_LINE, quantity: 1, status: 'ISSUED', returnable: false },
      ],
    });
    prisma.bookingRental.updateMany.mockResolvedValue({ count: 1 });
    prisma.bookingRental.findMany.mockResolvedValue([
      { id: RENTAL, quantity: 2, status: 'RETURNED', returnable: true },
      { id: WATER_LINE, quantity: 1, status: 'ISSUED', returnable: false },
    ]);

    const res = await request(app).post(`/bookings/${BOOKING}/inventory/accept`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: 1, open: false });
    expect(prisma.bookingRental.updateMany.mock.calls[0][0].where)
      .toMatchObject({ id: { in: [RENTAL] }, status: 'ISSUED' });
  });

  it('приймати нічого — нуль, і в базу не ходимо', async () => {
    prisma.booking.findFirst.mockResolvedValue({ id: BOOKING, rentals: [] });
    prisma.bookingRental.findMany.mockResolvedValue([]);
    const res = await request(app).post(`/bookings/${BOOKING}/inventory/accept`);
    expect(res.body).toMatchObject({ accepted: 0, open: false });
    expect(prisma.bookingRental.updateMany).not.toHaveBeenCalled();
  });

  it('чужа бронь — 404', async () => {
    prisma.booking.findFirst.mockResolvedValue(null);
    expect((await request(app).get(`/bookings/${BOOKING}/checklist`)).status).toBe(404);
  });
});

describe('застава й штраф', () => {
  it('сума з причиною пишуться разом', async () => {
    prisma.bookingRental.updateMany.mockResolvedValue({ count: 1 });
    prisma.bookingRental.findUniqueOrThrow.mockResolvedValue({ id: RENTAL, depositAmount: 50_000 });

    const res = await request(app).patch(`/rentals/${RENTAL}/deposit`)
      .send({ amount: 50_000, reason: 'Зламана ручка' });

    expect(res.status).toBe(200);
    expect(prisma.bookingRental.updateMany.mock.calls[0][0].data)
      .toEqual({ depositAmount: 50_000, depositReason: 'Зламана ручка' });
  });

  it('сума без причини — 400', async () => {
    const res = await request(app).patch(`/rentals/${RENTAL}/deposit`).send({ amount: 50_000, reason: null });
    expect(res.status).toBe(400);
    expect(prisma.bookingRental.updateMany).not.toHaveBeenCalled();
  });

  it('обидва null — запис знімається', async () => {
    prisma.bookingRental.updateMany.mockResolvedValue({ count: 1 });
    prisma.bookingRental.findUniqueOrThrow.mockResolvedValue({ id: RENTAL, depositAmount: null });
    expect((await request(app).patch(`/rentals/${RENTAL}/deposit`).send({ amount: null, reason: null })).status).toBe(200);
  });
});

describe('GET /bookings/:id/extend-check', () => {
  const NEXT = '88888888-8888-4888-8888-888888888888';
  const extendable = (over: Record<string, unknown> = {}) => ({
    id: BOOKING, courtId: 'court', capacity: null, status: 'CONFIRMED',
    endTime: new Date('2030-01-01T11:00:00Z'),
    rentals: [{ id: RENTAL, itemId: RACKET, itemName: 'Ракетка Wilson', quantity: 2, status: 'ISSUED', returnable: true }],
    ...over,
  });

  const check = (end = '2030-01-01T12:00:00.000Z') =>
    request(app).get(`/bookings/${BOOKING}/extend-check`).query({ end });

  it('ракетки на руках потрібні наступній броні — попередження, не відмова', async () => {
    prisma.booking.findFirst.mockResolvedValueOnce(extendable()).mockResolvedValueOnce(null);
    prisma.bookingRental.findMany.mockResolvedValue([{
      itemId: RACKET, quantity: 1, bookingId: NEXT,
      booking: { startTime: new Date('2030-01-01T11:00:00Z') },
    }]);

    const res = await check();

    expect(res.status).toBe(200);
    expect(res.body.conflicts).toEqual([{
      itemId: RACKET, itemName: 'Ракетка Wilson', onHand: 2, needed: 1,
      bookingId: NEXT, startTime: '2030-01-01T11:00:00.000Z',
    }]);
    expect(res.body.courtBusy).toBeNull();
  });

  it('нічого на руках — у базу за чужими рядками не ходимо', async () => {
    prisma.booking.findFirst.mockResolvedValueOnce(extendable({ rentals: [] })).mockResolvedValueOnce(null);
    const res = await check();
    expect(res.body.conflicts).toEqual([]);
    expect(prisma.bookingRental.findMany).not.toHaveBeenCalled();
  });

  it('корт зайнятий — це вже межа, а не попередження', async () => {
    prisma.booking.findFirst
      .mockResolvedValueOnce(extendable({ rentals: [] }))
      .mockResolvedValueOnce({ id: NEXT, startTime: new Date(), endTime: new Date() });
    expect((await check()).body.courtBusy).toMatchObject({ id: NEXT });
  });

  it('новий кінець не пізніше старого — 400', async () => {
    prisma.booking.findFirst.mockResolvedValueOnce(extendable());
    expect((await check('2030-01-01T10:30:00.000Z')).body.error).toBe('BAD_INTERVAL');
  });

  it('групове заняття — 400', async () => {
    prisma.booking.findFirst.mockResolvedValueOnce(extendable({ capacity: 8 }));
    expect((await check()).body.error).toBe('RENTALS_PRIVATE_ONLY');
  });
});
