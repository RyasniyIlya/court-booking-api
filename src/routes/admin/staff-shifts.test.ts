import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const prisma = {
  user: { findFirst: vi.fn(), findMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  staffHours: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  staffShift: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(),
};

/* Роль і id того, хто стукає. Міняємо між тестами — весь сенс файлу саме
   в тому, хто що може. */
const auth = { userId: 'owner-1', clubId: 'club-1', role: 'OWNER', trainerId: null as string | null };

vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => { req.auth = auth; next(); },
  requireRole: (...roles: string[]) => (
    _req: unknown,
    res: { status: (c: number) => { json: (b: unknown) => unknown } },
    next: () => void,
  ) => (roles.includes(auth.role) ? next() : res.status(403).json({ error: 'FORBIDDEN' })),
  param: (req: { params: Record<string, string> }, name: string) => req.params[name],
}));

const { staffShiftsRouter } = await import('./staff-shifts');
const app = express().use(express.json()).use('/api/admin', staffShiftsRouter);

const MOD = '11111111-1111-4111-8111-111111111111';
const week = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday, openMinute: 540, closeMinute: 1080, isClosed: weekday === 0,
}));

beforeEach(() => {
  vi.clearAllMocks();
  auth.userId = 'owner-1';
  auth.role = 'OWNER';
  prisma.user.findFirst.mockResolvedValue({ id: MOD, email: 'moder@club.test', name: 'Оля', role: 'ADMIN' });
  prisma.user.findUniqueOrThrow.mockResolvedValue({ email: 'owner@club.test' });
  prisma.staffHours.findMany.mockResolvedValue([]);
  prisma.staffShift.findMany.mockResolvedValue([]);
  prisma.staffShift.deleteMany.mockResolvedValue({ count: 1 });
  prisma.staffHours.deleteMany.mockResolvedValue({ count: 7 });
  prisma.staffShift.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
    id: 'shift-1', ...create,
  }));
  prisma.$transaction.mockResolvedValue([]);
});

describe('графік змін: хто може його правити', () => {
  it('власник ставить тижневий шаблон', async () => {
    const r = await request(app).put(`/api/admin/staff/${MOD}/shifts/hours`).send({ hours: week });
    expect(r.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each(['ADMIN', 'TRAINER'])('%s не може переписати графік — ні свій, ні чужий', async (role) => {
    auth.role = role;
    auth.userId = MOD;

    for (const call of [
      request(app).put(`/api/admin/staff/${MOD}/shifts/hours`).send({ hours: week }),
      request(app).put(`/api/admin/staff/${MOD}/shifts/2026-09-21`).send({ kind: 'DAY_OFF', intervals: [] }),
      request(app).delete(`/api/admin/staff/${MOD}/shifts/2026-09-21`),
      request(app).delete(`/api/admin/staff/${MOD}/shifts/hours`),
    ]) {
      expect((await call).status).toBe(403);
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.staffShift.upsert).not.toHaveBeenCalled();
  });

  it('модератор читає свій табель, але не чужий', async () => {
    auth.role = 'ADMIN';
    auth.userId = MOD;
    const mine = await request(app).get(`/api/admin/staff/${MOD}/shifts?from=2026-09-01&to=2026-09-30`);
    expect(mine.status).toBe(200);
    /* Кабінет має знати, що кнопок правки малювати не треба. */
    expect(mine.body.canEdit).toBe(false);

    const other = await request(app)
      .get('/api/admin/staff/22222222-2222-4222-8222-222222222222/shifts?from=2026-09-01&to=2026-09-30');
    expect(other.status).toBe(403);
  });
});

describe('графік змін: що саме зберігається', () => {
  it('вихідний скидає інтервали й записує автора', async () => {
    const r = await request(app)
      .put(`/api/admin/staff/${MOD}/shifts/2026-09-21`)
      .send({ kind: 'VACATION', intervals: [{ startMinute: 540, endMinute: 1080 }], note: 'Відпустка' });

    expect(r.status).toBe(200);
    expect(prisma.staffShift.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ kind: 'VACATION', isClosed: true, intervals: [], updatedBy: 'owner@club.test' }),
    }));
  });

  it('не приймає зміну, що накладається сама на себе', async () => {
    const r = await request(app).put(`/api/admin/staff/${MOD}/shifts/2026-09-21`).send({
      kind: 'WORKING',
      intervals: [{ startMinute: 540, endMinute: 900 }, { startMinute: 800, endMinute: 1080 }],
    });
    expect(r.status).toBe(400);
    expect(prisma.staffShift.upsert).not.toHaveBeenCalled();
  });

  it('робочий день без жодного інтервалу — не день, а помилка', async () => {
    const r = await request(app).put(`/api/admin/staff/${MOD}/shifts/2026-09-21`)
      .send({ kind: 'WORKING', intervals: [] });
    expect(r.status).toBe(400);
  });

  it('не веде табель для тренера — у нього свій графік на картці', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const r = await request(app).put(`/api/admin/staff/${MOD}/shifts/hours`).send({ hours: week });
    expect(r.status).toBe(404);
  });

  it('стирає день лише в межах свого клубу', async () => {
    await request(app).delete(`/api/admin/staff/${MOD}/shifts/2026-09-21`);
    expect(prisma.staffShift.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ user: { clubId: 'club-1' } }),
    });
  });
});

describe('табель на день', () => {
  it('збирає всіх, хто веде клуб, і рахує години', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'owner-1', name: null, email: 'owner@club.test', role: 'OWNER',
        shiftHours: week, shiftExceptions: [],
      },
      {
        id: MOD, name: 'Оля', email: 'moder@club.test', role: 'ADMIN',
        shiftHours: week,
        shiftExceptions: [{ date: new Date('2026-09-21T00:00:00.000Z'), isClosed: true, kind: 'DAY_OFF', intervals: [], note: 'Підміна' }],
      },
    ]);

    const r = await request(app).get('/api/admin/staff-shifts?date=2026-09-21');
    expect(r.status).toBe(200);
    expect(r.body.roster).toEqual([
      expect.objectContaining({ id: 'owner-1', kind: 'WORKING', minutes: 540, source: 'weekly' }),
      expect.objectContaining({ id: MOD, kind: 'DAY_OFF', minutes: 0, note: 'Підміна' }),
    ]);
  });

  it('модератор теж бачить, хто сьогодні на зміні', async () => {
    auth.role = 'ADMIN';
    prisma.user.findMany.mockResolvedValue([]);
    expect((await request(app).get('/api/admin/staff-shifts?date=2026-09-21')).status).toBe(200);
  });
});
