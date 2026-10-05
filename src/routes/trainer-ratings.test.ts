import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Оцінки тренерів і їхні фото в публічному API.
 *
 * Головне тут не «зберіглось», а межі: чужий гравець і чужий клуб не
 * оцінюють чужі заняття (404, а не 409 — відповідь не підказує, що id є),
 * заняття поза правилами допуску дають NOT_RATEABLE, а середню оцінку гравці
 * бачать тільки від трьох голосів.
 */

const prisma = {
  club: { findFirst: vi.fn(), findUnique: vi.fn() },
  customer: { findUnique: vi.fn() },
  booking: { findMany: vi.fn(), findUnique: vi.fn() },
  bookingSeat: { findMany: vi.fn(), findUnique: vi.fn() },
  waitlistEntry: { findMany: vi.fn() },
  trainerPhoto: { findMany: vi.fn(), findUnique: vi.fn() },
  trainerRating: { upsert: vi.fn(), groupBy: vi.fn() },
};

const verifyCustomerToken = vi.fn();

vi.mock('../lib/db', () => ({
  prisma, isSlotTakenError: () => false, notifyClub: vi.fn(),
}));
vi.mock('../lib/customers', () => ({
  findOrCreateCustomer: vi.fn(), getActivePass: vi.fn(async () => null), getActivePasses: vi.fn(),
}));
vi.mock('../lib/billing', () => ({ clubBilling: () => ({ online: true }) }));
vi.mock('../lib/payments', () => ({
  providerFor: () => null, publicBase: () => 'https://example.test',
}));
vi.mock('../lib/customerAuth', () => ({
  signCustomerToken: vi.fn(),
  verifyCustomerToken,
}));

const { publicRouter } = await import('./public');
const app = express().use(express.json()).use('/api/public', publicRouter);

const BOOKING = '11111111-1111-4111-8111-111111111111';
const SEAT = '22222222-2222-4222-8222-222222222222';
const PHOTO = '33333333-3333-4333-8333-333333333333';
const TRAINER = '44444444-4444-4444-8444-444444444444';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

const booking = (over: Record<string, unknown> = {}) => ({
  id: BOOKING, clubId: 'club-1', status: 'CONFIRMED', capacity: null, attendance: 'UNKNOWN',
  startTime: hoursAgo(3), endTime: hoursAgo(2), trainerId: TRAINER, customerId: 'cust-1',
  trainer: { name: 'Олена' }, customer: { telegramChatId: null }, club: { timezone: 'Europe/Kyiv' },
  ...over,
});

const seat = (over: Record<string, unknown> = {}, bookingOver: Record<string, unknown> = {}) => ({
  id: SEAT, status: 'BOOKED', customerId: 'cust-1', bookingId: BOOKING,
  customer: { telegramChatId: null },
  booking: {
    clubId: 'club-1', status: 'CONFIRMED', capacity: 8, attendance: 'UNKNOWN',
    startTime: hoursAgo(3), endTime: hoursAgo(2), trainerId: TRAINER,
    trainer: { name: 'Олена' }, club: { timezone: 'Europe/Kyiv' },
    ...bookingOver,
  },
  ...over,
});

const rate = (body: Record<string, unknown>, bearer: string | null = 'tok') => {
  const r = request(app).post('/api/public/customer/trainer-ratings');
  if (bearer) r.set('Authorization', `Bearer ${bearer}`);
  return r.send(body);
};

beforeEach(() => {
  vi.clearAllMocks();
  verifyCustomerToken.mockReturnValue({ scope: 'customer', customerId: 'cust-1', clubId: 'club-1' });
  prisma.booking.findUnique.mockResolvedValue(booking());
  prisma.bookingSeat.findUnique.mockResolvedValue(seat());
  prisma.trainerRating.upsert.mockResolvedValue({});
  prisma.trainerRating.groupBy.mockResolvedValue([]);
  prisma.trainerPhoto.findMany.mockResolvedValue([]);
});

