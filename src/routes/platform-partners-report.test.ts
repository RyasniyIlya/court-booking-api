import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/** Звіт оператора по партнерах: суми, фільтри, xlsx, авторизація. */

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '33333333-3333-4333-8333-333333333333';
const C1 = '22222222-2222-4222-8222-222222222222';
const C2 = '44444444-4444-4444-8444-444444444444';

const prisma = {
  partner: { findMany: vi.fn(), findUnique: vi.fn() },
  partnerPayout: { findMany: vi.fn() },
  club: { findMany: vi.fn() },
};
vi.mock('../lib/db', () => ({ prisma }));
vi.mock('../lib/platformMetrics', async (orig) => ({
  ...(await orig<typeof import('../lib/platformMetrics')>()),
  loadClubMetrics: vi.fn(async () => new Map()),
}));

const { JWT_SECRET } = await import('../lib/authSecret');
vi.stubEnv('PLATFORM_ADMIN_EMAIL', 'op@test.local');
vi.stubEnv('PLATFORM_ADMIN_PASSWORD_HASH', 'isolated-platform-fixture');
const { platformCredentialVersion } = await import('../lib/platformAuth');
const { platformRouter } = await import('./platform');
const app = express().use(express.json()).use(platformRouter);
const auth = `Bearer ${jwt.sign({ scope: 'platform', email: 'op@test.local', credentialVersion: platformCredentialVersion() }, JWT_SECRET)}`;

const d = (s: string) => new Date(`${s}T10:00:00Z`);
const inv = (id: string, clubId: string, amount: number, status: string, paidAt: string | null, issued = '2026-01-01') => ({
  id, clubId, amount, status, paidAt: paidAt ? d(paidAt) : null, issuedAt: d(issued),
  periodFrom: d('2026-01-01'), periodTo: d('2026-02-01'), method: 'transfer',
});
const club = (id: string, partnerId: string, invoices: ReturnType<typeof inv>[]) => ({
  id, name: `Клуб ${id.slice(0, 2)}`, city: 'Київ', partnerId, partnerAttachedAt: d('2026-01-01'),
  isActive: true, approvedAt: d('2026-01-01'), trialEndsAt: null, paidUntil: d('2027-01-01'), terminatedAt: null,
  billingPeriod: 'MONTH', planPrice: 100000, plan: { code: 'pro', name: 'Pro', price: 100000, period: 'MONTH' },
  invoices,
});

const partners = [
  { id: P1, name: 'П1', company: 'ТОВ Буд', rateFirstYear: 50, rateAfter: 20 },
  { id: P2, name: 'П2', company: null, rateFirstYear: 40, rateAfter: 10 },
];
const clubs = [
  club(C1, P1, [
    inv('i1', C1, 100000, 'PAID', '2026-02-10'),
    inv('i2', C1, 100000, 'PAID', '2026-03-10'),
    inv('i3', C1, 100000, 'ISSUED', null, '2026-03-20'),
    inv('i4', C1, 100000, 'VOID', null, '2026-03-21'),
  ]),
  club(C2, P2, [inv('i5', C2, 50000, 'PAID', '2026-03-05')]),
];
const payouts = [
  { id: 'p1', partnerId: P1, amount: 30000, paidAt: d('2026-03-15'), note: 'березень' },
  { id: 'p2', partnerId: P1, amount: 10000, paidAt: d('2026-04-15'), note: null },
];

beforeEach(() => {
  vi.resetAllMocks();
  prisma.partner.findMany.mockImplementation(async (a: { where?: { id?: string } }) =>
    a?.where?.id ? partners.filter((p) => p.id === a.where!.id) : partners);
  prisma.club.findMany.mockImplementation(async (a: { where: { partnerId: { in: string[] } } }) =>
    clubs.filter((c) => a.where.partnerId.in.includes(c.partnerId)));
  prisma.partnerPayout.findMany.mockImplementation(async (a: { where: { partnerId: { in: string[] } } }) =>
    payouts.filter((p) => a.where.partnerId.in.includes(p.partnerId)));
});

const get = (url: string) => request(app).get(url).set('Authorization', auth);

