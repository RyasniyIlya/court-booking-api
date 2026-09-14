import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Порядок кортів і тренерів. Цікаві межі: чужий id, неповний список,
 * дублі — у всіх випадках база не має змінитись ні на рядок.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

const prisma = {
  court: { findMany: vi.fn(), update: vi.fn((args: unknown) => args) },
  trainer: { findMany: vi.fn(), update: vi.fn((args: unknown) => args) },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
};
const auth = { role: 'OWNER' };

vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: 'u1', clubId: 'club-1', role: auth.role, trainerId: null };
    next();
  },
  requireStaff: (req: { auth: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    req.auth.role === 'TRAINER' ? res.status(403).json({ error: 'FORBIDDEN' }) : next(),
  requireFeature: () => (_q: unknown, _s: unknown, next: () => void) => next(),
}));

const { orderingRouter } = await import('./ordering');
const app = express().use(express.json()).use('/api/admin', orderingRouter);
const put = (path: string, body: unknown) => request(app).put(`/api/admin${path}`).send(body as object);

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = 'OWNER';
  prisma.court.findMany.mockResolvedValue([{ id: A }, { id: B }, { id: C }]);
  prisma.trainer.findMany.mockResolvedValue([{ id: A }, { id: B }]);
});

describe('PUT /courts/order', () => {
  it('записує номери за позицією в списку, одною транзакцією, тільки в межах клубу', async () => {
    const res = await put('/courts/order', { ids: [C, A, B] });
    expect(res.status).toBe(200);
    expect(prisma.court.findMany.mock.calls[0][0].where).toEqual({ clubId: 'club-1' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.court.update.mock.calls.map((c) => [c[0].where.id, c[0].data.sortOrder])).toEqual([[C, 0], [A, 1], [B, 2]]);
  });

  it('неповний список або чужий id — 409 і жодного запису', async () => {
    expect((await put('/courts/order', { ids: [A, B] })).status).toBe(409);
    expect((await put('/courts/order', { ids: [A, B, '44444444-4444-4444-8444-444444444444'] })).status).toBe(409);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('дублі, не-uuid і зайві поля — 400', async () => {
    expect((await put('/courts/order', { ids: [A, A, B] })).status).toBe(400);
    expect((await put('/courts/order', { ids: ['1; DROP TABLE'] })).status).toBe(400);
    expect((await put('/courts/order', { ids: [A, B, C], clubId: 'other' })).status).toBe(400);
    expect(prisma.court.findMany).not.toHaveBeenCalled();
  });

  it('тренер порядок не змінює', async () => {
    auth.role = 'TRAINER';
    expect((await put('/courts/order', { ids: [A, B, C] })).status).toBe(403);
  });
});

describe('PUT /trainers/order', () => {
  it('працює так само для тренерів', async () => {
    const res = await put('/trainers/order', { ids: [B, A] });
    expect(res.status).toBe(200);
    expect(prisma.trainer.update.mock.calls.map((c) => c[0].data.sortOrder)).toEqual([0, 1]);
    expect(prisma.court.update).not.toHaveBeenCalled();
  });
});
