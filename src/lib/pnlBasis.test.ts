import { describe, expect, it } from 'vitest';
import type { CashRow } from './cashbook';
import { accrualRevenueByMonth, accrualValueOf, basisPnl, cashNet, type AccrualBooking } from './pnlBasis';

/**
 * Еталонний клуб (docs/finance/reference-club.md), серпень і вересень 2026.
 *
 * Розбіжність з таблицею аудиту №01: аудит брав сирий priceTotal (серпень
 * 700 000, вересень 540 000). Після Ф-3 заняття з абонемента (Настя, 2 на
 * місяць) нараховуються за ціною заняття 320 000 / 8 = 40 000, а не за повною
 * ціною корту 50 000: -20 000 щомісяця, тобто 680 000 і 520 000. Гроші тренера
 * й прокату лишаються в нарахуванні (виплати тренерам - витрати, тож виручка
 * з них має бути на іншому боці), тому більше нічого не міняється. Каса - без змін.
 */
const TZ = 'Europe/Kyiv';
let n = 0;
const bk = (start: string, priceTotal: number, extra: Partial<AccrualBooking> = {}): AccrualBooking => ({
  id: `b${++n}`, startTime: new Date(start), priceTotal, ...extra,
});

const august: AccrualBooking[] = [
  bk('2026-08-03T07:00:00Z', 50000), bk('2026-08-04T09:00:00Z', 40000), bk('2026-08-05T06:00:00Z', 50000),
  bk('2026-08-02T07:00:00Z', 50000), bk('2026-08-09T07:00:00Z', 50000), bk('2026-08-16T07:00:00Z', 50000),
  bk('2026-08-06T15:00:00Z', 45000, { capacity: 4, trainerPrice: 24000 }),
  bk('2026-08-11T07:00:00Z', 50000), // абонемент №1
  bk('2026-08-25T07:00:00Z', 50000), // абонемент №2
  bk('2026-08-10T12:00:00Z', 80000, { trainerPrice: 30000 }),
  bk('2026-08-12T14:00:00Z', 50000, { rentalTotal: 10000 }),
  bk('2026-08-15T08:00:00Z', 45000), bk('2026-08-22T05:00:00Z', 50000), bk('2026-08-28T13:00:00Z', 40000),
];
const september: AccrualBooking[] = [
  bk('2026-09-03T07:00:00Z', 50000), // абонемент №3
  bk('2026-09-17T07:00:00Z', 50000), // абонемент №4
  bk('2026-09-10T15:00:00Z', 45000, { capacity: 3 }),
  bk('2026-09-05T13:00:00Z', 40000), bk('2026-09-12T09:00:00Z', 40000),
  bk('2026-09-15T12:00:00Z', 80000, { trainerPrice: 30000 }),
  bk('2026-09-20T07:00:00Z', 50000), bk('2026-09-22T08:00:00Z', 50000),
  bk('2026-09-24T14:00:00Z', 45000, { rentalTotal: 5000 }),
  bk('2026-09-29T07:00:00Z', 40000), bk('2026-09-30T12:00:00Z', 50000),
];
const passValues = new Map<string, number>([
  [august[7].id, 40000], [august[8].id, 40000], [september[0].id, 40000], [september[1].id, 40000],
]);
const all = [...august, ...september];

const cash = (at: string, amount: number, extra: Partial<CashRow> = {}): CashRow => ({
  id: at + amount, at: new Date(at), kind: 'PAYMENT', method: 'CASH', account: '', amount,
  source: 'BOOKING', customer: null, description: '', actor: null, ...extra,
});
const cashRows = [
  cash('2026-08-10T10:00:00Z', 935000), cash('2026-08-18T16:00:00Z', 40000, { kind: 'REFUND' }),
  cash('2026-09-10T10:00:00Z', 355000),
];
const expenses = [
  { month: new Date('2026-08-01T00:00:00Z'), category: 'RENT', amount: 1500000 },
  { month: new Date('2026-08-01T00:00:00Z'), category: 'SALARY', amount: 1200000 },
  { month: new Date('2026-08-01T00:00:00Z'), category: 'BANK_FEE', amount: 50000 },
  { month: new Date('2026-09-01T00:00:00Z'), category: 'SALARY', amount: 1200000 },
];
const months = ['2026-08', '2026-09'];
const accrual = accrualRevenueByMonth(all, passValues, months, TZ);

describe('accrualValueOf', () => {
  it('приватна з тренером: корт + тренер = priceTotal; абонемент - за вартістю заняття', () => {
    const b = bk('2026-08-10T12:00:00Z', 80000, { trainerPrice: 30000 });
    expect(accrualValueOf(b)).toBe(80000);
    expect(accrualValueOf(b, 40000)).toBe(70000);
  });
  it('груповий контейнер без змін', () => {
    expect(accrualValueOf(bk('2026-08-06T15:00:00Z', 45000, { capacity: 4, trainerPrice: 24000 }))).toBe(45000);
  });
});

describe('еталонний клуб: надано послуг vs каса', () => {
  it('серпень: нарахування 680 000 (аудит 700 000 - 20 000 за абонемент), каса 895 000', () => {
    expect(accrual.get('2026-08')).toBe(680000);
    expect(cashNet(cashRows.slice(0, 2))).toBe(895000);
  });
  it('вересень: нарахування 520 000 (аудит 540 000 - 20 000), каса 355 000', () => {
    expect(accrual.get('2026-09')).toBe(520000);
  });

  it('accrual: прибуток і альтернатива рахуються з тих самих витрат', () => {
    const [aug, sep] = basisPnl({ basis: 'accrual', months, tz: TZ, cashRows, expenses, accrualByMonth: accrual });
    expect(aug).toMatchObject({
      basis: 'accrual', revenue: 680000, expenses: 2750000, profit: -2070000,
      alt: { basis: 'cash', revenue: 895000, profit: -1855000 },
    });
    expect(sep).toMatchObject({
      revenue: 520000, expenses: 1200000, profit: -680000,
      alt: { basis: 'cash', revenue: 355000, profit: -845000 },
    });
  });

  it('cash: бази міняються місцями, витрати ті самі', () => {
    const [aug, sep] = basisPnl({ basis: 'cash', months, tz: TZ, cashRows, expenses, accrualByMonth: accrual });
    expect(aug).toMatchObject({ basis: 'cash', revenue: 895000, profit: -1855000, income: 895000, alt: { basis: 'accrual', profit: -2070000 } });
    expect(sep).toMatchObject({ revenue: 355000, profit: -845000, expenses: 1200000, alt: { revenue: 520000, profit: -680000 } });
  });
});
