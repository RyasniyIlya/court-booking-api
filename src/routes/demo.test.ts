import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

/* /api/demo/session: прапорець, акаунти, токен проходить справжні requireAuth / requireFederationAuth, а вартовий DEMO_LOCKED працює на них. */
type Rec = Record<string, any>;
const st = {
  user: null as Rec | null,
  fedAccount: null as Rec | null,
};
const club = { slug: 'demo-squash-kyiv' };
const demoUser = () => ({ id: 'u1', email: 'owner@demo.test', role: 'OWNER', clubId: 'c1', trainerId: null, passwordHash: 'h1', club });
const demoFed = () => ({ id: 'a1', federationId: 'f1', email: 'federation@demo.test', passwordHash: 'h2', active: true, federation: { code: 'squash-demo' } });

const prisma = {
  user: { findUnique: vi.fn(async () => st.user) },
  federationAccount: { findUnique: vi.fn(async () => st.fedAccount) },
};
vi.mock('../lib/db', () => ({ prisma, isSlotTakenError: () => false }));

const { demoRouter } = await import('./demo');
const { requireAuth, signToken } = await import('./admin/shared');
const { requireFederationAuth, signFederationToken } = await import('../lib/federationAuth');

const app = express().use(express.json()).use('/api/demo', demoRouter);
// Мінімальна копія композиції: той самий requireAuth, що в кабінеті, на повних шляхах /api/admin і /api/federation.
const ok = (_req: express.Request, res: express.Response) => { res.json({ ok: true }); };
app.use('/api/admin', requireAuth, ok);
app.use('/api/federation', requireFederationAuth, ok);

const decode = (t: string) => jwt.decode(t) as Rec;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeEach(() => {
  vi.clearAllMocks();
  st.user = demoUser();
  st.fedAccount = demoFed();
  process.env.DEMO_LOGIN = 'true';
});

