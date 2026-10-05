import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Кабінет партнера: ізоляція даних, відсутність чужих/клубних полів,
 * токени не взаємозамінні, блокування логіну.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const prisma = {
  partner: { findUnique: vi.fn(), update: vi.fn() },
  partnerPayout: { findMany: vi.fn() },
  club: { findMany: vi.fn() },
  lead: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
};
vi.mock('../lib/db', () => ({ prisma }));
vi.mock('../lib/partnerAnalytics', () => ({
  buildPartnerAnalytics: vi.fn(),
}));

const { JWT_SECRET } = await import('../lib/authSecret');
const { hashPassword } = await import('../lib/passwordHash');
const { signPartnerToken } = await import('../lib/partnerAuth');
const { partnerRouter } = await import('./partner');
const { requirePlatformAuth } = await import('../lib/platformAuth');
const { signToken, requireAuth } = await import('./admin/shared');
const { buildPartnerAnalytics } = await import('../lib/partnerAnalytics');

const app = express().use(express.json()).use(partnerRouter);

const hashA = await hashPassword('secret-pass-A', 4);
const hashB = await hashPassword('secret-pass-B', 4);
const partners: Record<string, Record<string, unknown>> = {
  [A]: { id: A, name: 'A', company: 'ТОВ А', email: 'a@x.ua', phone: null, passwordHash: hashA, refCode: 'aaaa1111', rateFirstYear: 50, rateAfter: 20, isActive: true, pinFails: 0, pinLockedUntil: null },
  [B]: { id: B, name: 'B', company: null, email: 'b@x.ua', phone: null, passwordHash: hashB, refCode: 'bbbb2222', rateFirstYear: 50, rateAfter: 20, isActive: true, pinFails: 0, pinLockedUntil: null },
};

const dbClubs = [
  {
    id: 'c-a', partnerId: A, name: 'Клуб А', city: 'Київ', isActive: true, approvedAt: new Date('2026-02-01'),
    trialEndsAt: null, paidUntil: new Date('2099-01-01'), terminatedAt: null, createdAt: new Date('2026-01-20'),
    partnerAttachedAt: new Date('2026-01-20T00:00:00Z'), plan: { name: 'Standard' }, _count: { courts: 3 },
    invoices: [{ id: 'i-a', clubId: 'c-a', amount: 100000, status: 'PAID', paidAt: new Date('2026-03-01T00:00:00Z') }],
  },
  {
    id: 'c-b', partnerId: B, name: 'Клуб Б (чужий)', city: 'Львів', isActive: true, approvedAt: null,
    trialEndsAt: null, paidUntil: null, terminatedAt: null, createdAt: new Date('2026-01-21'),
    partnerAttachedAt: new Date('2026-01-21T00:00:00Z'), plan: null, _count: { courts: 1 }, invoices: [],
  },
];
const dbLeads = [
  { id: 'l-a', partnerId: A, name: 'Лід А', city: null, phone: '+380501111111', contactName: null, courtsCount: 2, stage: 'NEW', createdAt: new Date() },
  { id: 'l-b', partnerId: B, name: 'Лід Б', city: null, phone: '+380502222222', contactName: null, courtsCount: 4, stage: 'DEMO', createdAt: new Date() },
];

const tokenA = () => `Bearer ${signPartnerToken(A, hashA)}`;

beforeEach(() => {
  vi.resetAllMocks();
  prisma.partner.findUnique.mockImplementation(async ({ where }: { where: { id?: string; email?: string } }) =>
    where.id ? partners[where.id] ?? null : Object.values(partners).find((p) => p.email === where.email) ?? null);
  prisma.partner.update.mockResolvedValue({});
  prisma.partnerPayout.findMany.mockResolvedValue([{ id: 'p1', amount: 10000, paidAt: new Date('2026-04-01'), note: null }]);
  prisma.club.findMany.mockImplementation(async ({ where }: { where: { partnerId: string } }) =>
    dbClubs.filter((c) => c.partnerId === where.partnerId));
  prisma.lead.findMany.mockImplementation(async ({ where }: { where: { partnerId: string } }) =>
    dbLeads.filter((l) => l.partnerId === where.partnerId));
});

