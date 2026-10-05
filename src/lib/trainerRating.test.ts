import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Оцінка заняття з тренером: правила допуску й підрахунок середньої.
 *
 * Правила тут важливіші за «зберіглось»: і віджет, і Telegram-бот питають
 * гравця про одне й те саме, тож межі семиденного вікна, неявка й місце в
 * групі мусять збігатись до хвилини.
 */

const prisma = {
  booking: { findUnique: vi.fn(), findMany: vi.fn() },
  bookingSeat: { findUnique: vi.fn(), findMany: vi.fn() },
  trainer: { findFirst: vi.fn() },
  trainerPhoto: { findMany: vi.fn() },
  trainerRating: { findUnique: vi.fn(), upsert: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
};

vi.mock('./db', () => ({ prisma }));

const {
  PENDING_RATINGS_MAX, RATING_WINDOW_DAYS, adminRating, listPendingRatings, listTrainerRatings,
  loadRateableItem, loadRatingTarget, publicRating, ratingBlocker, ratingKindFromApi, ratingSummaries,
  ratingWindow, roundAvg, saveTrainerRating,
} = await import('./trainerRating');
type Target = Parameters<typeof ratingBlocker>[0];

const NOW = new Date('2026-10-05T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const target = (over: Partial<Target> = {}): Target => ({
  kind: 'b', id: 'b-1', bookingId: 'b-1', seatId: null,
  clubId: 'club-1', timezone: 'Europe/Kyiv',
  trainerId: 't-1', trainerName: 'Олена',
  customerId: 'cust-1', chatId: '777',
  bookingStatus: 'CONFIRMED', seatStatus: null, attendance: 'UNKNOWN',
  start: hoursAgo(3), end: hoursAgo(2),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.trainerRating.upsert.mockResolvedValue({});
  prisma.trainerPhoto.findMany.mockResolvedValue([]);
});

describe('ratingBlocker', () => {
  it('заняття, що щойно закінчилось, можна оцінити', () => {
    expect(ratingBlocker(target(), NOW)).toBeNull();
  });

  it('межі семиденного вікна: 7 днів рівно ще можна, трохи більше — вже ні', () => {
    const edge = new Date(NOW.getTime() - RATING_WINDOW_DAYS * 86_400_000);
    expect(ratingBlocker(target({ end: edge }), NOW)).toBeNull();
    expect(ratingBlocker(target({ end: new Date(edge.getTime() - 1) }), NOW)).toBe('TOO_LATE');
    expect(ratingBlocker(target({ end: hoursAgo(8 * 24) }), NOW)).toBe('TOO_LATE');
  });

  it('заняття, що ще йде, не оцінюють', () => {
    expect(ratingBlocker(target({ end: new Date(NOW.getTime() + 60_000) }), NOW)).toBe('NOT_ENDED');
    expect(ratingBlocker(target({ end: NOW }), NOW)).toBeNull();
  });

  it('неявка, скасована бронь і заняття без тренера — не підлягають оцінці', () => {
    expect(ratingBlocker(target({ attendance: 'NO_SHOW' }), NOW)).toBe('NO_SHOW');
    expect(ratingBlocker(target({ attendance: 'ARRIVED' }), NOW)).toBeNull();
    expect(ratingBlocker(target({ bookingStatus: 'CANCELLED' }), NOW)).toBe('NOT_CONFIRMED');
    expect(ratingBlocker(target({ bookingStatus: 'PENDING' }), NOW)).toBe('NOT_CONFIRMED');
    expect(ratingBlocker(target({ trainerId: null }), NOW)).toBe('NO_TRAINER');
  });

  it('місце в групі — тільки зі статусом BOOKED', () => {
    const seat = { kind: 's' as const, id: 's-1', seatId: 's-1' };
    expect(ratingBlocker(target({ ...seat, seatStatus: 'BOOKED' }), NOW)).toBeNull();
    expect(ratingBlocker(target({ ...seat, seatStatus: 'CANCELLED' }), NOW)).toBe('SEAT_NOT_BOOKED');
    expect(ratingBlocker(target({ ...seat, seatStatus: 'PENDING' }), NOW)).toBe('SEAT_NOT_BOOKED');
  });

  it('ratingWindow бере одні межі для бази й для памʼяті', () => {
    expect(ratingWindow(NOW)).toEqual({ from: hoursAgo(7 * 24), to: NOW });
  });
});

describe('ratingKindFromApi', () => {
  it('court/b → b, seat/s → s', () => {
    expect([ratingKindFromApi('court'), ratingKindFromApi('b')]).toEqual(['b', 'b']);
    expect([ratingKindFromApi('seat'), ratingKindFromApi('s')]).toEqual(['s', 's']);
  });
});