describe('POST /customer/trainer-ratings', () => {
  it('індивідуальне заняття: upsert по (бронь, гравець) із джерелом WIDGET', async () => {
    const res = await rate({ kind: 'court', id: BOOKING, score: 5, comment: '  Дякую!  ' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const arg = prisma.trainerRating.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ bookingId_customerId: { bookingId: BOOKING, customerId: 'cust-1' } });
    expect(arg.create).toMatchObject({
      clubId: 'club-1', trainerId: TRAINER, bookingId: BOOKING, seatId: null, customerId: 'cust-1',
      score: 5, comment: 'Дякую!', source: 'WIDGET',
    });
  });

  it('групове заняття: оцінює власник місця, у рядку лишається seatId', async () => {
    const res = await rate({ kind: 'seat', id: SEAT, score: 4 });

    expect(res.status).toBe(200);
    expect(prisma.trainerRating.upsert.mock.calls[0][0].create).toMatchObject({
      bookingId: BOOKING, seatId: SEAT, customerId: 'cust-1', score: 4,
    });
  });

  it('score = null — відмова: рядок є, коментар відкинуто', async () => {
    const res = await rate({ kind: 'court', id: BOOKING, score: null, comment: 'Не сподобалось' });

    expect(res.status).toBe(200);
    expect(prisma.trainerRating.upsert.mock.calls[0][0].create).toMatchObject({ score: null, comment: null });
  });

  it('без токена — 401', async () => {
    verifyCustomerToken.mockReturnValue(null);

    const res = await rate({ kind: 'court', id: BOOKING, score: 5 }, null);

    expect(res.status).toBe(401);
    expect(prisma.trainerRating.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['0', { score: 0 }],
    ['6', { score: 6 }],
    ['дробова', { score: 4.5 }],
    ['рядок', { score: '5' }],
    ['без score', {}],
    ['довгий коментар', { score: 5, comment: 'x'.repeat(501) }],
    ['зайве поле', { score: 5, customerId: 'cust-2' }],
    ['невідомий kind', { kind: 'group', score: 5 }],
    ['не uuid', { id: 'abc', score: 5 }],
  ])('кривий body (%s) — 400', async (_name, patch) => {
    const res = await rate({ kind: 'court', id: BOOKING, ...patch });

    expect(res.status).toBe(400);
    expect(prisma.trainerRating.upsert).not.toHaveBeenCalled();
  });

  it('чужа бронь (інший гравець) — 404', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({ customerId: 'cust-other' }));

    const res = await rate({ kind: 'court', id: BOOKING, score: 5 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(prisma.trainerRating.upsert).not.toHaveBeenCalled();
  });

  it('бронь іншого клубу — 404', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({ clubId: 'club-2' }));

    const res = await rate({ kind: 'court', id: BOOKING, score: 5 });

    expect(res.status).toBe(404);
    expect(prisma.trainerRating.upsert).not.toHaveBeenCalled();
  });

  it('чуже місце в групі — 404', async () => {
    prisma.bookingSeat.findUnique.mockResolvedValue(seat({ customerId: 'cust-other' }));

    const res = await rate({ kind: 'seat', id: SEAT, score: 5 });

    expect(res.status).toBe(404);
    expect(prisma.trainerRating.upsert).not.toHaveBeenCalled();
  });

  it('неіснуючий id — 404', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);

    const res = await rate({ kind: 'court', id: BOOKING, score: 5 });

    expect(res.status).toBe(404);
  });

  it('заняття 8 днів тому — 409 NOT_RATEABLE', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({
      startTime: hoursAgo(8 * 24 + 1), endTime: hoursAgo(8 * 24),
    }));

    const res = await rate({ kind: 'court', id: BOOKING, score: 5 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NOT_RATEABLE');
    expect(prisma.trainerRating.upsert).not.toHaveBeenCalled();
  });

  it('неявка — 409 NOT_RATEABLE', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({ attendance: 'NO_SHOW' }));

    const res = await rate({ kind: 'court', id: BOOKING, score: 5 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NOT_RATEABLE');
  });

  it('скасована бронь — 409 NOT_RATEABLE', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({ status: 'CANCELLED' }));

    const res = await rate({ kind: 'court', id: BOOKING, score: 5 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NOT_RATEABLE');
  });

  it('заняття ще триває — 409 NOT_RATEABLE', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({
      startTime: hoursAgo(1), endTime: new Date(Date.now() + 3_600_000),
    }));

    const res = await rate({ kind: 'court', id: BOOKING, score: 5 });

    expect(res.status).toBe(409);
  });

  it('скасоване місце в групі — 409 NOT_RATEABLE', async () => {
    prisma.bookingSeat.findUnique.mockResolvedValue(seat({ status: 'CANCELLED' }));

    const res = await rate({ kind: 'seat', id: SEAT, score: 5 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NOT_RATEABLE');
  });

  it('заняття без тренера — 409 NOT_RATEABLE', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({ trainerId: null, trainer: null }));

    const res = await rate({ kind: 'court', id: BOOKING, score: 5 });

    expect(res.status).toBe(409);
  });
});

