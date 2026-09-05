import { describe, expect, it } from 'vitest';
import { bookingFunnel, retentionFromVisits } from './deepAnalytics';

describe('retentionFromVisits', () => {
  const now = new Date('2026-09-01T12:00:00Z');
  const days = (n: number) => new Date(now.getTime() + n * 86_400_000);

  it('separates new, returning, reactivated and at-risk customers', () => {
    const data = retentionFromVisits([
      { customerId: 'returning', at: days(-45) }, { customerId: 'returning', at: days(-10) },
      { customerId: 'new', at: days(-4) },
      { customerId: 'back', at: days(-100) }, { customerId: 'back', at: days(-5) },
      { customerId: 'risk', at: days(-40) },
    ], now, 30);

    expect(data).toMatchObject({ active: 3, new: 1, returning: 1, reactivated: 1, retentionRate: 50 });
    expect(data.atRiskIds).toEqual(['risk']);
  });
});

describe('bookingFunnel', () => {
  it('keeps pending records out of the resolved conversion rate', () => {
    const data = bookingFunnel([
      { status: 'CONFIRMED', priceTotal: 1_000, paymentStatus: 'PAID' },
      { status: 'CANCELLED', priceTotal: 2_000, paymentStatus: null },
      { status: 'EXPIRED', priceTotal: 3_000, paymentStatus: 'EXPIRED' },
      { status: 'PENDING', priceTotal: 4_000, paymentStatus: 'PENDING' },
    ]);
    expect(data).toMatchObject({ conversionRate: 33.33, cancellationRate: 33.33, cancelledValue: 2_000, onlinePaid: 1 });
  });
});
