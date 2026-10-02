import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * findOrCreateCustomer перезаписує пошту картки. Тому при невірній даті
 * народження для гостя він не має викликатись узагалі: інакше чужий номер
 * дозволяє змінити пошту стороннього, і лише потім прийде BIRTH_DATE_MISMATCH.
 */

const prisma = { club: { findFirst: vi.fn() }, block: { findFirst: vi.fn() }, customer: { findUnique: vi.fn(), upsert: vi.fn() },
  booking: { create: vi.fn() }, payment: { create: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)) };
const findOrCreateCustomer = vi.fn(async () => ({
  id: 'customer', isBlocked: false, requiresPrepay: false, discountPercent: 0,
  birthDate: new Date('1990-01-01T00:00:00.000Z'),
}));
vi.mock('../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../lib/payments', () => ({ providerFor: () => null, publicBase: () => 'https://api.test' }));
vi.mock('../lib/notifyBooking', () => ({ notifyBooking: vi.fn() }));
vi.mock('../lib/billing', () => ({ clubBilling: () => ({ online: true }) }));
vi.mock('../lib/customers', async (orig) => ({
  ...(await orig<typeof import('../lib/customers')>()),
  findOrCreateCustomer,
}));
const { publicRouter } = await import('./public');
const app = express().use(express.json()).use(publicRouter);

const courtId = '11111111-1111-4111-8111-111111111111';
const club = { id: 'club', slug: 'demo', timezone: 'UTC', leadTimeMinutes: 0, slotMinutes: 60,
  prepayEnabled: false, prepayRequired: true, autoConfirm: true, promos: [], trainers: [],
  courts: [{ id: courtId, pricePerHour: 50000 }],
  hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, openMinute: 0, closeMinute: 1440, isClosed: false })) };

const book = (birthDate: string) => request(app).post('/clubs/demo/bookings').send({
  courtId, payChoice: 'onsite',
  start: '2030-01-01T10:00:00Z', end: '2030-01-01T11:00:00Z',
  customerName: 'Player', customerPhone: '+380671112233', customerEmail: 'attacker@example.com', birthDate,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.club.findFirst.mockResolvedValue(club);
  prisma.block.findFirst.mockResolvedValue(null);
  prisma.booking.create.mockImplementation(async ({ data }) => ({ ...data, id: 'booking', cancelToken: 'cancel' }));
  prisma.payment.create.mockResolvedValue({});
});

it('невірна дата народження: 403 і жодного запису в картку', async () => {
  prisma.customer.findUnique.mockResolvedValue({ id: 'c1', passwordHash: null, birthDate: new Date('1990-01-01T00:00:00.000Z') });
  const res = await book('1991-02-02');
  expect(res.status).toBe(403);
  expect(res.body).toEqual({ error: 'BIRTH_DATE_MISMATCH' });
  expect(findOrCreateCustomer).not.toHaveBeenCalled();
  expect(prisma.customer.upsert).not.toHaveBeenCalled();
  expect(prisma.booking.create).not.toHaveBeenCalled();
});

it('вірна дата народження: картка оновлюється як раніше', async () => {
  prisma.customer.findUnique.mockResolvedValue({ id: 'c1', passwordHash: null, birthDate: new Date('1990-01-01T00:00:00.000Z') });
  const res = await book('1990-01-01');
  expect(res.status).toBe(201);
  expect(findOrCreateCustomer).toHaveBeenCalledTimes(1);
});

it('картка без дати народження: пре-перевірка не блокує', async () => {
  prisma.customer.findUnique.mockResolvedValue({ id: 'c1', passwordHash: null, birthDate: null });
  await book('1990-01-01');
  expect(findOrCreateCustomer).toHaveBeenCalledTimes(1);
});
