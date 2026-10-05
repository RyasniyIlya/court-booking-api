import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/** Оператор: партнери, привʼязка клубу, виплати. */

const PID = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';

const prisma = {
  partner: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  partnerPayout: { findMany: vi.fn(), create: vi.fn() },
  club: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  crmActivity: { create: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock('../lib/db', () => ({ prisma }));

const { JWT_SECRET } = await import('../lib/authSecret');
vi.stubEnv('PLATFORM_ADMIN_EMAIL', 'op@test.local');
vi.stubEnv('PLATFORM_ADMIN_PASSWORD_HASH', 'isolated-platform-fixture');
const { platformCredentialVersion } = await import('../lib/platformAuth');
const { platformRouter } = await import('./platform');
const app = express().use(express.json()).use(platformRouter);
const auth = `Bearer ${jwt.sign({ scope: 'platform', email: 'op@test.local', credentialVersion: platformCredentialVersion() }, JWT_SECRET)}`;

const row = { id: PID, name: 'П', company: null, email: 'p@x.ua', phone: null, refCode: 'abcd2345', rateFirstYear: 50, rateAfter: 20, isActive: true, note: null, pinLockedUntil: null, createdAt: new Date(), _count: { clubs: 1, leads: 2 } };

beforeEach(() => {
  vi.resetAllMocks();
  prisma.$transaction.mockImplementation(async (fn: (t: typeof prisma) => unknown) => fn(prisma));
  prisma.crmActivity.create.mockResolvedValue({});
});

describe('оператор: партнери', () => {
  it('усі маршрути без токена — 401', async () => {
    for (const r of [
      request(app).get('/partners'), request(app).post('/partners').send({}),
      request(app).patch(`/partners/${PID}`).send({}), request(app).post(`/partners/${PID}/password`),
      request(app).patch(`/clubs/${CID}/partner`).send({ partnerId: null }),
      request(app).get(`/partners/${PID}/commissions`), request(app).post(`/partners/${PID}/payouts`).send({}),
    ]) expect((await r).status).toBe(401);
  });

  it('POST /partners: тимчасовий пароль один раз, хеш у базу, refCode 8 символів', async () => {
    prisma.partner.create.mockResolvedValue(row);
    const res = await request(app).post('/partners').set('Authorization', auth).send({ name: 'Партнер', email: 'P@x.ua' });
    expect(res.status).toBe(201);
    expect(res.body.tempPassword).toEqual(expect.any(String));
    const data = prisma.partner.create.mock.calls[0][0].data;
    expect(data.email).toBe('p@x.ua');
    expect(data.passwordHash).not.toBe(res.body.tempPassword);
    expect(data.refCode).toMatch(/^[a-z0-9]{8}$/);
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  it('POST /partners: дубль email — 409', async () => {
    prisma.partner.create.mockRejectedValue({ code: 'P2002' });
    prisma.partner.findUnique.mockResolvedValue({ id: 'x' });
    const res = await request(app).post('/partners').set('Authorization', auth).send({ name: 'Партнер', email: 'p@x.ua' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'EMAIL_ALREADY_EXISTS' });
  });

  it('PATCH /partners/:id: ставки й активність; чужі поля відхиляються', async () => {
    prisma.partner.findUnique.mockResolvedValue({ id: PID });
    prisma.partner.update.mockResolvedValue(row);
    const ok = await request(app).patch(`/partners/${PID}`).set('Authorization', auth).send({ rateFirstYear: 40, isActive: false });
    expect(ok.status).toBe(200);
    expect(prisma.partner.update.mock.calls[0][0].data).toEqual({ rateFirstYear: 40, isActive: false });
    const bad = await request(app).patch(`/partners/${PID}`).set('Authorization', auth).send({ passwordHash: 'x' });
    expect(bad.status).toBe(400);
    const range = await request(app).patch(`/partners/${PID}`).set('Authorization', auth).send({ rateAfter: 101 });
    expect(range.status).toBe(400);
  });

  it('POST /partners/:id/password: новий тимчасовий пароль, скидання блокування', async () => {
    prisma.partner.findUnique.mockResolvedValue({ id: PID });
    prisma.partner.update.mockResolvedValue({});
    const res = await request(app).post(`/partners/${PID}/password`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.tempPassword).toHaveLength(12);
    expect(prisma.partner.update.mock.calls[0][0].data).toMatchObject({ pinFails: 0, pinLockedUntil: null });
  });

  it('PATCH /clubs/:id/partner: привʼязка ставить дату і пише SYSTEM; null знімає', async () => {
    prisma.club.findUnique.mockResolvedValue({ id: CID });
    prisma.partner.findUnique.mockResolvedValue({ id: PID, name: 'П', company: 'ТОВ Буд' });
    prisma.club.update.mockResolvedValue({});
    const on = await request(app).patch(`/clubs/${CID}/partner`).set('Authorization', auth).send({ partnerId: PID });
    expect(on.status).toBe(200);
    const d = prisma.club.update.mock.calls[0][0].data;
    expect(d.partnerId).toBe(PID);
    expect(d.partnerAttachedAt).toBeInstanceOf(Date);
    expect(prisma.crmActivity.create.mock.calls[0][0].data).toMatchObject({ clubId: CID, kind: 'SYSTEM' });

    prisma.club.update.mockClear();
    const off = await request(app).patch(`/clubs/${CID}/partner`).set('Authorization', auth).send({ partnerId: null });
    expect(off.status).toBe(200);
    expect(prisma.club.update.mock.calls[0][0].data).toEqual({ partnerId: null, partnerAttachedAt: null });
  });

  it('PATCH /clubs/:id/partner: невідомий партнер — 404', async () => {
    prisma.club.findUnique.mockResolvedValue({ id: CID });
    prisma.partner.findUnique.mockResolvedValue(null);
    const res = await request(app).patch(`/clubs/${CID}/partner`).set('Authorization', auth).send({ partnerId: PID });
    expect(res.status).toBe(404);
    expect(prisma.club.update).not.toHaveBeenCalled();
  });

  it('GET /partners/:id/commissions і POST payouts', async () => {
    prisma.partner.findUnique.mockResolvedValue({ rateFirstYear: 50, rateAfter: 20, id: PID });
    prisma.club.findMany.mockResolvedValue([{
      id: CID, name: 'К', partnerAttachedAt: new Date('2026-01-01T00:00:00Z'),
      invoices: [{ id: 'i1', clubId: CID, amount: 100000, status: 'PAID', paidAt: new Date('2026-02-01T00:00:00Z') }],
    }]);
    prisma.partnerPayout.findMany.mockResolvedValue([]);
    const c = await request(app).get(`/partners/${PID}/commissions`).set('Authorization', auth);
    expect(c.status).toBe(200);
    expect(c.body.totals).toEqual({ accrued: 50000, paid: 0, due: 50000 });

    prisma.partnerPayout.create.mockResolvedValue({ id: 'p1', amount: 20000, paidAt: new Date(), note: null });
    const p = await request(app).post(`/partners/${PID}/payouts`).set('Authorization', auth).send({ amount: 20000, paidAt: '2026-05-01' });
    expect(p.status).toBe(201);
    expect(prisma.partnerPayout.create.mock.calls[0][0].data).toMatchObject({ partnerId: PID, amount: 20000 });
    const bad = await request(app).post(`/partners/${PID}/payouts`).set('Authorization', auth).send({ amount: -5 });
    expect(bad.status).toBe(400);
  });
});
