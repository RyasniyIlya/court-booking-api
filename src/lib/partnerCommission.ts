import { DateTime } from 'luxon';

/**
 * Винагорода партнера — чиста функція без доступу до бази.
 *
 * Для кожного оплаченого (PAID) рахунку клубу партнера, оплаченого НЕ раніше
 * за дату привʼязки: ставка = rateFirstYear, якщо оплата в межах 12 місяців
 * від привʼязки (межа виключна), інакше rateAfter.
 * commission = round(amount * rate / 100) копійок.
 */

export type CommissionInvoice = {
  id: string;
  clubId: string;
  amount: number;
  status: string;
  paidAt: Date | null;
};

export type CommissionClub = {
  id: string;
  partnerAttachedAt: Date | null;
  invoices: CommissionInvoice[];
};

export type CommissionRates = { rateFirstYear: number; rateAfter: number };

export type CommissionRow = {
  invoiceId: string;
  clubId: string;
  paidAt: Date;
  amount: number;
  rate: number;
  commission: number;
};

export type CommissionResult = {
  rows: CommissionRow[];
  /** Нараховано всього, копійки */
  accrued: number;
  /** Виплачено, копійки */
  paid: number;
  /** До виплати = нараховано - виплачено, копійки */
  due: number;
  /** Нараховано по клубах, копійки */
  byClub: Record<string, number>;
};

export function commissionRate(attachedAt: Date, paidAt: Date, rates: CommissionRates): number {
  const boundary = DateTime.fromJSDate(attachedAt, { zone: 'utc' }).plus({ months: 12 }).toMillis();
  return paidAt.getTime() < boundary ? rates.rateFirstYear : rates.rateAfter;
}

export function calcCommissions(
  clubs: CommissionClub[],
  rates: CommissionRates,
  payouts: { amount: number }[] = [],
): CommissionResult {
  const rows: CommissionRow[] = [];
  const byClub: Record<string, number> = {};

  for (const club of clubs) {
    const attached = club.partnerAttachedAt;
    byClub[club.id] = 0;
    if (!attached) continue;
    for (const inv of club.invoices) {
      if (inv.status !== 'PAID' || !inv.paidAt) continue;
      if (inv.paidAt.getTime() < attached.getTime()) continue;
      const rate = commissionRate(attached, inv.paidAt, rates);
      const commission = Math.round((inv.amount * rate) / 100);
      rows.push({ invoiceId: inv.id, clubId: club.id, paidAt: inv.paidAt, amount: inv.amount, rate, commission });
      byClub[club.id] += commission;
    }
  }

  rows.sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime());
  const accrued = rows.reduce((s, r) => s + r.commission, 0);
  const paid = payouts.reduce((s, p) => s + p.amount, 0);
  return { rows, accrued, paid, due: accrued - paid, byClub };
}
