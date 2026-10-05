import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/** Калькулятор ціни: preview з урахуванням кортів, множника, базової ціни. */

const prisma = {
  user: { findUnique: vi.fn() },
  club: { findUnique: vi.fn() },
  plan: { findUnique: vi.fn() },
};
vi.mock('../../lib/db', () => ({ prisma }));

const { billingRouter } = await import('./billing');
const { signToken } = await import('./shared');
const app = express().use(express.json()).use(billingRouter);

const userId = '44444444-4444-4444-8444-444444444444';
const clubId = '22222222-2222-4222-8222-222222222222';
const token = (role: string) =>
  `Bearer ${signToken({ userId, clubId, role, trainerId: null } as never, '1h', 'hash')}`;

const analyticsPlan = {
  id: 'p1', code: 'analytics', name: 'Аналітика', price: 2500_00, period: 'MONTH',
  tier: 2, featTrainers: true, featGroups: true, featAnalytics: true,
};

let role = 'OWNER';
beforeEach(() => {
  vi.resetAllMocks();
  role = 'OWNER';
  prisma.user.findUnique.mockImplementation(async () => ({ id: userId, clubId, role, trainerId: null, passwordHash: 'hash' }));
});

describe('GET /billing/price-preview', () => {
  it('1 корт без плану: базова ціна без множника', async () => {
    prisma.club.findUnique.mockResolvedValue({
      plan: null, planPrice: null, _count: { courts: 1 },
    });

    const res = await request(app).get('/billing/price-preview?courts=1').set('Authorization', token('OWNER'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      courts: 1,
      basePrice: 1000_00,
      multiplier: 1,
      monthlyPrice: 1000_00,
      customQuote: false,
      current: { courts: 1, monthlyPrice: 1000_00 },
      plan: null,
    });
  });

  it('3 корти без плану: базова ціна (на межі INCLUDED_COURTS)', async () => {
    prisma.club.findUnique.mockResolvedValue({
      plan: null, planPrice: null, _count: { courts: 2 },
    });

    const res = await request(app).get('/billing/price-preview?courts=3').set('Authorization', token('OWNER'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      courts: 3,
      basePrice: 1000_00,
      multiplier: 1,
      monthlyPrice: 1000_00,
      customQuote: false,
      current: { courts: 2, monthlyPrice: 1000_00 },
    });
  });

  it('7 кортів без плану: множник за парабола (1 + 0.15*4 + 0.006*16 ≈ 1.696), ціна округляється до 50 грн', async () => {
    prisma.club.findUnique.mockResolvedValue({
      plan: null, planPrice: null, _count: { courts: 5 },
    });

    const res = await request(app).get('/billing/price-preview?courts=7').set('Authorization', token('OWNER'));

    expect(res.status).toBe(200);
    // 1000_00 * (1 + 0.15*4 + 0.006*16) = 1000_00 * 1.696 = 1696_00 -> округли до 50 грн
    expect(res.body).toMatchObject({
      courts: 7,
      multiplier: expect.closeTo(1.696, 0.001),
      monthlyPrice: 1700_00, // 1696_00 округлено до 50 грн
      customQuote: false,
      current: { courts: 5, monthlyPrice: 1300_00 }, // 1000 * 1.3 = 1300_00
    });
  });

  it('12 кортів: на межі AUTO_MAX_COURTS, customQuote = false', async () => {
    prisma.club.findUnique.mockResolvedValue({
      plan: null, planPrice: null, _count: { courts: 3 },
    });

    const res = await request(app).get('/billing/price-preview?courts=12').set('Authorization', token('OWNER'));

    expect(res.status).toBe(200);
    expect(res.body.customQuote).toBe(false);
  });

  it('13 кортів: понад AUTO_MAX_COURTS, customQuote = true', async () => {
    prisma.club.findUnique.mockResolvedValue({
      plan: null, planPrice: null, _count: { courts: 5 },
    });

    const res = await request(app).get('/billing/price-preview?courts=13').set('Authorization', token('OWNER'));

    expect(res.status).toBe(200);
    expect(res.body.customQuote).toBe(true);
  });

  it('з планом: множиться на план-ціну', async () => {
    prisma.club.findUnique.mockResolvedValue({
      plan: analyticsPlan, planPrice: null, _count: { courts: 3 },
    });

    const res = await request(app).get('/billing/price-preview?courts=7').set('Authorization', token('OWNER'));

    expect(res.status).toBe(200);
    // 2500_00 * 1.696 = 4240_00 -> округли до 50 грн
    expect(res.body).toMatchObject({
      plan: { code: 'analytics', name: 'Аналітика' },
      basePrice: 2500_00,
      monthlyPrice: 4250_00, // 2500*1.696 округлено
      current: { monthlyPrice: 2500_00 }, // 3 корти = базова ціна плану
    });
  });

  it('індивідуальна ціна (planPrice): не множиться, повертається як є', async () => {
    prisma.club.findUnique.mockResolvedValue({
      plan: analyticsPlan, planPrice: 3000_00, _count: { courts: 5 },
    });

    const res = await request(app).get('/billing/price-preview?courts=7').set('Authorization', token('OWNER'));

    expect(res.status).toBe(200);
    // Індивідуальна ціна не множиться
    expect(res.body).toMatchObject({
      monthlyPrice: 3000_00,
      current: { monthlyPrice: 3000_00 },
    });
  });

  it('інший план за ?plan=code', async () => {
    const basicPlan = {
      id: 'p0', code: 'basic', name: 'Базовий', price: 1500_00, period: 'MONTH',
      tier: 1, featTrainers: false, featGroups: false, featAnalytics: false,
    };
    prisma.club.findUnique.mockResolvedValue({
      plan: analyticsPlan, planPrice: null, _count: { courts: 3 },
    });
    prisma.plan.findUnique.mockResolvedValue(basicPlan);

    const res = await request(app).get('/billing/price-preview?courts=7&plan=basic').set('Authorization', token('OWNER'));

    expect(res.status).toBe(200);
    expect(res.body.plan).toMatchObject({ code: 'basic', name: 'Базовий' });
    expect(res.body.basePrice).toBe(1500_00);
    // 1500_00 * 1.696 = 2544_00 -> округли до 50 грн
    expect(res.body.monthlyPrice).toBe(2550_00);
  });

  it('невідомий план за ?plan=code — 400', async () => {
    prisma.club.findUnique.mockResolvedValue({
      plan: analyticsPlan, planPrice: null, _count: { courts: 3 },
    });
    prisma.plan.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/billing/price-preview?courts=7&plan=unknown').set('Authorization', token('OWNER'));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('PLAN_NOT_FOUND');
  });

  it('courts > 50 — 400', async () => {
    const res = await request(app).get('/billing/price-preview?courts=51').set('Authorization', token('OWNER'));
    expect(res.status).toBe(400);
  });

  it('courts < 1 — 400', async () => {
    const res = await request(app).get('/billing/price-preview?courts=0').set('Authorization', token('OWNER'));
    expect(res.status).toBe(400);
  });

  it('courts не число — 400', async () => {
    const res = await request(app).get('/billing/price-preview?courts=abc').set('Authorization', token('OWNER'));
    expect(res.status).toBe(400);
  });

  it('ADMIN може теж використовувати', async () => {
    role = 'ADMIN';
    prisma.club.findUnique.mockResolvedValue({
      plan: null, planPrice: null, _count: { courts: 2 },
    });

    const res = await request(app).get('/billing/price-preview?courts=5').set('Authorization', token('ADMIN'));

    expect(res.status).toBe(200);
    expect(res.body.courts).toBe(5);
  });

  it('без авторизації — 401', async () => {
    const res = await request(app).get('/billing/price-preview?courts=5');
    expect(res.status).toBe(401);
  });
});
