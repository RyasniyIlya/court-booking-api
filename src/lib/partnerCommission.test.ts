import { describe, expect, it } from 'vitest';
import { calcCommissions, commissionRate } from './partnerCommission';

const rates = { rateFirstYear: 50, rateAfter: 20 };
const attached = new Date('2026-01-15T10:00:00.000Z');

const inv = (id: string, amount: number, status: string, paidAt: string | null) => ({
  id, clubId: 'c1', amount, status, paidAt: paidAt ? new Date(paidAt) : null,
});
const club = (invoices: ReturnType<typeof inv>[], partnerAttachedAt: Date | null = attached) => [
  { id: 'c1', partnerAttachedAt, invoices },
];

describe('commissionRate: межа 12 місяців', () => {
  it('за мить до межі — перша ставка, рівно на межі — друга', () => {
    expect(commissionRate(attached, new Date('2027-01-15T09:59:59.999Z'), rates)).toBe(50);
    expect(commissionRate(attached, new Date('2027-01-15T10:00:00.000Z'), rates)).toBe(20);
  });
});

describe('calcCommissions', () => {
  it('рахує 50% у перший рік і 20% після, з округленням до копійки', () => {
    const r = calcCommissions(
      club([inv('a', 100000, 'PAID', '2026-02-01T00:00:00Z'), inv('b', 100001, 'PAID', '2027-02-01T00:00:00Z')]),
      rates,
    );
    const a = r.rows.find((x) => x.invoiceId === 'a')!;
    const b = r.rows.find((x) => x.invoiceId === 'b')!;
    expect(a).toMatchObject({ rate: 50, commission: 50000 });
    expect(b).toMatchObject({ rate: 20, commission: 20000 }); // 20000.2 -> 20000
    expect(r.accrued).toBe(70000);
  });

  it('неоплачені (ISSUED) і VOID не рахуються', () => {
    const r = calcCommissions(
      club([inv('a', 100000, 'ISSUED', null), inv('b', 100000, 'VOID', '2026-03-01T00:00:00Z'), inv('c', 100000, 'PAID', '2026-03-01T00:00:00Z')]),
      rates,
    );
    expect(r.rows.map((x) => x.invoiceId)).toEqual(['c']);
    expect(r.accrued).toBe(50000);
  });

  it('оплата до привʼязки не рахується; у момент привʼязки — рахується', () => {
    const r = calcCommissions(
      club([inv('a', 100000, 'PAID', '2026-01-15T09:59:59Z'), inv('b', 100000, 'PAID', '2026-01-15T10:00:00Z')]),
      rates,
    );
    expect(r.rows.map((x) => x.invoiceId)).toEqual(['b']);
  });

  it('клуб без привʼязки нічого не дає', () => {
    const r = calcCommissions(club([inv('a', 100000, 'PAID', '2026-03-01T00:00:00Z')], null), rates);
    expect(r.rows).toEqual([]);
    expect(r.accrued).toBe(0);
  });

  it('виплати: до виплати = нараховано - виплачено', () => {
    const r = calcCommissions(club([inv('a', 100000, 'PAID', '2026-03-01T00:00:00Z')]), rates, [{ amount: 20000 }, { amount: 5000 }]);
    expect(r).toMatchObject({ accrued: 50000, paid: 25000, due: 25000 });
    expect(r.byClub).toEqual({ c1: 50000 });
  });

  it('використовує індивідуальні ставки партнера', () => {
    const r = calcCommissions(club([inv('a', 100000, 'PAID', '2026-03-01T00:00:00Z')]), { rateFirstYear: 30, rateAfter: 10 });
    expect(r.accrued).toBe(30000);
  });
});
