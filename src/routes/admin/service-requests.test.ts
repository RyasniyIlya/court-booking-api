import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/** Заявки клубу партнеру: тільки OWNER/ADMIN, тільки з партнером, тільки свої. */

const prisma = {
  club: { findUnique: vi.fn() },
  court: { findUnique: vi.fn() },
  serviceRequest: { create: vi.fn(), findMany: vi.fn() },
};
const auth = { userId: 'u1', clubId: 'club-1', role: 'ADMIN', trainerId: null as string | null };

vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => { req.auth = { ...auth }; next(); },
  requireRole: (...roles: string[]) => (req: { auth?: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    roles.includes(req.auth!.role) ? next() : res.status(403).json({ error: 'FORBIDDEN' }),
}));

const { serviceRequestsRouter } = await import('./serviceRequests');
const app = express().use(express.json()).use('/api/admin', serviceRequestsRouter);
const COURT = '11111111-1111-4111-8111-111111111111';
const post = (body: unknown) => request(app).post('/api/admin/service-requests').send(body as object);

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(auth, { role: 'ADMIN', clubId: 'club-1' });
  prisma.club.findUnique.mockResolvedValue({ id: 'club-1', partnerId: 'p1' });
  prisma.court.findUnique.mockResolvedValue({ clubId: 'club-1' });
  prisma.serviceRequest.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 's1', ...data }));
  prisma.serviceRequest.findMany.mockResolvedValue([{ id: 's1' }]);
});

describe('POST /service-requests', () => {
  it('створює заявку з партнером клубу', async () => {
    const res = await post({ kind: 'repair', message: 'Порвана сітка', courtId: COURT });
    expect(res.status).toBe(200);
    expect(prisma.serviceRequest.create.mock.calls[0][0].data).toMatchObject({ clubId: 'club-1', partnerId: 'p1', kind: 'repair', courtId: COURT });
  });

  it('409 NO_PARTNER, якщо клуб без партнера', async () => {
    prisma.club.findUnique.mockResolvedValue({ id: 'club-1', partnerId: null });
    const res = await post({ kind: 'repair', message: 'Порвана сітка' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NO_PARTNER');
    expect(prisma.serviceRequest.create).not.toHaveBeenCalled();
  });

  it('400 на кривий тип, короткий текст, задовгий текст, поганий courtId', async () => {
    expect((await post({ kind: 'bad', message: 'Порвана сітка' })).status).toBe(400);
    expect((await post({ kind: 'repair', message: 'ок' })).status).toBe(400);
    expect((await post({ kind: 'repair', message: 'x'.repeat(2001) })).status).toBe(400);
    expect((await post({ kind: 'repair', message: 'Порвана сітка', courtId: 'not-uuid' })).status).toBe(400);
    expect(prisma.serviceRequest.create).not.toHaveBeenCalled();
  });

  it('корт іншого клубу — 404', async () => {
    prisma.court.findUnique.mockResolvedValue({ clubId: 'other' });
    expect((await post({ kind: 'repair', message: 'Порвана сітка', courtId: COURT })).status).toBe(404);
    expect(prisma.serviceRequest.create).not.toHaveBeenCalled();
  });

  it('тренер і персонал — 403', async () => {
    for (const role of ['TRAINER', 'STAFF']) {
      auth.role = role;
      expect((await post({ kind: 'repair', message: 'Порвана сітка' })).status).toBe(403);
    }
    expect(prisma.serviceRequest.create).not.toHaveBeenCalled();
  });
});

describe('GET /service-requests', () => {
  it('віддає лише заявки свого клубу', async () => {
    const res = await request(app).get('/api/admin/service-requests');
    expect(res.status).toBe(200);
    expect(prisma.serviceRequest.findMany.mock.calls[0][0].where).toEqual({ clubId: 'club-1' });
  });

  it('403 для тренера', async () => {
    auth.role = 'TRAINER';
    expect((await request(app).get('/api/admin/service-requests')).status).toBe(403);
  });
});
