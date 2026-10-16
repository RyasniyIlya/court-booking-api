import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Права ІІ і черга дій у кабінеті. Головне тут — межі: політику й чергу бачить
 * і міняє тільки власник; інші ролі говорять з ІІ лише за дозволом власника;
 * чужий клуб недосяжний.
 */

const prisma = {
  club: { findUnique: vi.fn() },
  aiAgentPolicy: { findUnique: vi.fn(), upsert: vi.fn() },
  aiAction: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn(), findFirstOrThrow: vi.fn(), create: vi.fn() },
};
vi.mock('../../lib/db', () => ({ prisma }));
/* Ключ Gemini може бути в .env розробника: тест не має ходити ні в модель, ні в БД за знімком. */
vi.mock('../../lib/ai/gemini', async () => ({ ...(await vi.importActual<object>('../../lib/ai/gemini')), aiConfigured: () => false }));
vi.mock('./shared', async () => {
  const actual = await vi.importActual<typeof import('./shared')>('./shared');
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.auth = { userId: 'u-1', clubId: 'club-1', role: String(req.headers['x-role'] ?? 'OWNER'), trainerId: null };
      next();
    },
  };
});

const { aiRouter } = await import('./ai');
const app = express().use(express.json()).use('/api/admin', aiRouter);

const ID = '11111111-1111-4111-8111-111111111111';
const PLAN3 = { tier: 3, featTrainers: true, featGroups: true, featAnalytics: true };
const body = {
  readFinance: true, readCustomers: true, readStaff: true, reports: true,
  bookings: 'ASK', groupSessions: 'ASK', tournaments: 'OFF', messaging: 'ASK',
};
const roleBlock = { enabled: true, ...body };

const as = (role: string) => ({ 'x-role': role });

beforeEach(() => {
  vi.resetAllMocks();
  prisma.club.findUnique.mockResolvedValue({ plan: PLAN3 });
  prisma.aiAgentPolicy.findUnique.mockResolvedValue(null);
  prisma.aiAction.findMany.mockResolvedValue([]);
  prisma.aiAction.updateMany.mockResolvedValue({ count: 0 });
});

describe('GET/PUT /ai/policy', () => {
  it('GET без рядка віддає типові права', async () => {
    const res = await request(app).get('/api/admin/ai/policy');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ readFinance: true, bookings: 'ASK', roleAccess: {}, updatedAt: null });
  });

  it.each(['ADMIN', 'TRAINER', 'ACCOUNTANT'])('%s не читає й не міняє політику', async (role) => {
    expect((await request(app).get('/api/admin/ai/policy').set(as(role))).status).toBe(403);
    expect((await request(app).put('/api/admin/ai/policy').set(as(role)).send(body)).status).toBe(403);
    expect(prisma.aiAgentPolicy.upsert).not.toHaveBeenCalled();
  });

  it('PUT зберігає для клубу з токена й записує, хто змінив', async () => {
    prisma.aiAgentPolicy.upsert.mockImplementation(async ({ create }) => ({ ...create, updatedAt: new Date('2026-10-16T10:00:00Z') }));
    const res = await request(app).put('/api/admin/ai/policy').send({ ...body, clubId: undefined, roleAccess: { ADMIN: roleBlock } });
    expect(res.status).toBe(200);
    const arg = prisma.aiAgentPolicy.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ clubId: 'club-1' });
    expect(arg.create).toMatchObject({ clubId: 'club-1', updatedById: 'u-1', tournaments: 'OFF' });
    expect(res.body.roleAccess.ADMIN).toMatchObject({ enabled: true });
  });

  it('PUT відкидає чужі клуби в тілі й невалідні режими', async () => {
    expect((await request(app).put('/api/admin/ai/policy').send({ ...body, clubId: 'club-2' })).status).toBe(400);
    expect((await request(app).put('/api/admin/ai/policy').send({ ...body, bookings: 'ALWAYS' })).status).toBe(400);
    expect(prisma.aiAgentPolicy.upsert).not.toHaveBeenCalled();
  });

  it('без тарифу «Аналітика» — 402', async () => {
    prisma.club.findUnique.mockResolvedValue({ plan: { tier: 1, featTrainers: false, featGroups: false, featAnalytics: false } });
    expect((await request(app).get('/api/admin/ai/policy')).status).toBe(402);
  });
});