describe('ізоляція партнерів', () => {
  it('/clubs віддає лише клуби свого партнера', async () => {
    const res = await request(app).get('/clubs').set('Authorization', tokenA());
    expect(res.status).toBe(200);
    expect(res.body.map((c: { id: string }) => c.id)).toEqual(['c-a']);
    expect(prisma.club.findMany.mock.calls[0][0].where).toEqual({ partnerId: A });
    expect(JSON.stringify(res.body)).not.toContain('чужий');
  });

  it('/clubs: лише білий список полів, без броней, гравців, виручки', async () => {
    const res = await request(app).get('/clubs').set('Authorization', tokenA());
    const club = res.body[0];
    expect(Object.keys(club).sort()).toEqual(
      ['activeCourts', 'city', 'commissionTotal', 'connectedAt', 'id', 'invoices', 'name', 'plan', 'status'].sort(),
    );
    expect(club).toMatchObject({ activeCourts: 3, status: 'ACTIVE', plan: 'Standard', commissionTotal: 50000 });
    expect(Object.keys(club.invoices[0]).sort()).toEqual(['amount', 'commission', 'id', 'paidAt']);
    // select у запиті не містить заборонених звʼязків
    const select = prisma.club.findMany.mock.calls[0][0].select;
    for (const forbidden of ['bookings', 'customers', 'payments', 'users', 'shiftCloses', 'expenses', 'passes']) {
      expect(select).not.toHaveProperty(forbidden);
    }
    expect(prisma.club.findMany.mock.calls[0][0]).not.toHaveProperty('include');
  });

  it('/leads віддає лише свої ліди', async () => {
    const res = await request(app).get('/leads').set('Authorization', tokenA());
    expect(res.body.map((l: { id: string }) => l.id)).toEqual(['l-a']);
  });

  it('/commissions: рядки, підсумки й виплати лише свого партнера', async () => {
    const res = await request(app).get('/commissions').set('Authorization', tokenA());
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({ clubName: 'Клуб А', amount: 100000, rate: 50, commission: 50000 });
    expect(res.body.totals).toEqual({ accrued: 50000, paid: 10000, due: 40000 });
    expect(prisma.partnerPayout.findMany.mock.calls[0][0].where).toEqual({ partnerId: A });
  });

  it('/me повертає профіль і refLink без хешу пароля', async () => {
    const res = await request(app).get('/me').set('Authorization', tokenA());
    expect(res.status).toBe(200);
    expect(res.body.refCode).toBe('aaaa1111');
    /* без реквізитів і договору партнер не ready: лінка немає (повні сценарії — partner-paperwork.test.ts) */
    expect(res.body.refLink).toBeNull();
    expect(res.body.ready).toBe(false);
    expect(prisma.partner.findUnique.mock.calls.at(-1)![0].select).not.toHaveProperty('passwordHash');
  });
});

