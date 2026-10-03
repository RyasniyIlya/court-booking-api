import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/** Р-7: тренер бачить про гравця тільки імʼя й телефон. */

const prisma = {
  booking: { findMany: vi.fn() },
  waitlistEntry: { findMany: vi.fn(async () => []) },
  changeLog: { findMany: vi.fn(async () => []) },
};
const auth = { role: 'ADMIN' };
vi.mock('../../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../../lib/notifyBooking', () => ({ notifyBooking: vi.fn(), notifySeriesCancelled: vi.fn() }));
vi.mock('../../lib/customers', async (orig) => ({
  ...(await orig<typeof import('../../lib/customers')>()),
  getActivePasses: vi.fn(async () => new Map()),
}));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: 'u', clubId: 'club', role: auth.role, trainerId: 'tr-1' }; next();
  },
  requireStaff: (_req: unknown, _res: unknown, next: () => void) => next(),
  hasFeature: () => true,
  param: (req: { params: Record<string, string> }, key: string) => req.params[key],
}));
const { bookingsRouter } = await import('./bookings');
const app = express().use(express.json()).use(bookingsRouter);
const get = () => request(app).get('/bookings').query({ from: '2030-01-01T00:00:00Z', to: '2030-01-02T00:00:00Z' });

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = 'ADMIN';
  prisma.booking.findMany.mockResolvedValue([{
    id: 'b1', courtId: 'c1', customerId: 'cu1', capacity: null, seats: [],
    startTime: new Date('2030-01-01T10:00:00Z'), endTime: new Date('2030-01-01T11:00:00Z'),
    customer: { id: 'cu1', name: 'Олег', phone: '+380671112233', telegramChatId: '555', isBlocked: true, note: 'скандаліст' },
  }]);
});

it('тренер: customer = лише імʼя й телефон', async () => {
  auth.role = 'TRAINER';
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.body[0].customer).toEqual({ name: 'Олег', phone: '+380671112233' });
  expect(res.body[0].reminderReachable).toBe(true);
  expect(JSON.stringify(res.body)).not.toContain('скандаліст');
  expect(JSON.stringify(res.body)).not.toContain('555');
});

it('адміністратор бачить усе як раніше', async () => {
  const res = await get();
  expect(res.body[0].customer).toMatchObject({ note: 'скандаліст', isBlocked: true, telegramChatId: '555' });
});
