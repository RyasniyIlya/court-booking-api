import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';

const prisma = {
  clubGroup: { findUnique: vi.fn(), findMany: vi.fn() },
  club: { updateMany: vi.fn(), update: vi.fn() },
  clubInvoice: { create: vi.fn() },
  crmActivity: { create: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock('../lib/db', () => ({ prisma }));
vi.mock('../lib/telegram', () => ({ sendMessage: vi.fn() }));

process.env.PLATFORM_ADMIN_EMAIL = 'operator@test.local';
process.env.PLATFORM_ADMIN_PASSWORD_HASH = bcrypt.hashSync('operator-password', 4);

const { platformRouter } = await import('./platform');
const app = express().use(express.json()).use(platformRouter);
const groupId = '11111111-1111-4111-8111-111111111111';
const clubId = '22222222-2222-4222-8222-222222222222';
let authorization = '';

beforeAll(async () => {
  const login = await request(app).post('/login').send({
    email: 'operator@test.local', password: 'operator-password',
  });
  authorization = `Bearer ${login.body.token}`;
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.clubGroup.findUnique.mockResolvedValue({ id: groupId });
  prisma.club.updateMany.mockResolvedValue({ count: 2 });
  prisma.$transaction.mockImplementation(async (operations: unknown[]) => Promise.all(operations));
  prisma.clubInvoice.create.mockResolvedValue({ id: 'invoice' });
  prisma.club.update.mockResolvedValue({ id: clubId });
});

it('requires platform authentication for network-wide settings', async () => {
  expect((await request(app).patch(`/groups/${groupId}/settings`).send({ paidUntil: '2026-12-31' })).status).toBe(401);
  expect(prisma.club.updateMany).not.toHaveBeenCalled();
});

it('applies plan and paid time only to clubs in the selected network', async () => {
  const planId = '33333333-3333-4333-8333-333333333333';
  const response = await request(app)
    .patch(`/groups/${groupId}/settings`)
    .set('Authorization', authorization)
    .send({ planId, paidUntil: '2026-12-31' });

  expect(response.status).toBe(200);
  expect(response.body.updated).toBe(2);
  expect(prisma.club.updateMany).toHaveBeenCalledWith({
    where: { groupId },
    data: { planId, paidUntil: new Date('2026-12-31T23:59:59.999Z') },
  });
});

it('creates a paid period for every club in a network atomically', async () => {
  prisma.clubGroup.findUnique.mockResolvedValue({
    name: 'Мережа',
    clubs: [{
      id: clubId, paidUntil: null, billingPeriod: 'MONTH', planPrice: 50000, plan: null,
      _count: { courts: 2 },
    }],
  });
  const response = await request(app)
    .post(`/groups/${groupId}/subscription`)
    .set('Authorization', authorization)
    .send({ period: 'MONTH', amount: 70000, method: 'transfer' });

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ updated: 1, totalAmount: 70000 });
  expect(prisma.$transaction).toHaveBeenCalledOnce();
  expect(prisma.clubInvoice.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ clubId, amount: 70000, status: 'PAID', method: 'transfer' }),
  });
});
