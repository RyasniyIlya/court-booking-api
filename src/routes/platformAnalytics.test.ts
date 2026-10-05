import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const prisma = {
  club: { findMany: vi.fn() },
  partner: { findMany: vi.fn() },
  lead: { findMany: vi.fn() },
};
vi.mock('../lib/db', () => ({ prisma }));
vi.mock('../lib/platformMetrics', async (orig) => ({
  ...(await orig<typeof import('../lib/platformMetrics')>()),
  loadClubMetrics: vi.fn(async () => new Map()),
}));

const { JWT_SECRET } = await import('../lib/authSecret');
const { platformAnalyticsRouter } = await import('./platformAnalytics');

const app = express().use(express.json()).use(platformAnalyticsRouter);
vi.stubEnv('PLATFORM_ADMIN_EMAIL', 'op@test.local');
vi.stubEnv('PLATFORM_ADMIN_PASSWORD_HASH', 'isolated-platform-fixture');
const { platformCredentialVersion } = await import('../lib/platformAuth');
const auth = `Bearer ${jwt.sign({ scope: 'platform', email: 'op@test.local', credentialVersion: platformCredentialVersion() }, JWT_SECRET)}`;

beforeEach(() => {
  prisma.club.findMany.mockReset().mockResolvedValue([]);
  prisma.partner.findMany.mockReset().mockResolvedValue([]);
  prisma.lead.findMany.mockReset().mockResolvedValue([]);
});

describe('GET /analytics', () => {
  it('401 без токена', async () => {
    const r = await request(app).get('/analytics');
    expect(r.status).toBe(401);
    expect(prisma.club.findMany).not.toHaveBeenCalled();
  });

  it('400 на кривий months', async () => {
    const r = await request(app).get('/analytics?months=abc').set('Authorization', auth);
    expect(r.status).toBe(400);
  });

  it('форма відповіді', async () => {
    const day = 86_400_000;
    prisma.club.findMany.mockResolvedValue([{
      id: 'c1', isActive: true, approvedAt: new Date(), trialEndsAt: null, terminatedAt: null,
      paidUntil: new Date(Date.now() + 20 * day), partnerId: 'p1', partnerAttachedAt: new Date(Date.now() - 30 * day),
      planPrice: 100_000, billingPeriod: 'MONTH', plan: null,
      invoices: [{
        id: 'i1', amount: 100_000, status: 'PAID', paidAt: new Date(Date.now() - 10 * day),
        periodFrom: new Date(Date.now() - 10 * day), periodTo: new Date(Date.now() + 20 * day),
        sellerId: null, seller: null,
      }],
    }]);
    prisma.partner.findMany.mockResolvedValue([{ id: 'p1', name: 'Ірина', rateFirstYear: 50, rateAfter: 20 }]);
    prisma.lead.findMany.mockResolvedValue([{ stage: 'WON', clubId: 'c1' }]);

    const r = await request(app).get('/analytics?months=6').set('Authorization', auth);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual([
      'arr', 'bySeller', 'churn', 'clubsByStatus', 'forecastNextQuarter', 'mrr', 'mrrByMonth',
      'partnerChannel', 'receivedByMonth', 'trialConversion',
    ]);
    expect(r.body.mrr).toBe(100_000);
    expect(r.body.arr).toBe(1_200_000);
    expect(r.body.mrrByMonth).toHaveLength(6);
    expect(r.body.churn).toHaveLength(6);
    expect(r.body.clubsByStatus).toEqual({ trial: 0, active: 1, debt: 0, disabled: 0 });
    expect(Object.keys(r.body.partnerChannel).sort()).toEqual([
      'commission', 'commissionPct', 'leadFunnel', 'mrrShare', 'partnerRevenue', 'topPartners',
    ]);
    expect(r.body.forecastNextQuarter).toEqual({ received: 300_000, partnerPayouts: 150_000 });
  });
});
