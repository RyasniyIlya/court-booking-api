import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const prisma = {
  trainer: { findFirst: vi.fn() },
  trainerHours: { deleteMany: vi.fn(), createMany: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = {
      userId: 'user-1',
      clubId: 'club-1',
      role: 'TRAINER',
      level: 2,
      trainerId: 'trainer-1',
    };
    next();
  },
  requireStaff: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireLevel: () => (_req: unknown, _res: unknown, next: () => void) => next(),
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
