import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Знімок акції на момент створення броні (Ф-7): listPrice і promoIds
 * мають писатись одразу, щоб звіт про окупність акцій можна було
 * побудувати пізніше — а історію заднім числом не відновити.
 */

const prisma = { club: { findFirst: vi.fn() }, block: { findFirst: vi.fn() }, customer: { findUnique: vi.fn() },
  booking: { create: vi.fn(), update: vi.fn() }, payment: { create: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)) };
const notifyBooking = vi.fn();
vi.mock('../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../lib/payments', () => ({ providerFor: () => null, publicBase: () => 'https://api.test' }));
vi.mock('../lib/notifyBooking', () => ({ notifyBooking }));
vi.mock('../lib/billing', () => ({ clubBilling: () => ({ online: true }) }));
vi.mock('../lib/customers', async (orig) => ({
  ...(await orig<typeof import('../lib/customers')>()),
  findOrCreateCustomer: vi.fn(async () => ({
    id: 'customer', isBlocked: false, requiresPrepay: false, discountPercent: 0,
    birthDate: new Date('1990-01-01T00:00:00.000Z'),
  })),
}));
const { publicRouter } = await import('./public');
const app = express().use(express.json()).use(publicRouter);

const courtId = '11111111-1111-4111-8111-111111111111';
const promoId = '22222222-2222-4222-8222-222222222222';
/* 2030-01-01 — вівторок. Клуб у UTC, тож локальний і серверний час збігаються. */
const morningPromo = {
  id: promoId, title: '  Ранок  ', kind: 'WEEKLY', weekdays: [2], startMinute: 0, endMinute: 1440,
  discountType: 'PERCENT', discountValue: 30, courtIds: [], isActive: true,
};
const club = { id: 'club', slug: 'demo', timezone: 'UTC', leadTimeMinutes: 0, slotMinutes: 60,
  prepayEnabled: false, prepayRequired: true, autoConfirm: true, promos: [morningPromo], trainers: [],
  courts: [{ id: courtId, pricePerHour: 50000 }],
  hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, openMinute: 0, closeMinute: 1440, isClosed: false })) };

const book = () => request(app).post('/clubs/demo/bookings').send({
  courtId, payChoice: 'onsite',
  start: '2030-01-01T10:00:00Z', end: '2030-01-01T11:00:00Z',
  customerName: 'Player', customerPhone: '+380671112233', birthDate: '1990-01-01',
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.club.findFirst.mockResolvedValue(club);
  prisma.block.findFirst.mockResolvedValue(null);
  prisma.customer.findUnique.mockResolvedValue(null);
  prisma.booking.create.mockImplementation(async ({ data }) => ({ ...data, id: 'booking', cancelToken: 'cancel' }));
  prisma.payment.create.mockResolvedValue({});
});

it('пише listPrice і promoIds одразу при створенні броні з акцією', async () => {
  const res = await book();
  expect(res.status).toBe(201);

  const { data } = prisma.booking.create.mock.calls[0][0];
  /* 500 грн/год × 30% знижки = 350 грн — рівно те, що прийшло в priceTotal. */
  expect(data.priceTotal).toBe(35000);
  expect(data.promoNames).toEqual(['Ранок']);
  expect(data.promoDiscount).toBe(15000);
  /* Знімок: ціна до акції = priceTotal + знижка, і саме на момент створення. */
  expect(data.listPrice).toBe(50000);
  expect(data.promoIds).toEqual([promoId]);
});

it('без акції, що підійшла, listPrice дорівнює priceTotal, а promoIds порожній', async () => {
  const noPromoClub = { ...club, promos: [] };
  prisma.club.findFirst.mockResolvedValue(noPromoClub);

  const res = await book();
  expect(res.status).toBe(201);

  const { data } = prisma.booking.create.mock.calls[0][0];
  expect(data.priceTotal).toBe(50000);
  expect(data.listPrice).toBe(50000);
  expect(data.promoIds).toEqual([]);
  expect(data.promoNames).toEqual([]);
  expect(data.promoDiscount).toBe(0);
});