describe('POST /leads', () => {
  it('створює лід source=partner, stage=NEW, partnerId з токена; openingDate іде в note', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    prisma.lead.create.mockResolvedValue({ id: 'new' });
    const res = await request(app).post('/leads').set('Authorization', tokenA())
      .send({ name: 'Новий клуб', city: 'Одеса', phone: '+380503333333', courtsCount: 4, openingDate: '2027-03', note: 'бетон' });
    expect(res.status).toBe(201);
    const data = prisma.lead.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ source: 'partner', stage: 'NEW', partnerId: A, courtsCount: 4 });
    expect(data.note).toContain('2027-03');
    expect(data.note).toContain('бетон');
  });

  it('409 LEAD_EXISTS при дублікаті телефону, без розкриття чужого', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'l-b' });
    const res = await request(app).post('/leads').set('Authorization', tokenA())
      .send({ name: 'Клуб Б', phone: '+380502222222' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'LEAD_EXISTS' });
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('400 без назви', async () => {
    const res = await request(app).post('/leads').set('Authorization', tokenA()).send({ city: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('токени', () => {
  const clubToken = () => `Bearer ${signToken({ userId: A, clubId: B, role: 'OWNER', trainerId: null }, '1h', hashA)}`;
  const platformToken = () => `Bearer ${jwt.sign({ scope: 'platform', email: 'op@test.local' }, JWT_SECRET)}`;

  it('без токена 401; клубний і платформений токени партнерський роут не проходять', async () => {
    expect((await request(app).get('/clubs')).status).toBe(401);
    expect((await request(app).get('/clubs').set('Authorization', clubToken())).status).toBe(401);
    expect((await request(app).get('/clubs').set('Authorization', platformToken())).status).toBe(401);
  });

  it('партнерський токен не проходить клубний і платформений захист', async () => {
    const probe = express()
      .get('/club', requireAuth, (_q, r) => { r.json({ ok: true }); })
      .get('/platform', requirePlatformAuth, (_q, r) => { r.json({ ok: true }); });
    expect((await request(probe).get('/club').set('Authorization', tokenA())).status).toBe(401);
    expect((await request(probe).get('/platform').set('Authorization', tokenA())).status).toBe(401);
  });

  it('зміна пароля гасить старий токен; неактивний партнер — 401', async () => {
    const old = tokenA();
    partners[A].passwordHash = await hashPassword('other', 4);
    expect((await request(app).get('/me').set('Authorization', old)).status).toBe(401);
    partners[A].passwordHash = hashA;
    expect((await request(app).get('/me').set('Authorization', old)).status).toBe(200);
    partners[A].isActive = false;
    expect((await request(app).get('/me').set('Authorization', old)).status).toBe(401);
    partners[A].isActive = true;
  });
});

describe('POST /login', () => {
  it('успіх: токен і профіль без хешу', async () => {
    const res = await request(app).post('/login').send({ email: 'A@x.ua', password: 'secret-pass-A' });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.partner).toEqual({ id: A, name: 'A', company: 'ТОВ А', email: 'a@x.ua', refCode: 'aaaa1111' });
  });

  it('невідомий email і хибний пароль — однакова 401', async () => {
    const r1 = await request(app).post('/login').send({ email: 'no@x.ua', password: 'whatever1' });
    const r2 = await request(app).post('/login').send({ email: 'a@x.ua', password: 'wrong-pass' });
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(r1.body).toEqual(r2.body);
  });

  it('5-а невдала спроба ставить блокування, заблокований — 423', async () => {
    partners[A].pinFails = 4;
    await request(app).post('/login').send({ email: 'a@x.ua', password: 'wrong-pass' });
    const upd = prisma.partner.update.mock.calls[0][0].data;
    expect(upd.pinFails).toBe(5);
    expect(upd.pinLockedUntil).toBeInstanceOf(Date);

    partners[A].pinFails = 5;
    partners[A].pinLockedUntil = new Date(Date.now() + 60_000);
    const res = await request(app).post('/login').send({ email: 'a@x.ua', password: 'secret-pass-A' });
    expect(res.status).toBe(423);
    partners[A].pinFails = 0;
    partners[A].pinLockedUntil = null;
  });
});

describe('POST /password', () => {
  it('хибний current — 403, вірний — новий токен і скидання лічильника', async () => {
    const bad = await request(app).post('/password').set('Authorization', tokenA()).send({ current: 'nope', next: 'new-password-1' });
    expect(bad.status).toBe(403);
    prisma.partner.update.mockClear();
    const ok = await request(app).post('/password').set('Authorization', tokenA()).send({ current: 'secret-pass-A', next: 'new-password-1' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toEqual(expect.any(String));
    expect(prisma.partner.update.mock.calls[0][0].data).toMatchObject({ pinFails: 0, pinLockedUntil: null });
  });
});

describe('GET /analytics', () => {
  beforeEach(() => {
    buildPartnerAnalytics.mockClear();
  });

  it('без токена 401', async () => {
    const res = await request(app).get('/analytics');
    expect(res.status).toBe(401);
  });

  it('віддає аналітику лише для свого партнера', async () => {
    const mockAnalytics = {
      earningsByMonth: [{ month: '2026-10', commission: 50000 }],
      totals: { accrued: 50000, paid: 10000, due: 40000 },
      forecast: { nextQuarter: 30000, next12Months: 150000 },
      funnel: { leads: 5, demo: 2, trial: 1, paying: 1 },
    };
    buildPartnerAnalytics.mockResolvedValueOnce(mockAnalytics);
    const res = await request(app).get('/analytics').set('Authorization', tokenA());
    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockAnalytics);
  });

  it('401 для неактивного партнера', async () => {
    buildPartnerAnalytics.mockResolvedValueOnce(null);
    const res = await request(app).get('/analytics').set('Authorization', tokenA());
    expect(res.status).toBe(401);
  });
});