describe('loadRatingTarget', () => {
  const booking = (over: Record<string, unknown> = {}) => ({
    id: 'b-1', clubId: 'club-1', status: 'CONFIRMED', capacity: null, attendance: 'UNKNOWN',
    startTime: hoursAgo(3), endTime: hoursAgo(2), trainerId: 't-1', customerId: 'cust-1',
    trainer: { name: 'Олена' }, customer: { telegramChatId: '777' }, club: { timezone: 'Europe/Kyiv' },
    ...over,
  });

  it('індивідуальна бронь: гравець — Booking.customerId', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking());
    expect(await loadRatingTarget('b', 'b-1')).toMatchObject({
      kind: 'b', bookingId: 'b-1', seatId: null, customerId: 'cust-1', trainerName: 'Олена', chatId: '777',
    });
  });

  it('контейнер групи як бронь не віддається', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({ capacity: 8 }));
    expect(await loadRatingTarget('b', 'b-1')).toBeNull();
  });

  it('групове заняття: гравець — власник місця, а не контейнера', async () => {
    prisma.bookingSeat.findUnique.mockResolvedValue({
      id: 's-1', status: 'BOOKED', customerId: 'cust-2', bookingId: 'b-9',
      customer: { telegramChatId: null },
      booking: {
        clubId: 'club-1', status: 'CONFIRMED', capacity: 8, attendance: 'UNKNOWN',
        startTime: hoursAgo(3), endTime: hoursAgo(2), trainerId: 't-1',
        trainer: { name: 'Олена' }, club: { timezone: 'Europe/Kyiv' },
      },
    });
    expect(await loadRatingTarget('s', 's-1')).toMatchObject({
      kind: 's', bookingId: 'b-9', seatId: 's-1', customerId: 'cust-2', seatStatus: 'BOOKED',
    });
  });
});

describe('loadRateableItem', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'b-1', clubId: 'club-1', status: 'CONFIRMED', capacity: null, attendance: 'UNKNOWN',
    startTime: hoursAgo(3), endTime: hoursAgo(2), trainerId: 't-1', customerId: 'cust-1',
    trainer: { name: 'Олена' }, customer: { telegramChatId: null }, club: { timezone: 'Europe/Kyiv' },
    ...over,
  });
  const who = { customerId: 'cust-1', clubId: 'club-1' };

  it('свій заняття — ok', async () => {
    prisma.booking.findUnique.mockResolvedValue(row());
    expect(await loadRateableItem('court', 'b-1', who, NOW)).toMatchObject({ ok: true });
  });

  it('чужий гравець і чужий клуб — NOT_FOUND, а не NOT_RATEABLE', async () => {
    prisma.booking.findUnique.mockResolvedValue(row({ customerId: 'cust-other' }));
    expect(await loadRateableItem('court', 'b-1', who, NOW)).toEqual({ ok: false, error: 'NOT_FOUND' });

    prisma.booking.findUnique.mockResolvedValue(row({ clubId: 'club-2' }));
    expect(await loadRateableItem('court', 'b-1', who, NOW)).toEqual({ ok: false, error: 'NOT_FOUND' });

    prisma.booking.findUnique.mockResolvedValue(null);
    expect(await loadRateableItem('court', 'b-1', who, NOW)).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('своє, але старше 7 днів, або неявка — NOT_RATEABLE', async () => {
    prisma.booking.findUnique.mockResolvedValue(row({ endTime: hoursAgo(8 * 24) }));
    expect(await loadRateableItem('court', 'b-1', who, NOW)).toEqual({ ok: false, error: 'NOT_RATEABLE' });

    prisma.booking.findUnique.mockResolvedValue(row({ attendance: 'NO_SHOW' }));
    expect(await loadRateableItem('court', 'b-1', who, NOW)).toEqual({ ok: false, error: 'NOT_RATEABLE' });
  });
});

