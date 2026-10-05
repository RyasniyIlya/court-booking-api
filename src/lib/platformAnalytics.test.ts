import { describe, expect, it } from 'vitest';

import {
  bySeller, calcArr, calcMrr, churnByMonth, clubsByStatus, forecastNextQuarter, monthWindow, mrrByMonth,
  partnerChannel, receivedByMonth, trialConversion, type AClub, type AInvoice,
} from './platformAnalytics';

const NOW = new Date('2026-10-03T12:00:00Z');
const d = (s: string) => new Date(`${s}T12:00:00Z`);

const inv = (id: string, from: string, to: string, amount: number, sellerId: string | null = null): AInvoice => ({
  id, amount, paidAt: d(from), periodFrom: d(from), periodTo: d(to), sellerId, sellerLabel: sellerId ? 'Моно' : null,
});

const partner = { id: 'P', name: 'Ірина', rateFirstYear: 50, rateAfter: 20 };

const clubs: AClub[] = [
  {
    id: 'A', status: 'ACTIVE', priceMonthly: 100_000, trialEndsAt: null, partnerId: 'P', partnerAttachedAt: d('2026-01-10'),
    invoices: [inv('a1', '2026-09-05', '2026-10-05', 100_000, 's1'), inv('a0', '2026-08-05', '2026-09-05', 100_000, 's1')],
  },
  {
    id: 'B', status: 'ACTIVE', priceMonthly: 150_000, trialEndsAt: null, partnerId: null, partnerAttachedAt: null,
    invoices: [inv('b1', '2026-03-01', '2027-03-01', 1_000_000)],
  },
  { id: 'C', status: 'TRIAL', priceMonthly: 100_000, trialEndsAt: d('2026-10-20'), partnerId: null, partnerAttachedAt: null, invoices: [] },
  {
    id: 'D', status: 'DEBT', priceMonthly: 100_000, trialEndsAt: d('2026-06-15'), partnerId: null, partnerAttachedAt: null,
    invoices: [inv('d1', '2026-07-01', '2026-08-01', 100_000)],
  },
  { id: 'E', status: 'DISABLED', priceMonthly: 0, trialEndsAt: d('2026-05-01'), partnerId: null, partnerAttachedAt: null, invoices: [] },
  { id: 'F', status: 'LEAD', priceMonthly: 0, trialEndsAt: null, partnerId: null, partnerAttachedAt: null, invoices: [] },
];

describe('platformAnalytics', () => {
  it('monthWindow: старий -> поточний', () => {
    expect(monthWindow(3, NOW).map((m) => m.key)).toEqual(['2026-08', '2026-09', '2026-10']);
  });

  it('MRR лише з ACTIVE, ARR = MRR x 12', () => {
    expect(calcMrr(clubs)).toBe(250_000);
    expect(calcArr(250_000)).toBe(3_000_000);
  });

  it('mrrByMonth: рік ділиться на 10, пільга 7 днів', () => {
    expect(mrrByMonth(clubs, 4, NOW)).toEqual([
      { month: '2026-07', mrr: 200_000 },
      { month: '2026-08', mrr: 200_000 },
      { month: '2026-09', mrr: 200_000 },
      { month: '2026-10', mrr: 200_000 },
    ]);
  });

  it('clubsByStatus пропускає LEAD', () => {
    expect(clubsByStatus(clubs)).toEqual({ trial: 1, active: 2, debt: 1, disabled: 1 });
  });

  it('churn: D випав у серпні (період + пільга скінчились)', () => {
    const c = churnByMonth(clubs, 3, NOW);
    expect(c[0]).toEqual({ month: '2026-08', lost: 1, base: 2, rate: 0.5 });
    expect(c[1]).toEqual({ month: '2026-09', lost: 0, base: 2, rate: 0 });
    expect(churnByMonth([], 1, NOW)[0]).toEqual({ month: '2026-10', lost: 0, base: 0, rate: 0 });
  });

  it('trialConversion: триваючий пробний без оплат не рахується', () => {
    expect(trialConversion(clubs, NOW)).toEqual({ trials: 2, converted: 1, rate: 0.5 });
  });

  it('receivedByMonth і bySeller у вікні', () => {
    expect(receivedByMonth(clubs, 4, NOW)).toEqual([
      { month: '2026-07', received: 100_000 },
      { month: '2026-08', received: 100_000 },
      { month: '2026-09', received: 100_000 },
      { month: '2026-10', received: 0 },
    ]);
    expect(bySeller(clubs, 4, NOW)).toEqual([
      { sellerId: 's1', label: 'Моно', received: 200_000 },
      { sellerId: null, label: 'Без профілю', received: 100_000 },
    ]);
  });

  it('partnerChannel: частка, винагорода, топ, воронка', () => {
    const leads = [
      { stage: 'DEMO', clubId: null }, { stage: 'NEW', clubId: null },
      { stage: 'WON', clubId: 'A' }, { stage: 'PROPOSAL', clubId: 'D' },
    ];
    expect(partnerChannel(clubs, [partner], leads, 4, NOW)).toEqual({
      mrrShare: 0.4,
      partnerRevenue: 200_000,
      commission: 100_000,
      commissionPct: 50,
      topPartners: [{ id: 'P', name: 'Ірина', clubs: 1, mrr: 100_000, commission: 100_000 }],
      leadFunnel: { leads: 4, demo: 3, trial: 2, paying: 2 },
    });
  });

  it('forecast: активні x ціна x 3, виплата зі ставкою на дату', () => {
    expect(forecastNextQuarter(clubs, [partner], NOW)).toEqual({ received: 750_000, partnerPayouts: 150_000 });
    const switching = clubs.map((c) => (c.id === 'A' ? { ...c, partnerAttachedAt: d('2025-11-20') } : c));
    // 03.11 -> 50%, 03.12 і 03.01 -> 20%
    expect(forecastNextQuarter(switching, [partner], NOW).partnerPayouts).toBe(50_000 + 20_000 + 20_000);
  });
});
