import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const prisma = {
  club: { findUnique: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  changeLog: { createMany: vi.fn() },
  payment: { count: vi.fn() },
};
const state = { role: 'OWNER' };
vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('../../lib/payments', () => ({ KNOWN_PROVIDERS: ['mono', 'mock'], providerFor: vi.fn(), publicBase: () => 'http://localhost' }));
vi.mock('../../lib/crypto', () => ({ encryptSecret: () => 'e', paymentsSecretReady: () => true }));
vi.mock('../public', () => ({ logoSrcOf: () => null }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => { req.auth = { userId: 'u1', clubId: 'club', role: state.role }; next(); },
  requireStaff: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: (...roles: string[]) => (req: { auth: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    roles.includes(req.auth.role) ? next() : res.status(403).json({ error: 'FORBIDDEN' }),
}));
const { clubRouter } = await import('./club');
const app = express().use(express.json()).use(clubRouter);

beforeEach(() => {
  vi.clearAllMocks();
  state.role = 'OWNER';
  prisma.club.findUnique.mockResolvedValue({ partnerId: 'p1', shareStatsWithPartner: false });
  prisma.user.findUnique.mockResolvedValue({ email: 'o@x.ua', role: 'OWNER' });
});

it('OWNER вмикає згоду: запис + журнал змін', async () => {
  const res = await request(app).put('/club/share-stats').send({ share: true });
  expect(res.status).toBe(200);
  const data = prisma.club.update.mock.calls[0][0].data;
  expect(data.shareStatsWithPartner).toBe(true);
  expect(data.shareStatsChangedAt).toBeInstanceOf(Date);
  expect(prisma.changeLog.createMany.mock.calls[0][0].data[0]).toMatchObject({ field: 'shareStatsWithPartner', before: false, after: true });
});

it('не власник: 403 без запису', async () => {
  state.role = 'ADMIN';
  expect((await request(app).put('/club/share-stats').send({ share: true })).status).toBe(403);
  expect(prisma.club.update).not.toHaveBeenCalled();
});

it('клуб без партнера: 409', async () => {
  prisma.club.findUnique.mockResolvedValue({ partnerId: null, shareStatsWithPartner: false });
  expect((await request(app).put('/club/share-stats').send({ share: true })).status).toBe(409);
  expect(prisma.club.update).not.toHaveBeenCalled();
});