describe('звіт оператора по партнерах', () => {
  it('без токена — 401 (json і xlsx)', async () => {
    expect((await request(app).get('/partners/report')).status).toBe(401);
    expect((await request(app).get('/partners/report.xlsx')).status).toBe(401);
  });

  it('/partners/report не потрапляє в /partners/:id', async () => {
    const res = await get('/partners/report');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('partners');
  });

  it('суми сходяться: received = Σ PAID, commission + net = received', async () => {
    const res = await get('/partners/report');
    const { totals, partners: ps } = res.body;
    // P1: 2 x 1000 грн, 50% => 1000 грн; P2: 500 грн, 40% => 200 грн
    expect(totals.received).toBe(250000);
    expect(totals.commission).toBe(50000 + 50000 + 20000);
    expect(totals.commission + totals.net).toBe(totals.received);
    for (const p of ps) {
      expect(p.totals.commission + p.totals.net).toBe(p.totals.received);
      const clubsReceived = p.clubs.reduce((s: number, c: { received: number }) => s + c.received, 0);
      expect(clubsReceived).toBe(p.totals.received);
    }
    expect(totals.clubs).toBe(2);
    expect(totals.activeClubs).toBe(2);
    expect(totals.payoutsPaid).toBe(40000);
    expect(totals.due).toBe(120000 - 40000);
    expect(res.body.months.map((m: { month: string }) => m.month)).toEqual(['2026-02', '2026-03', '2026-04']);
  });

  it('неоплачені й VOID видно з commission 0', async () => {
    const res = await get('/partners/report');
    const invoices = res.body.partners[0].clubs[0].invoices;
    expect(invoices).toHaveLength(4);
    for (const id of ['i3', 'i4']) {
      const i = invoices.find((x: { id: string }) => x.id === id);
      expect(i.commission).toBe(0);
      expect(i.net).toBe(0);
    }
    const paid = invoices.find((x: { id: string }) => x.id === 'i1');
    expect(paid).toMatchObject({ rate: 50, commission: 50000, net: 50000, status: 'PAID' });
    expect(res.body.partners[0].clubs[0]).toMatchObject({ plan: { code: 'pro', name: 'Pro' }, priceMonthly: 100000 });
  });

  it('фільтр періоду по paidAt; due не залежить від періоду', async () => {
    const all = await get('/partners/report');
    const res = await get('/partners/report?from=2026-03-01&to=2026-03-31');
    const p1 = res.body.partners[0];
    expect(p1.totals.received).toBe(100000); // тільки i2
    expect(p1.totals.payoutsPaid).toBe(30000); // тільки p1
    expect(p1.totals.due).toBe(all.body.partners[0].totals.due);
    expect(res.body.totals.due).toBe(all.body.totals.due);
    expect(res.body.period).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    expect(res.body.months.map((m: { month: string }) => m.month)).toEqual(['2026-03']);
  });

  it('фільтр партнера', async () => {
    const res = await get(`/partners/report?partnerId=${P2}`);
    expect(res.body.partners).toHaveLength(1);
    expect(res.body.partners[0].id).toBe(P2);
    expect(res.body.totals.received).toBe(50000);
    expect(res.body.totals.clubs).toBe(1);
  });

  it('некоректні параметри — 400', async () => {
    expect((await get('/partners/report?from=bad')).status).toBe(400);
    expect((await get('/partners/report?partnerId=x')).status).toBe(400);
  });

  it('xlsx: content-type і zip-сигнатура', async () => {
    const res = await get('/partners/report.xlsx').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain('.xlsx');
    expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');
  });
});

describe('звіт: надійшло по профілях отримувача (bySeller)', () => {
  it('bySeller сходиться з received; рахунок несе seller; без профілю — окремий рядок', async () => {
    const S1 = { id: 's-1', label: 'ФОП (основний)', iban: 'UA00AAA' };
    const S2 = { id: 's-2', label: 'ТОВ', iban: 'UA00BBB' };
    const owners = new Map<string, typeof S1 | null>([['i1', S1], ['i2', S2], ['i3', S1], ['i5', null]]);
    for (const c of clubs) for (const i of c.invoices) (i as Record<string, unknown>).seller = owners.get(i.id) ?? null;
    try {
      const res = await get('/partners/report');
      const { totals } = res.body;
      expect(totals.bySeller.reduce((s: number, x: { received: number }) => s + x.received, 0)).toBe(totals.received);
      expect(totals.bySeller).toEqual([
        { sellerId: 's-1', label: 'ФОП (основний)', iban: 'UA00AAA', received: 100000 },
        { sellerId: 's-2', label: 'ТОВ', iban: 'UA00BBB', received: 100000 },
        { sellerId: null, label: null, iban: null, received: 50000 },
      ].sort((a, b) => b.received - a.received));
      const i1 = res.body.partners[0].clubs[0].invoices.find((x: { id: string }) => x.id === 'i1');
      expect(i1.seller).toEqual({ id: 's-1', label: 'ФОП (основний)' });
      const i3 = res.body.partners[0].clubs[0].invoices.find((x: { id: string }) => x.id === 'i3');
      expect(i3.seller).toEqual({ id: 's-1', label: 'ФОП (основний)' });
    } finally {
      for (const c of clubs) for (const i of c.invoices) delete (i as Record<string, unknown>).seller;
    }
  });
});
