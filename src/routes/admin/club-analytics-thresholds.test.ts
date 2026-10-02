import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Prisma } from '@prisma/client';

const prisma = { club: { findUnique: vi.fn(), update: vi.fn() }, payment: { count: vi.fn() } };
const state = { role: 'OWNER' };
vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('../../lib/payments', () => ({ KNOWN_PROVIDERS: ['mono', 'mock'], providerFor: vi.fn(), publicBase: () => 'http://localhost' }));
vi.mock('../../lib/crypto', () => ({ encryptSecret: () => 'encrypted', paymentsSecretReady: () => true }));
vi.mock('../public', () => ({ logoSrcOf: () => null }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => { req.auth = { clubId: 'club', role: state.role }; next(); },
  requireStaff: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const { clubRouter } = await import('./club');
const app = express().use(express.json()).use(clubRouter);
const valid = { occupancy: 70, cancellation: 10, retention: 55 };
const patch = (analyticsThresholds: unknown) => request(app).patch('/club').send({ analyticsThresholds });

beforeEach(() => {
  vi.clearAllMocks();
  state.role = 'OWNER';
  prisma.club.findUnique.mockResolvedValue({ id: 'club', prepayEnabled: false, paymentProvider: null, paymentTokenEnc: null, analyticsThresholds: valid });
  prisma.club.update.mockResolvedValue({ id: 'club', analyticsThresholds: valid });
});

it('GET віддає пороги клубу, а сміття в базі перетворює на null', async () => {
  expect((await request(app).get('/club')).body.analyticsThresholds).toEqual(valid);
  prisma.club.findUnique.mockResolvedValue({ id: 'club', analyticsThresholds: { occupancy: 'x' } });
  expect((await request(app).get('/club')).body.analyticsThresholds).toBeNull();
  prisma.club.findUnique.mockResolvedValue({ id: 'club', analyticsThresholds: null });
  expect((await request(app).get('/club')).body.analyticsThresholds).toBeNull();
});
it('GET доступний і модератору', async () => {
  state.role = 'ADMIN';
  expect((await request(app).get('/club')).status).toBe(200);
});
it('OWNER зберігає валідні пороги, включно з межами 0 і 100', async () => {
  expect((await patch(valid)).status).toBe(200);
  expect(prisma.club.update.mock.calls[0][0].data.analyticsThresholds).toEqual(valid);
  expect((await patch({ occupancy: 0, cancellation: 100, retention: 0 })).status).toBe(200);
});
it.each([
  [{ ...valid, occupancy: 101 }], [{ ...valid, retention: -1 }], [{ ...valid, cancellation: 12.5 }],
  [{ ...valid, occupancy: '70' }], [{ ...valid, extra: 1 }], [{ occupancy: 60, cancellation: 15 }], ['60'],
])('відхиляє некоректні пороги: %j', async value => {
  expect((await patch(value)).status).toBe(400);
  expect(prisma.club.update).not.toHaveBeenCalled();
});
it('null скидає пороги до дефолтів (DbNull)', async () => {
  expect((await patch(null)).status).toBe(200);
  expect(prisma.club.update.mock.calls[0][0].data.analyticsThresholds).toBe(Prisma.DbNull);
});
it('ADMIN не може міняти пороги: 403 і без запису', async () => {
  state.role = 'ADMIN';
  const res = await patch(valid);
  expect(res.status).toBe(403);
  expect(prisma.club.update).not.toHaveBeenCalled();
  expect((await patch(null)).status).toBe(403);
});
it('ADMIN і далі зберігає решту налаштувань, якщо порогів у запиті нема', async () => {
  state.role = 'ADMIN';
  expect((await request(app).patch('/club').send({ name: 'Клуб' })).status).toBe(200);
  expect(prisma.club.update.mock.calls[0][0].data).not.toHaveProperty('analyticsThresholds');
});
