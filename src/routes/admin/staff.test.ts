import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * POST /admin/staff — межа ролі ACCOUNTANT: тільки OWNER заводить, і
 * лише клубу з планом «Аналітика» (акаунт без нього впирався б у 402 на
 * кожному запиті фінансів).
 */

const prisma = {
  user: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  club: { findUnique: vi.fn() },
};
vi.mock('../../lib/db', () => ({ prisma }));

const { staffRouter } = await import('./staff');
const { signToken } = await import('./shared');
const app = express().use(express.json()).use(staffRouter);

const clubId = '22222222-2222-4222-8222-222222222222';
const ownerId = '44444444-4444-4444-8444-444444444444';
const adminId = '55555555-5555-4555-8555-555555555555';

function auth(userId: string, role: string) {
  prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id?: string; email?: string } }) =>
    (where.id === userId ? { id: userId, clubId, role, trainerId: null, passwordHash: 'test-hash' } : null));
  return `Bearer ${signToken({ userId, clubId, role, trainerId: null }, '1h', 'test-hash')}`;
}

const post = (body: object, header: string) => request(app).post('/staff').set('Authorization', header).send(body);

beforeEach(() => {
  vi.resetAllMocks();
  prisma.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new-id', ...data }));
  prisma.club.findUnique.mockResolvedValue({ plan: { featTrainers: false, featGroups: false, featAnalytics: true, tier: 3 } });
});

const body = { email: 'buh@club.test', name: 'Ольга Бухгалтер', password: 'password123', role: 'ACCOUNTANT' };

it('власник заводить бухгалтера клубу з планом «Аналітика»', async () => {
  const res = await post(body, auth(ownerId, 'OWNER'));
  expect(res.status).toBe(201);
  expect(res.body.role).toBe('ACCOUNTANT');
  expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ clubId, role: 'ACCOUNTANT' }),
  }));
});

it('модератор бухгалтера не заводить — це не TRAINER', async () => {
  const res = await post(body, auth(adminId, 'ADMIN'));
  expect(res.status).toBe(403);
  expect(prisma.user.create).not.toHaveBeenCalled();
});

it('без плану «Аналітика» — 402, а не мовчазне створення непотрібного акаунта', async () => {
  prisma.club.findUnique.mockResolvedValue({ plan: { featTrainers: false, featGroups: false, featAnalytics: false, tier: 1 } });
  const res = await post(body, auth(ownerId, 'OWNER'));
  expect(res.status).toBe(402);
  expect(res.body).toEqual({ error: 'PLAN_REQUIRED', feature: 'analytics' });
  expect(prisma.user.create).not.toHaveBeenCalled();
});

it("імʼя обовʼязкове — так само, як для модератора", async () => {
  const res = await post({ ...body, name: undefined }, auth(ownerId, 'OWNER'));
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: 'NAME_REQUIRED' });
});
