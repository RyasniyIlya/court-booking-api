import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/** Рахунок клубу: створення, ідемпотентність, ролі, реквізити, друкована форма. */

const prisma = {
  user: { findUnique: vi.fn() },
  club: { findUnique: vi.fn() },
  court: { count: vi.fn() },
  plan: { findMany: vi.fn() },
  clubInvoice: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  sellerProfile: { findFirst: vi.fn() },
};
vi.mock('../../lib/db', () => ({ prisma }));

const { billingRouter } = await import('./billing');
const { signToken } = await import('./shared');
const app = express().use(express.json()).use(billingRouter);

const userId = '44444444-4444-4444-8444-444444444444';
const clubId = '22222222-2222-4222-8222-222222222222';
const token = (role: string) =>
  `Bearer ${signToken({ userId, clubId, role, trainerId: null } as never, '1h', 'hash')}`;

const seller = {
  id: 's1', legalName: 'ФОП Тест', code: '1234567890', iban: 'UA213223130000026007233566001',
  bankName: 'Моно', taxInfo: null, address: null,
};
const clubRow = (over: Record<string, unknown> = {}) => ({
  id: clubId, name: 'Падел Клаб', paidUntil: null, planPrice: null, billingPeriod: 'MONTH', plan: null,
  _count: { courts: 2 }, ...over,
});

let role = 'OWNER';
beforeEach(() => {
  vi.resetAllMocks();
  role = 'OWNER';
  prisma.user.findUnique.mockImplementation(async () => ({ id: userId, clubId, role, trainerId: null, passwordHash: 'hash' }));
  prisma.sellerProfile.findFirst.mockResolvedValue(seller);
  prisma.clubInvoice.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'inv-1', ...data }));
});

describe('POST /billing/invoice', () => {
  it('створює ISSUED із сумою сервера (MONTH, 2 корти, без плану = 1000 грн), номером і sellerId', async () => {
    prisma.clubInvoice.findFirst.mockResolvedValue(null);
    prisma.club.findUnique.mockResolvedValue(clubRow());

    const res = await request(app).post('/billing/invoice').set('Authorization', token('OWNER')).send({ period: 'MONTH' });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    const { data } = prisma.clubInvoice.create.mock.calls[0][0];
    expect(data).toMatchObject({ clubId, amount: 1000_00, status: 'ISSUED', sellerId: 's1' });
    expect(data.number).toMatch(/^К-\d{4}-00001$/);
  });

  it('рік рахується серверною формулою (10 місяців), клієнтська сума ігнорується', async () => {
    prisma.clubInvoice.findFirst.mockResolvedValue(null);
    prisma.club.findUnique.mockResolvedValue(clubRow());

    await request(app).post('/billing/invoice').set('Authorization', token('OWNER')).send({ period: 'YEAR', amount: 1 });

    expect(prisma.clubInvoice.create.mock.calls[0][0].data.amount).toBe(10_000_00);
  });

  it('номер продовжує лічильник року', async () => {
    const year = new Date().getFullYear();
    prisma.clubInvoice.findFirst
      .mockResolvedValueOnce(null) // відкритого немає
      .mockResolvedValueOnce({ number: `К-${year}-00041` });
    prisma.club.findUnique.mockResolvedValue(clubRow());

    await request(app).post('/billing/invoice').set('Authorization', token('OWNER')).send({ period: 'MONTH' });

    expect(prisma.clubInvoice.create.mock.calls[0][0].data.number).toBe(`К-${year}-00042`);
  });

  it('є відкритий ISSUED — повертає його (200), нового не створює', async () => {
    prisma.clubInvoice.findFirst.mockResolvedValue({ id: 'old', number: 'К-2026-00007', amount: 1000_00, status: 'ISSUED' });

    const res = await request(app).post('/billing/invoice').set('Authorization', token('OWNER')).send({ period: 'QUARTER' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: false, invoice: { id: 'old' } });
    expect(prisma.clubInvoice.create).not.toHaveBeenCalled();
  });

  it('ADMIN — 403, без запису', async () => {
    role = 'ADMIN';
    const res = await request(app).post('/billing/invoice').set('Authorization', token('ADMIN')).send({ period: 'MONTH' });
    expect(res.status).toBe(403);
    expect(prisma.clubInvoice.create).not.toHaveBeenCalled();
  });

  it('невідомий період — 400', async () => {
    const res = await request(app).post('/billing/invoice').set('Authorization', token('OWNER')).send({ period: 'WEEK' });
    expect(res.status).toBe(400);
  });
});

describe('GET /billing — openInvoice і payTo', () => {
  const setup = (open: unknown) => {
    prisma.club.findUnique.mockResolvedValue({
      paidUntil: null, trialEndsAt: null, billingPeriod: 'MONTH', isActive: true, createdAt: new Date(),
      planPrice: null, name: 'Падел Клаб', plan: null,
    });
    prisma.court.count.mockResolvedValue(2);
    prisma.plan.findMany.mockResolvedValue([]);
    prisma.clubInvoice.findMany.mockResolvedValue([]);
    prisma.clubInvoice.findFirst.mockResolvedValue(open);
  };

  it('payTo з призначенням платежу за номером рахунку', async () => {
    setup({ id: 'i1', number: 'К-2026-00005', amount: 1000_00, status: 'ISSUED' });
    const res = await request(app).get('/billing').set('Authorization', token('ADMIN'));
    expect(res.status).toBe(200);
    expect(res.body.openInvoice.number).toBe('К-2026-00005');
    expect(res.body.payTo).toEqual({
      legalName: 'ФОП Тест', code: '1234567890', iban: seller.iban, bankName: 'Моно',
      purpose: 'Оплата підписки КОРТ, рахунок №К-2026-00005, Падел Клаб, без ПДВ',
    });
  });

  it('профілю отримувача немає — payTo null', async () => {
    setup(null);
    prisma.sellerProfile.findFirst.mockResolvedValue(null);
    const res = await request(app).get('/billing').set('Authorization', token('OWNER'));
    expect(res.body.payTo).toBeNull();
    expect(res.body.openInvoice).toBeNull();
  });
});

describe('GET /billing/invoice/:id/html', () => {
  it('екранує дані й віддає суворий CSP', async () => {
    prisma.clubInvoice.findFirst.mockResolvedValue({
      id: 'i1', number: 'К-2026-00005', amount: 1000_00, status: 'ISSUED',
      periodFrom: new Date('2026-10-01T00:00:00Z'), periodTo: new Date('2026-11-01T00:00:00Z'),
      issuedAt: new Date('2026-10-03T00:00:00Z'), paidAt: null,
      club: { name: '<script>alert(1)</script>Клуб', legalName: '<img src=x onerror=1>', legalCode: '123' },
      seller: { legalName: 'ФОП <b>Тест</b>', code: '1', taxInfo: null, iban: 'UA1', bankName: 'Моно', address: null },
    });

    const res = await request(app).get('/billing/invoice/i1/html').set('Authorization', token('ADMIN'));

    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.text).not.toContain('<script>');
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).not.toContain('<b>Тест');
    expect(res.text).toContain('&lt;script&gt;');
    expect(res.text).toContain('К-2026-00005');
    expect(res.text).toMatch(/1\s000,00/);
  });

  it('чужий або відсутній рахунок — 404 (пошук обмежений clubId)', async () => {
    prisma.clubInvoice.findFirst.mockResolvedValue(null);
    const res = await request(app).get('/billing/invoice/zzz/html').set('Authorization', token('OWNER'));
    expect(res.status).toBe(404);
    expect(prisma.clubInvoice.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'zzz', clubId });
  });
});
