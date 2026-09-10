import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const prisma = {
  trainer: { findFirst: vi.fn() },
  trainerHours: { deleteMany: vi.fn(), createMany: vi.fn() },
  trainerScheduleException: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  user: { findUniqueOrThrow: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = {
      userId: 'user-1',
      clubId: 'club-1',
      role: 'TRAINER',
      trainerId: 'trainer-1',
    };
    next();
  },
  requireStaff: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  param: (req: { params: Record<string, string> }, name: string) => req.params[name],
}));

const { trainersRouter } = await import('./trainers');
const app = express().use(express.json()).use('/api/admin', trainersRouter);

const schedule = [
  { weekday: 1, openMinute: 540, closeMinute: 1080, isClosed: false },
  { weekday: 2, openMinute: 540, closeMinute: 1080, isClosed: false },
  { weekday: 3, openMinute: 540, closeMinute: 1080, isClosed: false },
  { weekday: 4, openMinute: 540, closeMinute: 1080, isClosed: false },
  { weekday: 5, openMinute: 0, closeMinute: 0, isClosed: true },
  { weekday: 6, openMinute: 0, closeMinute: 0, isClosed: true },
  { weekday: 0, openMinute: 0, closeMinute: 0, isClosed: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  prisma.trainer.findFirst.mockResolvedValue({ id: 'trainer-1' });
  prisma.trainerHours.deleteMany.mockResolvedValue({ count: 0 });
  prisma.trainerHours.createMany.mockResolvedValue({ count: 7 });
  prisma.$transaction.mockResolvedValue([]);
  prisma.trainerScheduleException.findMany.mockResolvedValue([]);
  prisma.trainerScheduleException.upsert.mockImplementation(async ({ create }) => ({ id: 'exception-1', ...create }));
  prisma.trainerScheduleException.deleteMany.mockResolvedValue({ count: 1 });
  prisma.user.findUniqueOrThrow.mockResolvedValue({ email: 'trainer@club.test' });
});

describe('календар винятків тренера', () => {
  it('зберігає відпустку на конкретну майбутню дату', async () => {
    const response = await request(app).put('/api/admin/trainer-schedule/me/2026-10-15')
      .send({ isClosed: true, intervals: [], note: 'Відпустка' });
    expect(response.status).toBe(200);
    expect(prisma.trainerScheduleException.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ isClosed: true, intervals: [], note: 'Відпустка', updatedBy: 'trainer@club.test' }),
    }));
  });

  it('зберігає розділений день і не приймає перетини', async () => {
    const good = await request(app).put('/api/admin/trainer-schedule/me/2026-10-16').send({
      isClosed: false, intervals: [{ startMinute: 540, endMinute: 720 }, { startMinute: 900, endMinute: 1080 }],
    });
    expect(good.status).toBe(200);
    const bad = await request(app).put('/api/admin/trainer-schedule/me/2026-10-16').send({
      isClosed: false, intervals: [{ startMinute: 540, endMinute: 800 }, { startMinute: 700, endMinute: 1080 }],
    });
    expect(bad.status).toBe(400);
  });

  it('зберігає години, коли тренер недоступний у конкретний день', async () => {
    const response = await request(app).put('/api/admin/trainer-schedule/me/2026-10-17').send({
      kind: 'UNAVAILABLE', intervals: [{ startMinute: 780, endMinute: 960 }], note: 'Лікар',
    });
    expect(response.status).toBe(200);
    expect(prisma.trainerScheduleException.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ kind: 'UNAVAILABLE', isClosed: false,
        intervals: [{ startMinute: 780, endMinute: 960 }] }),
    }));
  });

  it('застосовує одне налаштування до виділеного діапазону дат', async () => {
    const response = await request(app).put('/api/admin/trainer-schedule/me/range').send({
      from: '2026-10-19', to: '2026-10-21', kind: 'VACATION', intervals: [], note: 'Відпустка',
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, count: 3 });
    expect(prisma.trainerScheduleException.upsert).toHaveBeenCalledTimes(3);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('видаляє виняток і повертає звичайний тижневий графік', async () => {
    const response = await request(app).delete('/api/admin/trainer-schedule/me/2026-10-15');
    expect(response.status).toBe(200);
    expect(prisma.trainerScheduleException.deleteMany).toHaveBeenCalledWith({
      where: { trainerId: 'trainer-1', date: new Date('2026-10-15T00:00:00.000Z'), trainer: { clubId: 'club-1' } },
    });
  });
});

describe('PUT /api/admin/trainer-hours/me', () => {
  it('зберігає робочі й вихідні дні графіка тренера', async () => {
    const response = await request(app)
      .put('/api/admin/trainer-hours/me')
      .send(schedule);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(prisma.trainer.findFirst).toHaveBeenCalledWith({
      where: { id: 'trainer-1', clubId: 'club-1' },
      select: { id: true },
    });
    expect(prisma.trainerHours.createMany).toHaveBeenCalledWith({
      data: schedule.map((row) => ({ ...row, trainerId: 'trainer-1' })),
    });
  });

  it('не приймає два рядки для одного дня тижня', async () => {
    const response = await request(app)
      .put('/api/admin/trainer-hours/me')
      .send(schedule.map((row, index) => (index === 1 ? { ...row, weekday: 1 } : row)));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'BAD_REQUEST' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
