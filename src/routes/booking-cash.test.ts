import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
const prisma = { club: { findFirst: vi.fn() }, block: { findFirst: vi.fn() }, customer: { findUnique: vi.fn() }, booking: { create: vi.fn() } };
const providerFor = vi.fn(() => null);
const notifyBooking = vi.fn();
vi.mock('../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../lib/payments', () => ({ providerFor, publicBase: () => 'https://api.test' }));
vi.mock('../lib/notifyBooking', () => ({ notifyBooking }));
vi.mock('../lib/billing', () => ({ clubBilling: () => ({ online: true }) }));
vi.mock('../lib/customers', async orig => ({ ...(await orig<typeof import('../lib/customers')>()), findOrCreateCustomer: vi.fn(async () => null) }));
const { publicRouter } = await import('./public');
const app = express().use(express.json()).use(publicRouter);
const courtId = '11111111-1111-4111-8111-111111111111';
const club = { id: 'club', slug: 'demo', timezone: 'UTC', leadTimeMinutes: 0, slotMinutes: 60,
  prepayEnabled: true, prepayRequired: false, autoConfirm: true, promos: [], trainers: [],
  courts: [{ id: courtId, pricePerHour: 50000 }],
  hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, openMinute: 0, closeMinute: 1440, isClosed: false })) };
beforeEach(() => {
  vi.clearAllMocks();
  prisma.club.findFirst.mockResolvedValue(club);
  prisma.block.findFirst.mockResolvedValue(null);
  prisma.customer.findUnique.mockResolvedValue(null);
  prisma.booking.create.mockImplementation(async ({ data }) => ({ ...data, id: 'booking', cancelToken: 'cancel' }));
});
const book = (payChoice: string) => request(app).post('/clubs/demo/bookings').send({ courtId, payChoice,
  start: '2030-01-01T10:00:00Z', end: '2030-01-01T11:00:00Z', customerName: 'Player', customerPhone: '+380671112233', birthDate: '1990-01-01' });
it('holds a cash booking for administrator review even when online payments are unavailable', async () => {
  const res = await book('onsite');
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('PENDING');
  expect(providerFor).toHaveBeenCalledOnce();
  expect(prisma.booking.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'PENDING', expiresAt: null, courtId }) });
  expect(notifyBooking).toHaveBeenCalled();
});
it('falls back to an onsite request when online payment is unavailable', async () => {
  const res = await book('online');
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('PENDING');
  expect(prisma.booking.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'PENDING', expiresAt: null, courtId }) });
  expect(notifyBooking).toHaveBeenCalled();
});