describe('saveTrainerRating', () => {
  it('upsert по (заняття, гравець) з джерелом', async () => {
    const res = await saveTrainerRating(target(), { score: 5, comment: '  Супер  ', source: 'TELEGRAM' }, NOW);

    expect(res).toEqual({ ok: true });
    const arg = prisma.trainerRating.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ bookingId_customerId: { bookingId: 'b-1', customerId: 'cust-1' } });
    expect(arg.create).toMatchObject({
      clubId: 'club-1', trainerId: 't-1', bookingId: 'b-1', seatId: null, customerId: 'cust-1',
      score: 5, comment: 'Супер', source: 'TELEGRAM',
    });
    expect(arg.update).toMatchObject({ score: 5, comment: 'Супер', source: 'TELEGRAM' });
  });

  it('відмова (score = null) коментар відкидає', async () => {
    await saveTrainerRating(target(), { score: null, comment: 'Було погано', source: 'WIDGET' }, NOW);

    expect(prisma.trainerRating.upsert.mock.calls[0][0].create).toMatchObject({ score: null, comment: null });
  });

  it('порожній коментар — null, довгий обрізається до 500', async () => {
    await saveTrainerRating(target(), { score: 4, comment: '   ', source: 'WIDGET' }, NOW);
    expect(prisma.trainerRating.upsert.mock.calls[0][0].create.comment).toBeNull();

    await saveTrainerRating(target(), { score: 4, comment: 'я'.repeat(900), source: 'WIDGET' }, NOW);
    expect(prisma.trainerRating.upsert.mock.calls[1][0].create.comment).toHaveLength(500);
  });

  it('перепровіряє допуск: заняття вийшло за вікно — NOT_RATEABLE, нічого не пишемо', async () => {
    const res = await saveTrainerRating(target({ end: hoursAgo(9 * 24) }), { score: 5, source: 'TELEGRAM' }, NOW);

    expect(res).toEqual({ ok: false, error: 'NOT_RATEABLE' });
    expect(prisma.trainerRating.upsert).not.toHaveBeenCalled();
  });

  it('оцінка поза 1..5 не доходить до бази', async () => {
    expect(await saveTrainerRating(target(), { score: 6, source: 'WIDGET' }, NOW)).toEqual({ ok: false, error: 'NOT_RATEABLE' });
    expect(await saveTrainerRating(target(), { score: 0, source: 'WIDGET' }, NOW)).toEqual({ ok: false, error: 'NOT_RATEABLE' });
    expect(prisma.trainerRating.upsert).not.toHaveBeenCalled();
  });

  it('групове заняття зберігає seatId', async () => {
    await saveTrainerRating(
      target({ kind: 's', id: 's-1', seatId: 's-1', seatStatus: 'BOOKED' }),
      { score: 3, source: 'WIDGET' },
      NOW,
    );
    expect(prisma.trainerRating.upsert.mock.calls[0][0].create.seatId).toBe('s-1');
  });
});

describe('listPendingRatings', () => {
  it('до трьох, найсвіжіші, з аватаром тренера, у межах гравця й клубу', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { id: 'b-1', startTime: hoursAgo(30), endTime: hoursAgo(29), trainerId: 't-1', trainer: { name: 'Олена' } },
      { id: 'b-2', startTime: hoursAgo(50), endTime: hoursAgo(49), trainerId: 't-2', trainer: { name: 'Іван' } },
    ]);
    prisma.bookingSeat.findMany.mockResolvedValue([
      {
        id: 's-1',
        booking: { startTime: hoursAgo(5), endTime: hoursAgo(4), trainerId: 't-1', trainer: { name: 'Олена' } },
      },
      {
        id: 's-2',
        booking: { startTime: hoursAgo(80), endTime: hoursAgo(79), trainerId: 't-2', trainer: { name: 'Іван' } },
      },
    ]);
    prisma.trainerPhoto.findMany.mockResolvedValue([{ id: 'ph-1', trainerId: 't-1' }, { id: 'ph-1b', trainerId: 't-1' }]);

    const list = await listPendingRatings({ customerId: 'cust-1', clubId: 'club-1' }, NOW);

    expect(list).toHaveLength(PENDING_RATINGS_MAX);
    expect(list.map((r) => [r.kind, r.id])).toEqual([['seat', 's-1'], ['court', 'b-1'], ['court', 'b-2']]);
    expect(list[0].trainerPhotoUrl).toBe('/api/public/trainers/photos/ph-1');
    expect(list[2].trainerPhotoUrl).toBeNull();

    const bookingWhere = prisma.booking.findMany.mock.calls[0][0].where;
    expect(bookingWhere).toMatchObject({
      clubId: 'club-1', customerId: 'cust-1', capacity: null, status: 'CONFIRMED',
      trainerId: { not: null }, attendance: { not: 'NO_SHOW' },
      endTime: { gte: hoursAgo(7 * 24), lte: NOW },
      trainerRatings: { none: { customerId: 'cust-1' } },
    });
    const seatWhere = prisma.bookingSeat.findMany.mock.calls[0][0].where;
    expect(seatWhere).toMatchObject({ customerId: 'cust-1', status: 'BOOKED' });
    expect(seatWhere.booking).toMatchObject({
      clubId: 'club-1', capacity: { not: null }, status: 'CONFIRMED',
      trainerRatings: { none: { customerId: 'cust-1' } },
    });
    /* Байти знімків не читаємо. */
    expect(prisma.trainerPhoto.findMany.mock.calls[0][0].select).toEqual({ id: true, trainerId: true });
  });

  it('порожньо — без запиту фото', async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.bookingSeat.findMany.mockResolvedValue([]);

    expect(await listPendingRatings({ customerId: 'cust-1', clubId: 'club-1' }, NOW)).toEqual([]);
    expect(prisma.trainerPhoto.findMany).not.toHaveBeenCalled();
  });
});

