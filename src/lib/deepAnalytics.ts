/**
 * Небольшие, чистые расчёты для Pro-аналитики.
 *
 * Роут лишь читает базу и переводит даты в диапазоны. Правила расчёта живут
 * здесь, поэтому их можно проверить без Postgres и не размазывать формулы по
 * контроллеру и UI.
 */

import { tierOf } from './customerRoster';

export type Visit = { customerId: string; at: Date };

export type Retention = {
  windowDays: number;
  active: number;
  new: number;
  returning: number;
  reactivated: number;
  atRiskIds: string[];
  retentionRate: number | null;
};

const unique = (values: string[]) => new Set(values);

/**
 * ── «Під ризиком» тут і скрізь — це FADING з картотеки ───────────────────
 *
 * Раніше `atRiskIds` мав власне вікно «був 30–60 днів тому, не був за
 * останні 30». Хто не заходив понад 60 днів, зникав зі списку, хоча в
 * картотеці лишався «Згасає» (до 90). Тепер одне означення на весь
 * продукт: `tierOf` дає FADING — останній візит TIER_ACTIVE_DAYS…
 * TIER_FADING_DAYS днів тому. Другого обчислення відтоку немає.
 * `windowDays` на це не впливає: вікно потрібне лише для
 * active/new/returning/reactivated/retentionRate — вони описують рух за
 * період і відтоком не називаються.
 *
 * Повернення вважаємо тільки для клієнта, що був у попередньому такому ж
 * вікні. Новий — це той, чий перший підтверджений візит припав на поточне
 * вікно. Той, хто прийшов після паузи, не губиться між ними: це reactivated.
 */
export function retentionFromVisits(
  visits: Visit[],
  now: Date,
  windowDays: number,
): Retention {
  const ms = windowDays * 24 * 60 * 60 * 1000;
  const currentFrom = now.getTime() - ms;
  const previousFrom = currentFrom - ms;

  const byCustomer = new Map<string, number[]>();
  for (const visit of visits) {
    if (!Number.isFinite(visit.at.getTime()) || visit.at > now) continue;
    const dates = byCustomer.get(visit.customerId) ?? [];
    dates.push(visit.at.getTime());
    byCustomer.set(visit.customerId, dates);
  }

  const active: string[] = [];
  const previous: string[] = [];
  const older: string[] = [];
  const first = new Map<string, number>();

  for (const [id, dates] of byCustomer) {
    const earliest = Math.min(...dates);
    first.set(id, earliest);
    if (dates.some((at) => at >= currentFrom)) active.push(id);
    if (dates.some((at) => at >= previousFrom && at < currentFrom)) previous.push(id);
    if (dates.some((at) => at < previousFrom)) older.push(id);
  }

  const activeSet = unique(active);
  const previousSet = unique(previous);
  const olderSet = unique(older);
  const returning = active.filter((id) => previousSet.has(id));
  const fresh = active.filter((id) => (first.get(id) ?? 0) >= currentFrom);
  const reactivated = active.filter((id) => !previousSet.has(id) && olderSet.has(id));
  const atRiskIds: string[] = [];
  for (const [id, dates] of byCustomer) {
    const last = new Date(Math.max(...dates));
    if (tierOf(last, last, now) === 'FADING') atRiskIds.push(id);
  }

  return {
    windowDays,
    active: activeSet.size,
    new: unique(fresh).size,
    returning: unique(returning).size,
    reactivated: unique(reactivated).size,
    atRiskIds: [...unique(atRiskIds)],
    retentionRate: previousSet.size ? roundPct(returning.length / previousSet.size) : null,
  };
}

export type FunnelBooking = {
  status: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';
  priceTotal: number;
  paymentStatus: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'REFUNDED' | null;
};

export function bookingFunnel(rows: FunnelBooking[]) {
  const byStatus = {
    PENDING: 0, CONFIRMED: 0, CANCELLED: 0, EXPIRED: 0,
  };
  let cancelledValue = 0;
  let expiredValue = 0;
  let onlinePaid = 0;
  let onlinePending = 0;

  for (const row of rows) {
    byStatus[row.status] += 1;
    if (row.status === 'CANCELLED') cancelledValue += row.priceTotal;
    if (row.status === 'EXPIRED') expiredValue += row.priceTotal;
    if (row.paymentStatus === 'PAID') onlinePaid += 1;
    if (row.paymentStatus === 'PENDING') onlinePending += 1;
  }

  const resolved = byStatus.CONFIRMED + byStatus.CANCELLED + byStatus.EXPIRED;
  return {
    total: rows.length,
    ...byStatus,
    cancellationRate: resolved ? roundPct(byStatus.CANCELLED / resolved) : null,
    conversionRate: resolved ? roundPct(byStatus.CONFIRMED / resolved) : null,
    cancelledValue,
    expiredValue,
    onlinePaid,
    onlinePending,
  };
}

export function roundPct(value: number): number {
  return Math.round(value * 10_000) / 100;
}