describe('доступ до розмови', () => {
  it('роль без дозволу власника — 403', async () => {
    expect((await request(app).get('/api/admin/ai/status').set(as('ADMIN'))).status).toBe(403);
    expect((await request(app).post('/api/admin/ai/chat').set(as('ADMIN')).send({ messages: [{ role: 'user', content: 'hi' }] })).status).toBe(403);
    expect((await request(app).post('/api/admin/ai/brief').set(as('ADMIN')).send({})).status).toBe(403);
  });

  it('роль із дозволом проходить далі (без ключа Gemini — 200 «не налаштовано»)', async () => {
    prisma.aiAgentPolicy.findUnique.mockResolvedValue({ ...body, roleAccess: { ADMIN: roleBlock } });
    const res = await request(app).get('/api/admin/ai/status').set(as('ADMIN'));
    expect(res.status).toBe(200);
  });

  it('дозвіл однієї ролі не відкриває іншу', async () => {
    prisma.aiAgentPolicy.findUnique.mockResolvedValue({ ...body, roleAccess: { ADMIN: roleBlock } });
    expect((await request(app).get('/api/admin/ai/status').set(as('ACCOUNTANT'))).status).toBe(403);
  });

  it('власник проходить завжди', async () => {
    expect((await request(app).get('/api/admin/ai/status')).status).toBe(200);
  });
});

describe('журнал дій', () => {
  it('черга: тільки власник, у межах свого клубу', async () => {
    expect((await request(app).get('/api/admin/ai/actions').set(as('ADMIN'))).status).toBe(403);
    const res = await request(app).get('/api/admin/ai/actions?status=PENDING');
    expect(res.status).toBe(200);
    expect(prisma.aiAction.findMany.mock.calls[0][0].where).toEqual({ clubId: 'club-1', status: 'PENDING' });
    expect((await request(app).get('/api/admin/ai/actions?status=WHATEVER')).status).toBe(400);
  });

  it.each(['approve', 'reject'])('%s: не-власник — 403, дія не чіпається', async (verb) => {
    const res = await request(app).post(`/api/admin/ai/actions/${ID}/${verb}`).set(as('ADMIN'));
    expect(res.status).toBe(403);
    expect(prisma.aiAction.findFirst).not.toHaveBeenCalled();
    expect(prisma.aiAction.updateMany).not.toHaveBeenCalled();
  });

  it.each(['approve', 'reject'])('%s: дія з чужого клубу — 404', async (verb) => {
    prisma.aiAction.findFirst.mockResolvedValue(null);
    const res = await request(app).post(`/api/admin/ai/actions/${ID}/${verb}`);
    expect(res.status).toBe(404);
    expect(prisma.aiAction.findFirst.mock.calls[0][0].where).toEqual({ id: ID, clubId: 'club-1' });
  });

  it('не-uuid id — 400, не 500', async () => {
    expect((await request(app).post('/api/admin/ai/actions/abc/approve')).status).toBe(400);
  });

  it('reject власника проходить і повертає дію', async () => {
    prisma.aiAction.findFirst.mockResolvedValue({ id: ID, clubId: 'club-1', status: 'PENDING', expiresAt: new Date(Date.now() + 60_000) });
    prisma.aiAction.updateMany.mockResolvedValue({ count: 1 });
    prisma.aiAction.findFirstOrThrow.mockResolvedValue({ id: ID, status: 'REJECTED' });
    const res = await request(app).post(`/api/admin/ai/actions/${ID}/reject`);
    expect(res.status).toBe(200);
    expect(res.body.action.status).toBe('REJECTED');
  });

  it('вже вирішена дія — 409', async () => {
    prisma.aiAction.findFirst.mockResolvedValue({ id: ID, clubId: 'club-1', status: 'EXECUTED', expiresAt: new Date(Date.now() + 60_000) });
    expect((await request(app).post(`/api/admin/ai/actions/${ID}/approve`)).status).toBe(409);
  });
});