describe('POST /api/demo/session', () => {
  it('без DEMO_LOGIN=true — 404 і до бази не ходить', async () => {
    delete process.env.DEMO_LOGIN;
    expect((await request(app).post('/api/demo/session').send({ kind: 'club' })).status).toBe(404);
    process.env.DEMO_LOGIN = 'yes';
    expect((await request(app).post('/api/demo/session').send({ kind: 'club' })).status).toBe(404);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('невірне тіло — 400', async () => {
    expect((await request(app).post('/api/demo/session').send({ kind: 'platform' })).status).toBe(400);
    expect((await request(app).post('/api/demo/session').send({})).status).toBe(400);
  });

  it('club: токен із demo:true на 2 години, redirect /admin', async () => {
    const r = await request(app).post('/api/demo/session').send({ kind: 'club' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scope: 'club', redirect: '/admin' });
    const p = decode(r.body.token);
    expect(p).toMatchObject({ userId: 'u1', clubId: 'c1', role: 'OWNER', demo: true });
    expect(p.exp - p.iat).toBe(2 * 3600);
    expect(JSON.stringify(p)).not.toContain('h1');
  });

  it('federation: токен із demo:true на 2 години, redirect у перший розділ', async () => {
    const r = await request(app).post('/api/demo/session').send({ kind: 'federation' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scope: 'federation', redirect: '/federation/tournaments' });
    const p = decode(r.body.token);
    expect(p).toMatchObject({ scope: 'federation', accountId: 'a1', federationId: 'f1', demo: true });
    expect(p.exp - p.iat).toBe(2 * 3600);
  });

  it('немає демо-акаунта — 503 DEMO_UNAVAILABLE', async () => {
    st.user = null; st.fedAccount = null;
    const a = await request(app).post('/api/demo/session').send({ kind: 'club' });
    const b = await request(app).post('/api/demo/session').send({ kind: 'federation' });
    expect([a.status, a.body.error]).toEqual([503, 'DEMO_UNAVAILABLE']);
    expect([b.status, b.body.error]).toEqual([503, 'DEMO_UNAVAILABLE']);
  });

  it('подвійна перевірка: чужа пошта, чужий slug, не власник, неактивна федерація — 503', async () => {
    for (const patch of [{ email: 'owner@real.com' }, { club: { slug: 'real-club' } }, { club: { slug: 'demo-other' } }, { role: 'ADMIN' }]) {
      st.user = { ...demoUser(), ...patch };
      expect((await request(app).post('/api/demo/session').send({ kind: 'club' })).status).toBe(503);
    }
    for (const patch of [{ email: 'f@real.com' }, { federation: { code: 'other' } }, { active: false }]) {
      st.fedAccount = { ...demoFed(), ...patch };
      expect((await request(app).post('/api/demo/session').send({ kind: 'federation' })).status).toBe(503);
    }
  });

  it('помилка бази — 503 без витоку деталей', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.user.findUnique.mockRejectedValueOnce(new Error('connection refused postgres://secret'));
    const r = await request(app).post('/api/demo/session').send({ kind: 'club' });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain('secret');
  });
});

describe('demo-токен клубу крізь requireAuth', () => {
  const demoToken = async () => (await request(app).post('/api/demo/session').send({ kind: 'club' })).body.token as string;

  it('проходить requireAuth, а робочі дії (бронь, рахунок) дозволені', async () => {
    const t = await demoToken();
    expect((await request(app).get('/api/admin/bookings').set(bearer(t))).status).toBe(200);
    expect((await request(app).post('/api/admin/bookings').set(bearer(t)).send({})).status).toBe(200);
    expect((await request(app).post('/api/admin/bookings/1/settlements').set(bearer(t)).send({})).status).toBe(200);
    expect((await request(app).patch('/api/admin/club').set(bearer(t)).send({ name: 'Нова' })).status).toBe(200);
  });

  it.each([
    ['post', '/api/admin/password'], ['post', '/api/admin/staff'], ['delete', '/api/admin/staff/1'], ['post', '/api/admin/billing/invoice'],
    ['put', '/api/admin/bot-settings'], ['post', '/api/admin/telegram/link'], ['post', '/api/admin/club/payment-test'],
    ['patch', '/api/admin/finance/tax-regime'],
  ] as const)('%s %s — 403 DEMO_LOCKED', async (method, url) => {
    const r = await request(app)[method](url).set(bearer(await demoToken())).send({});
    expect([r.status, r.body]).toEqual([403, { error: 'DEMO_LOCKED' }]);
  });

  it('PATCH /club з платіжним токеном — 403, з телефоном — 200', async () => {
    const t = await demoToken();
    expect((await request(app).patch('/api/admin/club').set(bearer(t)).send({ paymentToken: 'abcdefghijk' })).status).toBe(403);
    expect((await request(app).patch('/api/admin/club').set(bearer(t)).send({ phone: '+380' })).status).toBe(200);
  });

  it('GET небезпечних шляхів лишається доступним', async () => {
    expect((await request(app).get('/api/admin/staff').set(bearer(await demoToken()))).status).toBe(200);
  });

  it('звичайний токен (без demo) не зачеплений: ті самі шляхи проходять', async () => {
    st.user = { ...demoUser(), email: 'owner@realclub.ua' };
    const t = signToken({ userId: 'u1', clubId: 'c1', role: 'OWNER', trainerId: null }, '7d', 'h1');
    expect(decode(t).demo).toBeUndefined();
    for (const [m, u] of [['post', '/api/admin/password'], ['post', '/api/admin/staff'], ['put', '/api/admin/bot-settings']] as const) {
      expect((await request(app)[m](u).set(bearer(t)).send({})).status).toBe(200);
    }
  });

  it('demo:true у токені справжнього (не @demo.test) користувача — 401', async () => {
    st.user = { ...demoUser(), email: 'owner@realclub.ua' };
    const t = signToken({ userId: 'u1', clubId: 'c1', role: 'OWNER', trainerId: null, demo: true }, '2h', 'h1');
    expect((await request(app).get('/api/admin/bookings').set(bearer(t))).status).toBe(401);
  });

  it('змінений пароль демо-акаунта відкликає видані токени', async () => {
    const t = await demoToken();
    st.user = { ...demoUser(), passwordHash: 'changed' };
    expect((await request(app).get('/api/admin/bookings').set(bearer(t))).status).toBe(401);
  });

  it('підроблений токен з чужим підписом не приймається', async () => {
    const forged = jwt.sign({ userId: 'u1', clubId: 'c1', role: 'OWNER', trainerId: null }, 'not-the-secret');
    expect((await request(app).get('/api/admin/bookings').set(bearer(forged))).status).toBe(401);
  });
});

describe('demo-токен федерації крізь requireFederationAuth', () => {
  const demoToken = async () => (await request(app).post('/api/demo/session').send({ kind: 'federation' })).body.token as string;

  it('турніри, гравці й читання дозволені', async () => {
    const t = await demoToken();
    expect((await request(app).get('/api/federation/me').set(bearer(t))).status).toBe(200);
    expect((await request(app).post('/api/federation/tournaments').set(bearer(t)).send({})).status).toBe(200);
    expect((await request(app).post('/api/federation/players').set(bearer(t)).send({})).status).toBe(200);
  });

  it('PUT /rating-settings — 403 DEMO_LOCKED, GET — 200', async () => {
    const t = await demoToken();
    const r = await request(app).put('/api/federation/rating-settings').set(bearer(t)).send({});
    expect([r.status, r.body]).toEqual([403, { error: 'DEMO_LOCKED' }]);
    expect((await request(app).get('/api/federation/rating-settings').set(bearer(t))).status).toBe(200);
  });

  it('finish турніру федерації (запис ELO) — 403 DEMO_LOCKED; start і withdraw проходять', async () => {
    const t = await demoToken();
    const r = await request(app).post('/api/federation/tournaments/1/finish').set(bearer(t)).send({});
    expect([r.status, r.body]).toEqual([403, { error: 'DEMO_LOCKED' }]);
    expect((await request(app).post('/api/federation/tournaments/1/reopen').set(bearer(t)).send({})).status).toBe(403);
    expect((await request(app).post('/api/federation/tournaments/1/start').set(bearer(t)).send({})).status).toBe(200);
  });

  it('той самий finish зі звичайним токеном федерації проходить (правило лише для demo)', async () => {
    st.fedAccount = { ...demoFed(), email: 'head@federation.ua' };
    const t = signFederationToken(st.fedAccount as any);
    expect((await request(app).post('/api/federation/tournaments/1/finish').set(bearer(t)).send({})).status).toBe(200);
  });

  it('звичайний токен федерації: rating-settings проходить, у payload немає demo, живе 8 годин', async () => {
    st.fedAccount = { ...demoFed(), email: 'head@federation.ua' };
    const t = signFederationToken(st.fedAccount as any);
    const p = decode(t);
    expect(p.demo).toBeUndefined();
    expect(p.exp - p.iat).toBe(8 * 3600);
    expect((await request(app).put('/api/federation/rating-settings').set(bearer(t)).send({})).status).toBe(200);
  });

  it('demo:true для не @demo.test акаунта — 401', async () => {
    st.fedAccount = { ...demoFed(), email: 'head@federation.ua' };
    const t = signFederationToken(st.fedAccount as any, { demo: true, expiresIn: '2h' });
    expect((await request(app).get('/api/federation/me').set(bearer(t))).status).toBe(401);
  });
});
