import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Відмітка приходу — межі доступу й вхідних даних. Щасливий шлях тут
 * найменш цікавий: цікаво, що НЕ проходить.
 */

const prisma = {
  user: { findUniqueOrThrow: vi.fn(async () => ({ email: 'admin@club.test' })) },
  booking: { findFirst: vi.fn(), update: vi.fn(async ({ data }: { data: unknown }) => data) },
};
const auth = { userId: 'u1', clubId: 'club-1', role: 'ADMIN', trainerId: null as string | null };

vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => { req.auth = { ...auth }; next(); },
  param: (req: { params: Record<string, string> }, name: string) => req.params[name],
}));

const { attendanceRouter } = await import('./attendance');
const app = express().use(express.json()).use('/api/admin', attendanceRouter);

const ID = '11111111-1111-4111-8111-111111111111';
const started = () => ({
  id: ID, status: 'CONFIRMED', capacity: null, trainerId: 't1',
  startTime: new Date(Date.now() - 5 * 60_000),
});
const patch = (body: unknown, id = ID) =>
  request(app).patch(`/api/admin/bookings/${id}/attendance`).send(body as object);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(auth, { role: 'ADMIN', trainerId: null });
  prisma.booking.findFirst.mockResolvedValue(started());
});

describe('PATCH /bookings/:id/attendance', () => {
  it('відмічає прихід і записує, хто відмітив', async () => {
    const res = await patch({ attendance: 'ARRIVED' });
    expect(res.status).toBe(200);
    expect(prisma.booking.update.mock.calls[0][0].data).toMatchObject({ attendance: 'ARRIVED', attendanceBy: 'admin@club.test' });
    expect(prisma.booking.findFirst.mock.calls[0][0].where).toEqual({ id: ID, clubId: 'club-1' });
  });

  it('відкидає значення поза білим списком і зайві поля', async () => {
    expect((await patch({ attendance: 'PAID' })).status).toBe(400);
    expect((await patch({ attendance: 'ARRIVED', status: 'CONFIRMED' })).status).toBe(400);
    expect((await patch({ attendance: 'ARRIVED' }, 'not-a-uuid')).status).toBe(400);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  it('тренер не відмічає чуже заняття', async () => {
    Object.assign(auth, { role: 'TRAINER', trainerId: 'other' });
    expect((await patch({ attendance: 'ARRIVED' })).status).toBe(404);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  it('скасована бронь — 409', async () => {
    prisma.booking.findFirst.mockResolvedValue({ ...started(), status: 'CANCELLED' });
    const res = await patch({ attendance: 'NO_SHOW' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('BOOKING_CLOSED');
  });

  it('скидання стирає автора й час', async () => {
    await patch({ attendance: 'UNKNOWN' });
    expect(prisma.booking.update.mock.calls[0][0].data).toEqual({ attendance: 'UNKNOWN', attendanceAt: null, attendanceBy: null });
  });
});
