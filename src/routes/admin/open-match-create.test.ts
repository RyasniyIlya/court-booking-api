import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Відкрита гра в кабінеті. Перевіряється рівно те, через що фіча може
 * тихо не працювати: гра без місць (до неї нема куди записатись),
 * перевернутий діапазон рівня й мовчазна розсилка — адміністратор має
 * бачити, кого покликали, тим самим екраном.
 */

const prisma = {
  booking: { findFirst: vi.fn(), create: vi.fn() },
  court: { findFirst: vi.fn() },
  club: { findUniqueOrThrow: vi.fn() },
  customer: { findUnique: vi.fn() },
  trainer: { findFirst: vi.fn() },
  user: { findUniqueOrThrow: vi.fn(async () => ({ email: 'admin@club.test' })) },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
};
const inviteMatch = vi.fn();

vi.mock('../../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../../lib/notifyBooking', () => ({ notifyBooking: vi.fn(), notifySeriesCancelled: vi.fn() }));
vi.mock('../../lib/openMatchInvite', () => ({ inviteMatch }));
/* Приватна бронь заводить картку клієнта — тут це не предмет перевірки. */
vi.mock('../../lib/customers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/customers')>()),
  findOrCreateCustomer: vi.fn(async () => ({ id: 'customer', discountPercent: 0, birthDate: null })),
  getActivePasses: vi.fn(async () => new Map()),
}));
vi.mock('../../lib/rentalStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rentalStore')>()),
  previewRentals: vi.fn(async () => ({ ok: true, total: 0, lines: [] })),
  reserveRentals: vi.fn(async () => ({ total: 0, lines: [] })),
}));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: 'admin', clubId: 'club', role: 'ADMIN' }; next();
  },
  requireStaff: (_req: unknown, _res: unknown, next: () => void) => next(),
  hasFeature: () => true,
  param: (req: { params: Record<string, string> }, key: string) => req.params[key],
}));

const { bookingsRouter } = await import('./bookings');
const app = express().use(express.json()).use(bookingsRouter);

const COURT = '11111111-1111-4111-8111-111111111111';

const create = (body: Record<string, unknown>) =>
  request(app).post('/bookings').send({
    courtId: COURT,
    start: '2030-01-01T18:00:00Z',
    end: '2030-01-01T19:00:00Z',
    ...body,
  });

const openMatch = (extra: Record<string, unknown> = {}) =>
  create({ capacity: 4, pricePerSeat: 20_000, isOpenMatch: true, levelMin: 'C', levelMax: 'C_PLUS', ...extra });

const created = () => prisma.booking.create.mock.calls[0]![0].data;

beforeEach(() => {
  vi.resetAllMocks();
  prisma.user.findUniqueOrThrow.mockResolvedValue({ email: 'admin@club.test' });
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  prisma.booking.findFirst.mockResolvedValue(null);
  prisma.court.findFirst.mockResolvedValue({ id: COURT, clubId: 'club', pricePerHour: 40_000, slotMinutes: null });
  prisma.club.findUniqueOrThrow.mockResolvedValue({ timezone: 'Europe/Kyiv', slotMinutes: 60, promos: [] });
  prisma.customer.findUnique.mockResolvedValue(null);
  prisma.booking.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...data, id: 'match', court: { name: 'Корт 1' }, trainer: null, rentals: [],
  }));
  inviteMatch.mockResolvedValue([]);
});

it('creates an open match as a group booking and keeps the court taken exactly once', async () => {
  const res = await openMatch();

  expect(res.status).toBe(201);
  expect(created()).toMatchObject({
    isOpenMatch: true, capacity: 4, pricePerSeat: 20_000, levelMin: 'C', levelMax: 'C_PLUS',
    /* Ні імені, ні телефону: у контейнера групи одного клієнта немає. */
    customerName: null, customerPhone: null,
  });
});

it('names the game itself: an open match has no lesson title', async () => {
  await openMatch({ title: undefined });
  expect(created().title).toBe('Відкрита гра');
});

it('keeps the club title when the club gave one', async () => {
  await openMatch({ title: 'Вечірня гра C+' });
  expect(created().title).toBe('Вечірня гра C+');
});

it('invites players right away and answers with whom it called and why', async () => {
  inviteMatch.mockResolvedValue([
    { id: 'p1', name: 'Олег', level: 'C_PLUS', score: 95, reasons: ['зазвичай грає о 20:00'] },
  ]);

  const res = await openMatch();

  expect(inviteMatch).toHaveBeenCalledWith('match');
  expect(res.body.invited).toEqual([
    { id: 'p1', name: 'Олег', level: 'C_PLUS', score: 95, reasons: ['зазвичай грає о 20:00'] },
  ]);
});

it('does not lose the game when the invitations fail: the court is already booked', async () => {
  inviteMatch.mockRejectedValue(new Error('telegram down'));

  const res = await openMatch();

  expect(res.status).toBe(201);
  expect(res.body.invited).toEqual([]);
});

it('refuses an open match without seats: there is nowhere to join', async () => {
  const res = await openMatch({ capacity: undefined });

  expect(res.status).toBe(400);
  expect(prisma.booking.create).not.toHaveBeenCalled();
});

it('refuses a backwards level range instead of silently swapping it', async () => {
  const res = await openMatch({ levelMin: 'B_PLUS', levelMax: 'C' });

  expect(res.status).toBe(400);
  expect(prisma.booking.create).not.toHaveBeenCalled();
});

it('leaves an ordinary group booking alone: no level, no invitations', async () => {
  await create({ capacity: 8, title: 'Ранкова йога', pricePerSeat: 15_000 });

  expect(created()).toMatchObject({ isOpenMatch: false, levelMin: null, levelMax: null, title: 'Ранкова йога' });
  expect(inviteMatch).not.toHaveBeenCalled();
});

it('leaves a private booking alone', async () => {
  await create({ customerName: 'Гравець', customerPhone: '+380671112233' });

  expect(created()).toMatchObject({ isOpenMatch: false, capacity: null });
  expect(inviteMatch).not.toHaveBeenCalled();
});

/* Ф-7: ручне створення в кабінеті акцій не рахує, тож знімок «до акції»
   дорівнює самій ціні — інакше звіт про окупність акцій вважав би це
   акційною бронню без жодної акції. */
it('records listPrice equal to priceTotal: the admin route never applies a promo', async () => {
  await create({ customerName: 'Гравець', customerPhone: '+380671112233' });

  const data = created();
  expect(data.listPrice).toBe(data.priceTotal);
});
