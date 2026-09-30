import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const prisma = {
  booking: { findFirst: vi.fn(), update: vi.fn() },
  court: { findFirst: vi.fn() },
  club: { findUniqueOrThrow: vi.fn() },
  customer: { findUnique: vi.fn() },
  trainer: { findFirst: vi.fn() },
  user: { findUniqueOrThrow: vi.fn(async () => ({ email: 'admin@club.test' })) },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
};
const recalcRentalsForMove = vi.fn();
vi.mock('../../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../../lib/notifyBooking', () => ({ notifyBooking: vi.fn(), notifySeriesCancelled: vi.fn() }));
vi.mock('../../lib/rentalStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rentalStore')>()),
  recalcRentalsForMove,
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
const TRAINER = '22222222-2222-4222-8222-222222222222';
/* 2030-01-01 — вівторок. Київ узимку UTC+2: 08:00Z = 10:00 за клубом. */
const morningPromo = {
  id: 'promo', title: 'Ранок', kind: 'WEEKLY', weekdays: [2], startMinute: 480, endMinute: 720,
  discountType: 'PERCENT', discountValue: 50, courtIds: [], isActive: true,
};
const booking = {
  id: 'booking', clubId: 'club', courtId: COURT, capacity: null, status: 'CONFIRMED',
  customerId: 'customer', trainerId: null, trainerPrice: 0,
  priceTotal: 36000, rentalTotal: 0, rentals: [], promoNames: ['Ранок'], promoDiscount: 20000,
  ledgerEntries: [], payment: { status: 'PAID', amount: 36000 }, expiresAt: null,
  startTime: new Date('2030-01-01T08:00:00Z'), endTime: new Date('2030-01-01T09:00:00Z'),
};
const move = (body: Record<string, unknown>) => request(app).patch('/bookings/booking').send(body);
const given = (extra: Record<string, unknown> = {}) =>
  prisma.booking.findFirst.mockResolvedValueOnce({ ...booking, ...extra });
const updated = () => prisma.booking.update.mock.calls[0]![0].data;

beforeEach(() => {
  vi.resetAllMocks();
  prisma.user.findUniqueOrThrow.mockResolvedValue({ email: 'admin@club.test' });
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  /* Після самої броні (given) findFirst — перевірка зайнятості тренера. */
  prisma.booking.findFirst.mockResolvedValue(null);
  prisma.court.findFirst.mockResolvedValue({ id: COURT, clubId: 'club', pricePerHour: 40000, slotMinutes: null });
  prisma.club.findUniqueOrThrow.mockResolvedValue({ timezone: 'Europe/Kyiv', slotMinutes: 60, promos: [morningPromo] });
  prisma.customer.findUnique.mockResolvedValue({ discountPercent: 10, birthDate: null });
  prisma.trainer.findFirst.mockResolvedValue({ id: TRAINER, clubId: 'club', pricePerHour: 10000, isActive: true });
});

it('keeps the personal discount when the administrator moves a paid booking', async () => {
  given();
  const res = await move({ start: '2030-01-01T15:00:00Z', end: '2030-01-01T16:00:00Z' });

  expect(res.status).toBe(200);
  /* Без акції: 400 грн × 0.9 = 360 — рівно стільки, скільки вже сплачено. */
  expect(updated()).toMatchObject({
    priceTotal: 36000, promoNames: [], promoDiscount: 0, status: 'CONFIRMED', expiresAt: null,
  });
  expect(prisma.customer.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'customer' } }));
});

it('applies club promos, trainer and discount, and adds rentals on top undiscounted', async () => {
  given({
    trainerId: TRAINER, trainerPrice: 10000, rentalTotal: 5000, promoNames: [], promoDiscount: 0,
    rentals: [{ id: 'line', itemId: 'racket', quantity: 1, amount: 5000 }],
  });
  recalcRentalsForMove.mockResolvedValue({ lines: [], shortages: [], rentalTotal: 5000, delta: 0 });

  const res = await move({ start: '2030-01-01T08:00:00Z', end: '2030-01-01T09:00:00Z' });

  expect(res.status).toBe(200);
  /* Корт 400 → 200 за акцією, тренер 100; (200 + 100) × 0.9 = 270; прокат +50. */
  expect(updated()).toMatchObject({
    priceTotal: 32000, trainerPrice: 10000, rentalTotal: 5000, promoNames: ['Ранок'], promoDiscount: 20000,
  });
});

/* Ф-7: перенесення перераховує "поточну" акцію (promoNames/promoDiscount —
   бо ціна рахується заново на НОВИЙ час), але знімок на момент СТВОРЕННЯ
   броні (listPrice/promoIds) для звіту про окупність акцій має лишитись
   незайманим — інакше перенесена бронь "забула" б, яка акція діяла, коли
   клієнт її оформлював. */
it('does not touch the creation-time promo snapshot when a move recomputes the current promo', async () => {
  given({
    trainerId: TRAINER, trainerPrice: 10000, rentalTotal: 5000, promoNames: [], promoDiscount: 0,
    listPrice: 36000, promoIds: ['old-promo-id'],
    rentals: [{ id: 'line', itemId: 'racket', quantity: 1, amount: 5000 }],
  });
  recalcRentalsForMove.mockResolvedValue({ lines: [], shortages: [], rentalTotal: 5000, delta: 0 });

  const res = await move({ start: '2030-01-01T08:00:00Z', end: '2030-01-01T09:00:00Z' });

  expect(res.status).toBe(200);
  /* Поточна акція перерахована (як і в сусідньому тесті)... */
  expect(updated()).toMatchObject({ promoNames: ['Ранок'], promoDiscount: 20000 });
  /* ...а знімок створення в data взагалі не зʼявляється — update() його не чіпає. */
  expect(updated()).not.toHaveProperty('listPrice');
  expect(updated()).not.toHaveProperty('promoIds');
});

it('prices a trainer changed in the same request with the discount', async () => {
  given({ payment: null, status: 'PENDING' });

  const res = await move({ start: '2030-01-01T15:00:00Z', end: '2030-01-01T17:00:00Z', trainerId: TRAINER });

  expect(res.status).toBe(200);
  /* Дві години: корт 800 + тренер 200 = 1000, мінус 10%. */
  expect(updated()).toMatchObject({ priceTotal: 90000, trainerId: TRAINER, trainerPrice: 20000 });
});

it('does not reprice a group: its total is the seats sold, not the court', async () => {
  given({ capacity: 8, customerId: null, priceTotal: 120000 });

  const res = await move({ start: '2030-01-01T15:00:00Z', end: '2030-01-01T16:00:00Z' });

  expect(res.status).toBe(200);
  expect(updated()).not.toHaveProperty('priceTotal');
  expect(prisma.club.findUniqueOrThrow).not.toHaveBeenCalled();
});