describe('середня оцінка', () => {
  it('roundAvg — один знак після коми', () => {
    expect(roundAvg(4.75)).toBe(4.8);
    expect(roundAvg(4.333333)).toBe(4.3);
    expect(roundAvg(5)).toBe(5);
  });

  it('ratingSummaries — один groupBy на всіх, відмови не рахуються', async () => {
    prisma.trainerRating.groupBy.mockResolvedValue([
      { trainerId: 't-1', _avg: { score: 4.666667 }, _count: { score: 3 } },
      { trainerId: 't-2', _avg: { score: null }, _count: { score: 0 } },
    ]);

    const map = await ratingSummaries(['t-1', 't-2', 't-3'], 'club-1');

    expect(map.get('t-1')).toEqual({ avg: 4.7, count: 3 });
    expect(map.has('t-2')).toBe(false);
    expect(map.has('t-3')).toBe(false);
    expect(prisma.trainerRating.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.trainerRating.groupBy.mock.calls[0][0].where).toEqual({
      clubId: 'club-1', trainerId: { in: ['t-1', 't-2', 't-3'] }, score: { not: null },
    });
  });

  it('без тренерів у базу не ходимо', async () => {
    expect((await ratingSummaries([], 'club-1')).size).toBe(0);
    expect(prisma.trainerRating.groupBy).not.toHaveBeenCalled();
  });

  it('публічно — від трьох оцінок, у кабінеті — від першої', () => {
    expect(publicRating({ avg: 5, count: 2 })).toBeNull();
    expect(publicRating({ avg: 4.8, count: 3 })).toEqual({ avg: 4.8, count: 3 });
    expect(publicRating(undefined)).toBeNull();
    expect(adminRating({ avg: 5, count: 1 })).toEqual({ avg: 5, count: 1 });
    expect(adminRating(undefined)).toBeNull();
  });
});

describe('listTrainerRatings', () => {
  it('чужий тренер — null', async () => {
    prisma.trainer.findFirst.mockResolvedValue(null);
    expect(await listTrainerRatings('t-1', 'club-2', 50)).toBeNull();
    expect(prisma.trainer.findFirst.mock.calls[0][0].where).toEqual({ id: 't-1', clubId: 'club-2' });
  });

  it('віддає відгуки без відмов і середню з кількістю', async () => {
    prisma.trainer.findFirst.mockResolvedValue({ id: 't-1' });
    prisma.trainerRating.groupBy.mockResolvedValue([{ trainerId: 't-1', _avg: { score: 4.5 }, _count: { score: 2 } }]);
    prisma.trainerRating.findMany.mockResolvedValue([{
      id: 'r-1', score: 5, comment: 'Дякую', source: 'WIDGET', createdAt: new Date('2026-10-04T10:00:00Z'),
      customer: { name: 'Марко' }, booking: { startTime: new Date('2026-10-04T08:00:00Z') },
    }]);

    const res = await listTrainerRatings('t-1', 'club-1', 50);

    expect(res).toEqual({
      avg: 4.5, count: 2,
      items: [{
        id: 'r-1', score: 5, comment: 'Дякую', customerName: 'Марко', source: 'WIDGET',
        sessionStart: '2026-10-04T08:00:00.000Z', createdAt: '2026-10-04T10:00:00.000Z',
      }],
    });
    expect(prisma.trainerRating.findMany.mock.calls[0][0]).toMatchObject({
      where: { trainerId: 't-1', clubId: 'club-1', score: { not: null } }, take: 50,
    });
  });

  it('без оцінок avg = null, count = 0', async () => {
    prisma.trainer.findFirst.mockResolvedValue({ id: 't-1' });
    prisma.trainerRating.groupBy.mockResolvedValue([]);
    prisma.trainerRating.findMany.mockResolvedValue([]);

    expect(await listTrainerRatings('t-1', 'club-1', 50)).toEqual({ avg: null, count: 0, items: [] });
  });
});
