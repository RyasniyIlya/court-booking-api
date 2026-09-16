import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const prisma = {
  booking: { findFirst: vi.fn(), update: vi.fn() },
  user: { findUniqueOrThrow: vi.fn(async () => ({ email: 'admin@club.test' })) },
};
vi.mock('../../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../../lib/notifyBooking', () => ({ notifyBooking: vi.fn(), notifySeriesCancelled: vi.fn() }));
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
const booking = {
  id: 'booking', clubId: 'club', capacity: null, status: 'PENDING', priceTotal: 50000,
  ledgerEntries: [], payment: null, expiresAt: null, trainerId: null,
  startTime: new Date('2030-01-01T10:00:00Z'), endTime: new Date('2030-01-01T11:00:00Z'),
};
beforeEach(() => { vi.clearAllMocks(); prisma.booking.findFirst.mockResolvedValue({ ...booking }); });
const confirm = () => request(app).patch('/bookings/booking').send({ status: 'CONFIRMED' });

it('lets the administrator approve a cash booking without inventing a payment', async () => {
  expect((await confirm()).status).toBe(200);
  expect(prisma.booking.update).toHaveBeenCalledWith({ where: { id: 'booking' }, data: expect.objectContaining({
    status: 'CONFIRMED', confirmedBy: 'admin@club.test',
  }) });
});
it.each([
  { expiresAt: new Date('2030-01-01T09:00:00Z') },
  { payment: { status: 'PENDING', amount: 50000 } },
])('does not bypass an outstanding online payment: %j', async extra => {
  prisma.booking.findFirst.mockResolvedValue({ ...booking, ...extra });
  expect((await confirm()).body.error).toBe('PAYMENT_REQUIRED');
  expect(prisma.booking.update).not.toHaveBeenCalled();
});
it('keeps an accepted unpaid booking confirmed when editing a note', async () => {
  prisma.booking.findFirst.mockResolvedValue({ ...booking, status: 'CONFIRMED' });
  expect((await request(app).patch('/bookings/booking').send({ comment: 'Cash on arrival' })).status).toBe(200);
  expect(prisma.booking.update).toHaveBeenCalledWith({ where: { id: 'booking' }, data: expect.objectContaining({ status: 'CONFIRMED' }) });
});