describe('GET /clubs/:slug/trainers', () => {
  const club = (trainers: unknown[]) => ({
    id: 'club-1', slug: 'demo', timezone: 'Europe/Kyiv', trainers,
  });
  const trainer = (id: string, name: string) => ({
    id, name, pricePerHour: 50000, note: null, hours: [], exceptions: [],
  });

  it('фото й рейтинг: від трьох оцінок рейтинг видно, менше — null', async () => {
    const T2 = '55555555-5555-4555-8555-555555555555';
    const T3 = '66666666-6666-4666-8666-666666666666';
    prisma.club.findFirst.mockResolvedValue(club([trainer(TRAINER, 'Олена'), trainer(T2, 'Іван'), trainer(T3, 'Марко')]));
    prisma.trainerPhoto.findMany.mockResolvedValue([
      { id: PHOTO, trainerId: TRAINER },
      { id: 'ph-2', trainerId: TRAINER },
    ]);
    prisma.trainerRating.groupBy.mockResolvedValue([
      { trainerId: TRAINER, _avg: { score: 4.75 }, _count: { score: 12 } },
      { trainerId: T2, _avg: { score: 5 }, _count: { score: 2 } },
    ]);

    const res = await request(app).get('/api/public/clubs/demo/trainers');

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      id: TRAINER,
      photoUrl: `/api/public/trainers/photos/${PHOTO}`,
      photos: [`/api/public/trainers/photos/${PHOTO}`, '/api/public/trainers/photos/ph-2'],
      rating: { avg: 4.8, count: 12 },
    });
    expect(res.body[1]).toMatchObject({ photoUrl: null, photos: [], rating: null });
    expect(res.body[2]).toMatchObject({ photoUrl: null, photos: [], rating: null });
    /* Один запит фото й один groupBy на всіх, байтів немає. */
    expect(prisma.trainerPhoto.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.trainerPhoto.findMany.mock.calls[0][0].select).toEqual({ id: true, trainerId: true });
    expect(prisma.trainerRating.groupBy).toHaveBeenCalledTimes(1);
  });

  it('у відповіді немає імен і коментарів гравців', async () => {
    prisma.club.findFirst.mockResolvedValue(club([trainer(TRAINER, 'Олена')]));
    prisma.trainerRating.groupBy.mockResolvedValue([
      { trainerId: TRAINER, _avg: { score: 4 }, _count: { score: 3 } },
    ]);

    const res = await request(app).get('/api/public/clubs/demo/trainers');

    expect(Object.keys(res.body[0].rating).sort()).toEqual(['avg', 'count']);
  });
});

describe('GET /trainers/photos/:id', () => {
  it('віддає байти з довгим кешем і nosniff', async () => {
    prisma.trainerPhoto.findUnique.mockResolvedValue({ data: Buffer.from([1, 2, 3]), mime: 'image/png' });

    const res = await request(app).get(`/api/public/trainers/photos/${PHOTO}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('немає фото — 404, не uuid — 400', async () => {
    prisma.trainerPhoto.findUnique.mockResolvedValue(null);

    expect((await request(app).get(`/api/public/trainers/photos/${PHOTO}`)).status).toBe(404);
    expect((await request(app).get('/api/public/trainers/photos/abc')).status).toBe(400);
  });
});

describe('GET /customer/me — pendingRatings', () => {
  beforeEach(() => {
    prisma.customer.findUnique.mockResolvedValue({
      id: 'cust-1', clubId: 'club-1', name: 'Марко', phone: '+380671112233', email: null,
      birthDate: null, discountPercent: 0, bonusBalance: 0, telegramChatId: null,
    });
    prisma.club.findUnique.mockResolvedValue({
      slug: 'demo', timezone: 'Europe/Kyiv', cancelCutoffMinutes: 0, passesEnabled: true, plan: null,
    });
    prisma.waitlistEntry.findMany.mockResolvedValue([]);
    /* Запит «очікують оцінки» єдиний, хто шукає за trainerId. */
    prisma.booking.findMany.mockImplementation(async (args: { where: { trainerId?: unknown } }) =>
      args.where.trainerId
        ? [{ id: BOOKING, startTime: hoursAgo(3), endTime: hoursAgo(2), trainerId: TRAINER, trainer: { name: 'Олена' } }]
        : []);
    prisma.bookingSeat.findMany.mockResolvedValue([]);
    prisma.trainerPhoto.findMany.mockResolvedValue([{ id: PHOTO, trainerId: TRAINER }]);
  });

  it('віддає картки «Оцініть заняття» з аватаром тренера', async () => {
    const res = await request(app).get('/api/public/customer/me').set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body.pendingRatings).toEqual([{
      kind: 'court',
      id: BOOKING,
      trainerName: 'Олена',
      trainerPhotoUrl: `/api/public/trainers/photos/${PHOTO}`,
      startTime: expect.any(String),
      endTime: expect.any(String),
    }]);
  });

  it('без занять на оцінку — порожній масив', async () => {
    prisma.booking.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/public/customer/me').set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body.pendingRatings).toEqual([]);
  });
});
