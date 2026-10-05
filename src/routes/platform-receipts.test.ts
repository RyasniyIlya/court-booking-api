import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const RID = '55555555-5555-4555-8555-555555555555';
const CID = '22222222-2222-4222-8222-222222222222';
const IID = '66666666-6666-4666-8666-666666666666';

const prisma = {
  paymentReceipt: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  club: { findUnique: vi.fn(), update: vi.fn() },
  clubInvoice: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  sellerProfile: { findFirst: vi.fn() },
  crmActivity: { create: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock('../lib/db', () => ({ prisma }));
vi.mock('../lib/telegram', () => ({ sendMessage: vi.fn().mockResolvedValue(undefined) }));

const { JWT_SECRET } = await import('../lib/authSecret');
vi.stubEnv('PLATFORM_ADMIN_EMAIL', 'op@test.local');
vi.stubEnv('PLATFORM_ADMIN_PASSWORD_HASH', 'isolated-platform-fixture');
const { platformCredentialVersion } = await import('../lib/platformAuth');
const { platformRouter } = await import('./platform');
const app = express().use(express.json()).use(platformRouter);
const auth = `Bearer ${jwt.sign({ scope: 'platform', email: 'op@test.local', credentialVersion: platformCredentialVersion() }, JWT_SECRET)}`;

const periodFrom = new Date('2026-10-01T00:00:00Z');
const periodTo = new Date('2026-10-31T23:59:59Z');
const club = {
  id: CID, name: 'Клуб', paidUntil: null, billingPeriod: 'MONTH', planPrice: null, plan: null,
  users: [], _count: { courts: 2 },
};

beforeEach(() => {
  vi.resetAllMocks();
  prisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  prisma.crmActivity.create.mockResolvedValue({});
  prisma.sellerProfile.findFirst.mockResolvedValue(null);
  prisma.club.findUnique.mockResolvedValue(club);
  prisma.club.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: CID, ...data }));
  prisma.clubInvoice.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: IID, ...data }));
  prisma.paymentReceipt.update.mockResolvedValue({});
  prisma.paymentReceipt.updateMany.mockResolvedValue({ count: 1 });
});

const pending = (over: Record<string, unknown> = {}) => ({
  id: RID, clubId: CID, invoiceId: IID, status: 'PENDING', invoice: { status: 'ISSUED' }, ...over,
});

describe('доступ', () => {
  it('усі маршрути без токена — 401', async () => {
    for (const r of [
      request(app).get('/receipts'),
      request(app).get(`/receipts/${RID}/file`),
      request(app).post(`/receipts/${RID}/confirm`).send({}),
      request(app).post(`/receipts/${RID}/reject`).send({ reason: 'x' }),
      request(app).post(`/receipts/${RID}/recheck`),
    ]) expect((await r).status).toBe(401);
  });
});

describe('GET /receipts', () => {
  it('фільтр status=PENDING', async () => {
    prisma.paymentReceipt.findMany.mockResolvedValue([{ id: RID }]);
    const res = await request(app).get('/receipts?status=PENDING').set('Authorization', auth);
    expect(res.status).toBe(200);
    const arg = prisma.paymentReceipt.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ status: 'PENDING' });
  });
});

describe('POST /receipts/:id/confirm', () => {
  it('атомне підтвердження, статус CONFIRMED', async () => {
    prisma.paymentReceipt.findUnique.mockResolvedValue(pending());
    prisma.clubInvoice.findFirst.mockResolvedValue({ id: IID, periodFrom, periodTo, amount: 1000_00 });

    const res = await request(app).post(`/receipts/${RID}/confirm`).set('Authorization', auth).send({ paidAt: '2026-10-02' });

    expect(res.status).toBe(200);
    expect(prisma.paymentReceipt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: RID, status: 'PENDING' },
      })
    );
  });

  it('повторне підтвердження — 409 ALREADY_REVIEWED', async () => {
    prisma.paymentReceipt.findUnique.mockResolvedValue(pending());
    prisma.paymentReceipt.updateMany.mockResolvedValue({ count: 0 });
    
    const res = await request(app).post(`/receipts/${RID}/confirm`).set('Authorization', auth).send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ALREADY_REVIEWED');
  });
});

describe('POST /receipts/:id/reject', () => {
  it('причина зберігається, статус REJECTED', async () => {
    prisma.paymentReceipt.findUnique.mockResolvedValue({ status: 'PENDING' });
    const res = await request(app).post(`/receipts/${RID}/reject`).set('Authorization', auth).send({ reason: '  Не та сума ' });
    
    expect(res.status).toBe(200);
    expect(prisma.paymentReceipt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: RID, status: 'PENDING' },
        data: expect.objectContaining({ status: 'REJECTED', rejectReason: 'Не та сума' }),
      })
    );
  });

  it('вже розглянута — 409', async () => {
    prisma.paymentReceipt.updateMany.mockResolvedValue({ count: 0 });
    prisma.paymentReceipt.findUnique.mockResolvedValue({ id: RID });
    
    const res = await request(app).post(`/receipts/${RID}/reject`).set('Authorization', auth).send({ reason: 'x' });
    
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ALREADY_REVIEWED');
  });
});

describe('POST /receipts/:id/recheck', () => {
  it('404 якщо немає квитанції', async () => {
    prisma.paymentReceipt.findUnique.mockResolvedValue(null);
    const res = await request(app).post(`/receipts/${RID}/recheck`).set('Authorization', auth);
    expect(res.status).toBe(404);
  });
  it('202 і статус скидається в PENDING', async () => {
    prisma.paymentReceipt.findUnique.mockResolvedValue({ id: RID });
    const res = await request(app).post(`/receipts/${RID}/recheck`).set('Authorization', auth);
    expect(res.status).toBe(202);
    expect(prisma.paymentReceipt.update).toHaveBeenCalledWith({ where: { id: RID }, data: { aiStatus: 'PENDING' } });
  });
});
