import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = { club: { findMany: vi.fn() } };
vi.mock('./db', () => ({ prisma }));

const mockLoadClubMetrics = vi.fn();
const mockClubListPrice = vi.fn();
vi.mock('./platformMetrics', () => ({
  loadClubMetrics: mockLoadClubMetrics,
  clubListPrice: mockClubListPrice,
}));

const { groupEarningsByMonth, buildForecast } = await import('./partnerAnalytics');

describe('groupEarningsByMonth', () => {
  it('групує комісії по місяцях', () => {
    const rows = [
      { paidAt: new Date('2026-10-01'), commission: 10000 },
      { paidAt: new Date('2026-09-01'), commission: 20000 },
    ];
    const result = groupEarningsByMonth(rows);
    expect(result).toHaveLength(12);
  });

  it('групує рядки в одному місяці Kyiv; 2026-05-31T22:30Z → June 2026', () => {
    const rows = [
      // 2026-05-31T22:30Z = 2026-06-01T01:30 in Europe/Kyiv (UTC+3), so June
      { paidAt: new Date('2026-05-31T22:30:00.000Z'), commission: 10000 },
      { paidAt: new Date('2026-05-31T23:00:00.000Z'), commission: 15000 },
      { paidAt: new Date('2026-06-01T00:00:00.000Z'), commission: 5000 },
    ];
    const result = groupEarningsByMonth(rows);
    expect(result).toHaveLength(12);
    const juneRow = result.find((r) => r.month === '2026-06');
    expect(juneRow?.commission).toBe(30000);
  });
});

