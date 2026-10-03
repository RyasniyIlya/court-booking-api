import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/** Ю-6, Р-2: оферта клубу й юридичні реквізити. */

const prisma = { club: { findUnique: vi.fn(), update: vi.fn() }, payment: { count: vi.fn() } };
const state = { role: 'OWNER' };
vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('../../lib/payments', () => ({ KNOWN_PROVIDERS: ['mono', 'mock'], providerFor: vi.fn(), publicBase: () => 'http://localhost' }));
vi.mock('../../lib/crypto', () => ({ encryptSecret: () => 'encrypted', paymentsSecretReady: () => true }));
vi.mock('../public', () => ({ logoSrcOf: () => null }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => { req.auth = { clubId: 'club', role: state.role }; next(); },
  requireStaff: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: (...roles: string[]) => (req: { auth: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    roles.includes(req.auth.role) ? next() : res.status(403).json({ error: 'FORBIDDEN' }),
}));
const { clubRouter } = await import('./club');
const app = express().use(express.json()).use(clubRouter);

const row = {
  id: 'club', offerAcceptedAt: null, offerVersion: null, legalName: 'ФОП Іваненко', legalCode: '1234567890',
  legalAddress: 'Київ', email: 'a@b.ua', lateCancelFeePercent: 50, refundDays: 7, extraRules: null,
  prepayEnabled: false, paymentProvider: null, paymentTokenEnc: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.role = 'OWNER';
  prisma.club.findUnique.mockResolvedValue(row);
  prisma.club.update.mockResolvedValue(row);
});

it('GET віддає юридичні поля й поточну версію документів', async () => {
  const body = (await request(app).get('/club')).body;
  expect(body).toMatchObject({
    offerAcceptedAt: null, offerVersion: null, legalVersion: '2026-09', legalName: 'ФОП Іваненко',
    legalCode: '1234567890', legalAddress: 'Київ', email: 'a@b.ua', lateCancelFeePercent: 50, refundDays: 7, extraRules: null,
  });
});

it('accept-offer: власник ставить дату й версію', async () => {
  const at = new Date('2026-10-02T10:00:00Z');
  prisma.club.update.mockResolvedValue({ offerAcceptedAt: at, offerVersion: '2026-09' });
  const res = await request(app).post('/club/accept-offer');
  expect(res.status).toBe(200);
  const arg = prisma.club.update.mock.calls[0][0];
  expect(arg.where).toEqual({ id: 'club' });
  expect(arg.data.offerAcceptedAt).toBeInstanceOf(Date);
  expect(arg.data.offerVersion).toBe('2026-09');
  expect(res.body).toMatchObject({ offerVersion: '2026-09', legalVersion: '2026-09' });
});

it('accept-offer: не власник отримує 403 без запису', async () => {
  state.role = 'ADMIN';
  expect((await request(app).post('/club/accept-offer')).status).toBe(403);
  expect(prisma.club.update).not.toHaveBeenCalled();
});

it('PATCH зберігає редаговані юридичні поля', async () => {
  const res = await request(app).patch('/club').send({
    legalName: ' ФОП Петренко ', legalCode: '3000000000', legalAddress: 'Львів', email: 'X@Y.UA',
    lateCancelFeePercent: 0, refundDays: 10, extraRules: 'Змінне взуття',
  });
  expect(res.status).toBe(200);
  expect(prisma.club.update.mock.calls[0][0].data).toMatchObject({
    legalName: 'ФОП Петренко', legalCode: '3000000000', email: 'x@y.ua', lateCancelFeePercent: 0, refundDays: 10, extraRules: 'Змінне взуття',
  });
});

it.each([[{ lateCancelFeePercent: 51 }], [{ lateCancelFeePercent: -1 }], [{ lateCancelFeePercent: 12.5 }], [{ refundDays: 0 }], [{ email: 'не-пошта' }]])(
  'PATCH відхиляє %j', async body => {
    expect((await request(app).patch('/club').send(body)).status).toBe(400);
    expect(prisma.club.update).not.toHaveBeenCalled();
  });
