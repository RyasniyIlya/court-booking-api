import { DateTime } from 'luxon';
import type { CashRow } from './cashbook';
import { monthlyPnl, type ExpenseLike } from './financeReports';
import { courtValueOf, loadPassSessionValues, type ServiceValueBooking } from './serviceValue';

/**
 * Один прибуток — дві бази (рішення власника 2026-09-28, Ф-1).
 *
 *  - accrual («надано послуг», за замовчуванням): виручка за ДАТОЮ ПОСЛУГИ;
 *  - cash («каса»): виручка за датою РУХУ ГРОШЕЙ (ledger, онлайн, продаж абонементів).
 *
 * Витрати в обох базах ті самі — ClubExpense місяця. Різниця лише у виручці,
 * тому «Прибуток» на екрані «Виручка» й у фінансовому П&Л — те саме число.
 *
 * Визначення нарахованої виручки місяця (бронь CONFIRMED, startTime у місяці клубу):
 *   вартість корту  = courtValueOf(бронь, вартість заняття з абонемента)
 *   + гроші тренера й прокату = priceTotal − courtValueOf(бронь без абонемента)
 *   = для групових контейнерів — priceTotal (оплачені місця), без змін.
 * Гроші тренера мусять бути на стороні виручки, бо виплати тренерам — витрати:
 * інакше прибуток був би занижений. Заняття з абонемента лишається за
 * pass.price/totalSessions, а не по повній ціні корту.
 *
 * Відомі розбіжності з таблицею аудиту (docs/finance/audit-f0-report.md №01):
 * аудит брав сирий priceTotal (серпень 700 000, вересень 540 000). Після Ф-3
 * заняття з абонемента нараховуються по 40 000, а не 50 000 (2 заняття на
 * місяць, −20 000): серпень 680 000, вересень 520 000. Каса не змінилась.
 */

export type Basis = 'accrual' | 'cash';
export const BASES: readonly Basis[] = ['accrual', 'cash'];
export const otherBasis = (b: Basis): Basis => (b === 'accrual' ? 'cash' : 'accrual');

export type AccrualBooking = ServiceValueBooking & {
  id: string;
  startTime: Date;
  customer?: { discountPercent?: number | null } | null;
};

/** Нарахована виручка однієї броні: корт (з абонементом) + тренер/прокат. */
export function accrualValueOf(b: AccrualBooking, passValue?: number | null): number {
  const withDiscount = { ...b, discountPercent: b.discountPercent ?? b.customer?.discountPercent };
  const extras = Math.max(0, (Number.isFinite(b.priceTotal) ? b.priceTotal : 0) - courtValueOf(withDiscount));
  return courtValueOf(withDiscount, passValue) + extras;
}

/** Нарахована виручка по місяцях клубу ('yyyy-MM' у таймзоні клубу). */
export function accrualRevenueByMonth(
  bookings: AccrualBooking[],
  passValues: Map<string, number>,
  months: string[],
  tz: string,
): Map<string, number> {
  const out = new Map<string, number>(months.map((m) => [m, 0]));
  for (const b of bookings) {
    const m = DateTime.fromJSDate(b.startTime).setZone(tz).toFormat('yyyy-MM');
    if (!out.has(m)) continue;
    out.set(m, out.get(m)! + accrualValueOf(b, passValues.get(b.id)));
  }
  return out;
}

/** Нарахована виручка довільного набору броней (довільний період). */
export function accrualTotal(bookings: AccrualBooking[], passValues: Map<string, number>): number {
  return bookings.reduce((s, b) => s + accrualValueOf(b, passValues.get(b.id)), 0);
}

/** Мінімальний prisma для завантаження броней періоду. */
type BookingReader = {
  booking: { findMany: (args: any) => Promise<any[]> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  passUsage: Parameters<typeof loadPassSessionValues>[0]['passUsage'];
};

export async function loadAccrualBookings(prisma: BookingReader, clubId: string, from: Date, to: Date) {
  const bookings: AccrualBooking[] = await prisma.booking.findMany({
    where: { clubId, status: 'CONFIRMED', startTime: { gte: from, lte: to } },
    select: {
      id: true, startTime: true, priceTotal: true, rentalTotal: true, trainerPrice: true, capacity: true,
      customer: { select: { discountPercent: true } },
    },
  });
  const passValues = await loadPassSessionValues(prisma, bookings.map((b) => b.id));
  return { bookings, passValues };
}

/** Сума каси (без бонусів, повернення мінусом) за рядками. */
export function cashNet(rows: CashRow[]): number {
  return rows.reduce((s, r) => (r.method === 'BONUS' ? s : s + (r.kind === 'REFUND' ? -r.amount : r.amount)), 0);
}

export type BasisMonth = {
  month: string;
  basis: Basis;
  revenue: number;
  expenses: number;
  profit: number;
  alt: { basis: Basis; revenue: number; profit: number };
  accrual: { revenue: number; profit: number };
  cash: { revenue: number; profit: number };
  byCategory: Record<string, number>;
  expensesMissing: boolean;
  /** Псевдоніми попередніх полів: income = виручка обраної бази. */
  income: number;
};

/** Місяці П&Л для обраної бази: ті самі витрати, дві виручки. */
export function basisPnl(args: {
  basis: Basis;
  months: string[];
  tz: string;
  cashRows: CashRow[];
  expenses: ExpenseLike[];
  accrualByMonth: Map<string, number>;
}): BasisMonth[] {
  const { basis, months, tz, cashRows, expenses, accrualByMonth } = args;
  return monthlyPnl(cashRows, expenses, months, tz).map((m) => {
    const accRev = accrualByMonth.get(m.month) ?? 0;
    const accrual = { revenue: accRev, profit: accRev - m.expenses };
    const cash = { revenue: m.income, profit: m.profit };
    const sel = basis === 'accrual' ? accrual : cash;
    const alt = basis === 'accrual' ? cash : accrual;
    return {
      month: m.month,
      basis,
      revenue: sel.revenue,
      expenses: m.expenses,
      profit: sel.profit,
      alt: { basis: otherBasis(basis), revenue: alt.revenue, profit: alt.profit },
      accrual,
      cash,
      byCategory: m.byCategory,
      expensesMissing: m.expensesMissing,
      income: sel.revenue,
    };
  });
}