describe('buildForecast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('повертає нулі, якщо нема активних клубів', async () => {
    prisma.club.findMany.mockResolvedValue([]);
    const result = await buildForecast('p1', { rateFirstYear: 50, rateAfter: 20 });
    expect(result).toEqual({ nextQuarter: 0, next12Months: 0 });
  });

  it('включає ACTIVE клубів', async () => {
    const now = new Date('2026-10-03T12:00:00.000Z');
    const attachedAt = new Date('2024-10-03T12:00:00.000Z');
    prisma.club.findMany.mockResolvedValue([
      {
        id: 'c1',
        isActive: true,
        partnerAttachedAt: attachedAt,
        approvedAt: new Date('2024-10-03'),
        trialEndsAt: null,
        paidUntil: new Date('2026-11-03'),
        terminatedAt: null,
        plan: { price: 500000, period: 'month' },
        planPrice: null,
        billingPeriod: 'month',
        courts: [{ id: 'c' }],
        invoices: [{ paidAt: new Date('2026-10-01') }],
      },
    ]);

    const mockMetrics = new Map();
    mockMetrics.set('c1', { activeCourts: 1, courts: 1 });
    mockLoadClubMetrics.mockResolvedValue(mockMetrics);

    mockClubListPrice.mockReturnValue({
      period: 'month',
      listPrice: 250000,
      listPriceMonthly: 250000,
      priceSource: 'plan',
    });

    const result = await buildForecast('p1', { rateFirstYear: 50, rateAfter: 20 }, now);
    expect(result.next12Months).toBe(600000);
  });

  it('виключає TRIAL та DEBT клубів', async () => {
    const now = new Date('2026-10-03T12:00:00.000Z');
    const attachedAt = new Date('2024-10-03T12:00:00.000Z');
    prisma.club.findMany.mockResolvedValue([
      {
        id: 'trial',
        isActive: true,
        partnerAttachedAt: attachedAt,
        approvedAt: null,
        trialEndsAt: new Date('2026-11-01'),
        paidUntil: null,
        terminatedAt: null,
        plan: { price: 500000, period: 'month' },
        planPrice: null,
        billingPeriod: 'month',
        courts: [{ id: 'c' }],
        invoices: [],
      },
      {
        id: 'active',
        isActive: true,
        partnerAttachedAt: attachedAt,
        approvedAt: new Date('2026-08-01'),
        trialEndsAt: null,
        paidUntil: new Date('2026-11-03'),
        terminatedAt: null,
        plan: { price: 500000, period: 'month' },
        planPrice: null,
        billingPeriod: 'month',
        courts: [{ id: 'c' }],
        invoices: [{ paidAt: new Date('2026-10-01') }],
      },
    ]);

    const mockMetrics = new Map();
    mockMetrics.set('active', { activeCourts: 1, courts: 1 });
    mockLoadClubMetrics.mockResolvedValue(mockMetrics);

    mockClubListPrice.mockReturnValue({
      period: 'month',
      listPrice: 250000,
      listPriceMonthly: 250000,
      priceSource: 'plan',
    });

    const result = await buildForecast('p1', { rateFirstYear: 50, rateAfter: 20 }, now);
    expect(result.next12Months).toBe(600000);
    const metricsCall = mockLoadClubMetrics.mock.calls[0][0];
    expect(metricsCall).toEqual(['active']);
  });

  it('клуб приєднаний 11 місяців назад: 250000, rates 50/20 → nextQuarter 225000, next12Months 675000', async () => {
    //計算: Now = 2026-10-03, attached 11 months ago = 2025-11-03
    // Rate switches at 2026-11-03
    // Forecast months: Nov 2026, Dec 2026, ..., Oct 2027
    // Month 1 (Nov 2026, before switch): 250000 * 50% = 125000 (counted in nextQuarter)
    // Months 2-3 (Dec-Jan, after switch): 250000 * 20% = 50000 each (counted in nextQuarter)
    // nextQuarter = 125000 + 50000 + 50000 = 225000
    // Months 4-12: 50000 each
    // next12Months = 125000 + 50000 * 11 = 675000
    const now = new Date('2026-10-03T12:00:00.000Z');
    const attachedAt = new Date('2025-11-03T12:00:00.000Z'); // 11 months ago
    prisma.club.findMany.mockResolvedValue([
      {
        id: 'c1',
        isActive: true,
        partnerAttachedAt: attachedAt,
        approvedAt: new Date('2025-11-03'),
        trialEndsAt: null,
        paidUntil: new Date('2027-11-03'),
        terminatedAt: null,
        plan: { price: 500000, period: 'month' },
        planPrice: null,
        billingPeriod: 'month',
        courts: [{ id: 'c' }],
        invoices: [{ paidAt: new Date('2026-10-01') }],
      },
    ]);

    const mockMetrics = new Map();
    mockMetrics.set('c1', { activeCourts: 1, courts: 1 });
    mockLoadClubMetrics.mockResolvedValue(mockMetrics);

    mockClubListPrice.mockReturnValue({
      period: 'month',
      listPrice: 250000,
      listPriceMonthly: 250000,
      priceSource: 'plan',
    });

    const result = await buildForecast('p1', { rateFirstYear: 50, rateAfter: 20 }, now);
    expect(result.nextQuarter).toBe(225000);
    expect(result.next12Months).toBe(675000);
  });

  it('клуб приєднаний 2 роки назад: 250000, rates 50/20 → nextQuarter 150000, next12Months 600000', async () => {
    // Rate switched at 2025-10-03 (12 months after attachment)
    // All 12 forecast months (Nov 2026 onwards) use rateAfter (20%)
    // Monthly: 250000 * 20% = 50000
    // nextQuarter: 50000 * 3 = 150000
    // next12Months: 50000 * 12 = 600000
    const now = new Date('2026-10-03T12:00:00.000Z');
    const attachedAt = new Date('2024-10-03T12:00:00.000Z'); // 2 years ago
    prisma.club.findMany.mockResolvedValue([
      {
        id: 'c1',
        isActive: true,
        partnerAttachedAt: attachedAt,
        approvedAt: new Date('2024-10-03'),
        trialEndsAt: null,
        paidUntil: new Date('2026-11-03'),
        terminatedAt: null,
        plan: { price: 500000, period: 'month' },
        planPrice: null,
        billingPeriod: 'month',
        courts: [{ id: 'c' }],
        invoices: [{ paidAt: new Date('2026-10-01') }],
      },
    ]);

    const mockMetrics = new Map();
    mockMetrics.set('c1', { activeCourts: 1, courts: 1 });
    mockLoadClubMetrics.mockResolvedValue(mockMetrics);

    mockClubListPrice.mockReturnValue({
      period: 'month',
      listPrice: 250000,
      listPriceMonthly: 250000,
      priceSource: 'plan',
    });

    const result = await buildForecast('p1', { rateFirstYear: 50, rateAfter: 20 }, now);
    expect(result.nextQuarter).toBe(150000);
    expect(result.next12Months).toBe(600000);
  });

  it('два ACTIVE клуби по 100000 за 2 роки → next12Months 480000', async () => {
    // Each club: 100000 * 20% = 20000/month (both past rate switch)
    // Per club: 20000 * 12 = 240000
    // Two clubs: 240000 * 2 = 480000
    const now = new Date('2026-10-03T12:00:00.000Z');
    const attachedAt = new Date('2024-10-03T12:00:00.000Z');
    prisma.club.findMany.mockResolvedValue([
      {
        id: 'c1',
        isActive: true,
        partnerAttachedAt: attachedAt,
        approvedAt: new Date('2024-10-03'),
        trialEndsAt: null,
        paidUntil: new Date('2026-11-03'),
        terminatedAt: null,
        plan: { price: 500000, period: 'month' },
        planPrice: null,
        billingPeriod: 'month',
        courts: [{ id: 'c1' }],
        invoices: [{ paidAt: new Date('2026-10-01') }],
      },
      {
        id: 'c2',
        isActive: true,
        partnerAttachedAt: attachedAt,
        approvedAt: new Date('2024-10-03'),
        trialEndsAt: null,
        paidUntil: new Date('2026-11-03'),
        terminatedAt: null,
        plan: { price: 500000, period: 'month' },
        planPrice: null,
        billingPeriod: 'month',
        courts: [{ id: 'c2' }],
        invoices: [{ paidAt: new Date('2026-10-01') }],
      },
    ]);

    const mockMetrics = new Map();
    mockMetrics.set('c1', { activeCourts: 1, courts: 1 });
    mockMetrics.set('c2', { activeCourts: 1, courts: 1 });
    mockLoadClubMetrics.mockResolvedValue(mockMetrics);

    mockClubListPrice.mockReturnValue({
      period: 'month',
      listPrice: 100000,
      listPriceMonthly: 100000,
      priceSource: 'plan',
    });

    const result = await buildForecast('p1', { rateFirstYear: 50, rateAfter: 20 }, now);
    expect(result.next12Months).toBe(480000);
  });

  it('клубі без partnerAttachedAt або без metrics пропущені', async () => {
    const now = new Date('2026-10-03T12:00:00.000Z');
    const attachedAt = new Date('2024-10-03T12:00:00.000Z');
    prisma.club.findMany.mockResolvedValue([
      {
        id: 'no-attached-at',
        isActive: true,
        partnerAttachedAt: null, // missing
        approvedAt: new Date('2024-10-03'),
        trialEndsAt: null,
        paidUntil: new Date('2026-11-03'),
        terminatedAt: null,
        plan: { price: 500000, period: 'month' },
        planPrice: null,
        billingPeriod: 'month',
        courts: [{ id: 'c' }],
        invoices: [{ paidAt: new Date('2026-10-01') }],
      },
      {
        id: 'c1',
        isActive: true,
        partnerAttachedAt: attachedAt,
        approvedAt: new Date('2024-10-03'),
        trialEndsAt: null,
        paidUntil: new Date('2026-11-03'),
        terminatedAt: null,
        plan: { price: 500000, period: 'month' },
        planPrice: null,
        billingPeriod: 'month',
        courts: [{ id: 'c' }],
        invoices: [{ paidAt: new Date('2026-10-01') }],
      },
    ]);

    const mockMetrics = new Map();
    mockMetrics.set('c1', { activeCourts: 1, courts: 1 });
    // no-attached-at is not in metrics
    mockLoadClubMetrics.mockResolvedValue(mockMetrics);

    mockClubListPrice.mockReturnValue({
      period: 'month',
      listPrice: 250000,
      listPriceMonthly: 250000,
      priceSource: 'plan',
    });

    const result = await buildForecast('p1', { rateFirstYear: 50, rateAfter: 20 }, now);
    // Only c1 should contribute: 250000 * 20% * 12 = 600000
    expect(result.next12Months).toBe(600000);
  });
});
