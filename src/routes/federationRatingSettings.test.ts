import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

type Rec = Record<string, any>;
const FED = '11111111-1111-4111-8111-111111111111';
const st = { stored: null as unknown, logs: [] as Rec[] };
const account = { id: 'acc', federationId: FED, email: 'f@test', active: true, passwordHash: 'h' };
const prisma: Rec = {
  federationAccount: { findUnique: vi.fn(async () => account) },
  federation: {
    findUniqueOrThrow: vi.fn(async () => ({ id: FED, name: 'F', code: 'f', logoUrl: null, sport: 'SQUASH', ratingSettings: st.stored })),
    update: vi.fn(async ({ data }: Rec) => { st.stored = data.ratingSettings; return {}; }),
  },
  federationSettingsLog: { create: vi.fn(async ({ data }: Rec) => { st.logs.push(data); return data; }) },
  $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
};
vi.mock('../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('./admin/shared', () => ({ param: (req: { params: Record<string, string> }, k: string) => req.params[k] }));

const { federationRouter } = await import('./federation');
const { signFederationToken } = await import('../lib/federationAuth');
const { DEFAULT_RATING_SETTINGS: D } = await import('../lib/federationRating');
const app = express().use(express.json()).use(federationRouter);
const auth = () => ({ Authorization: `Bearer ${signFederationToken(account)}` });

beforeEach(() => { st.stored = null; st.logs = []; vi.clearAllMocks(); });

describe('GET/PUT /rating-settings', () => {
  it('без токена федерації → 401 (клубний/анонімний доступ закрито)', async () => {
    expect((await request(app).get('/rating-settings')).status).toBe(401);
    expect((await request(app).put('/rating-settings').send(D)).status).toBe(401);
    expect((await request(app).put('/rating-settings').set('Authorization', 'Bearer club-token').send(D)).status).toBe(401);
    expect(prisma.federation.update).not.toHaveBeenCalled();
  });
  it('GET без збережених → типові; /me теж віддає ratingSettings', async () => {
    const r = await request(app).get('/rating-settings').set(auth());
    expect(r.status).toBe(200); expect(r.body).toEqual(D);
    const me = await request(app).get('/me').set(auth());
    expect(me.body.ratingSettings).toEqual(D);
  });
  it('GET /rating-settings/defaults', async () => {
    expect((await request(app).get('/rating-settings/defaults').set(auth())).body).toEqual(D);
  });
  it('PUT зберігає, пише журнал було/стало, GET повертає збережене', async () => {
    const next = { ...D, kFactor: 20, startElo: 1000 };
    const r = await request(app).put('/rating-settings').set(auth()).send(next);
    expect(r.status).toBe(200); expect(r.body).toEqual(next);
    expect(st.stored).toEqual(next);
    expect(st.logs).toHaveLength(1);
    expect(st.logs[0]).toMatchObject({ federationId: FED, field: 'ratingSettings', actorEmail: 'f@test', before: D, after: next });
    expect((await request(app).get('/rating-settings').set(auth())).body).toEqual(next);
  });
  it('PUT без змін не пише журнал', async () => {
    expect((await request(app).put('/rating-settings').set(auth()).send(D)).status).toBe(200);
    expect(st.logs).toHaveLength(0);
  });
  it.each([
    ['перший рівень не з 0', { levels: [{ code: 'A', label: 'a', minElo: 100 }, { code: 'B', label: 'b', minElo: 200 }] }],
    ['minElo не зростає', { levels: [{ code: 'A', label: 'a', minElo: 0 }, { code: 'B', label: 'b', minElo: 0 }] }],
    ['один рівень', { levels: [{ code: 'A', label: 'a', minElo: 0 }] }],
    ['K поза межами', { kFactor: 100 }], ['startElo поза межами', { startElo: 100 }],
  ])('PUT 400: %s', async (_n, over) => {
    const r = await request(app).put('/rating-settings').set(auth()).send({ ...D, ...over });
    expect(r.status).toBe(400); expect(r.body.error).toBe('BAD_REQUEST');
    expect(prisma.federation.update).not.toHaveBeenCalled();
  });
  it('PUT 400 на неповне тіло', async () => {
    expect((await request(app).put('/rating-settings').set(auth()).send({ kFactor: 20 })).status).toBe(400);
  });
});
