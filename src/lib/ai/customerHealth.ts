import { prisma } from '../db';
import { TIER_ACTIVE_DAYS, TIER_FADING_DAYS, TIER_NEW_VISITS, tierOf, type CustomerTier } from '../customerRoster';
import { retentionFromVisits } from '../deepAnalytics';

/**
 * «Здоров'я» клієнтської бази для нейроаналітика власника: скільки людей у
 * кожному сегменті й скільки грошей на місяць під ризиком, БЕЗ жодного
 * імені чи телефону — щоб побачити людей, аналітик радить фільтр у кабінеті
 * («Клієнти → Згасає»), а не називає їх сам.
 *
 * ── Чому не просто `loadRoster` ──────────────────────────────────────────
 *
 * `loadRoster` тягне повну картку (ім'я, телефон, email, нотатку, мітки) —
 * саме те, чого тут не повинно бути навіть у пам'яті процесу перед тим, як
 * піде в модель. Тому свій, вужчий запит: тільки `id`/`createdAt` клієнта і
 * дата+ціна візиту, з тих самих двох джерел (Booking, BookingSeat), що й
 * картотека, — щоб сегменти тут і на екрані «Клієнти» не розійшлись.
 *
 * ── Одне число «під ризиком» ─────────────────────────────────────────────
 *
 * «Під ризиком» = сегмент FADING з `tierOf` (останній візит 30–90 днів
 * тому), рівно як у картотеці й Deep. Окремого вікна 30+30 тут більше
 * немає: `last30d` описує рух за період (active/new/returning/…) і
 * відтоком не називається. Усі візити віддаємо в `retentionFromVisits`
 * цілком, без обрізання до 60 днів, — тоді клієнт, який ходив рік тому й
 * повернувся, лишається «поверненцем» без жодних синтетичних точок.
 */

const WINDOW_DAYS = 30;

type VisitRow = { customerId: string; at: Date; price: number };

export type CustomerHealth = {
  totalCustomers: number;
  segments: Record<CustomerTier, number>;
  thresholds: { activeDays: number; fadingDays: number; newVisits: number };
  last30d: {
    active: number; new: number; returning: number; reactivated: number;
    retentionPct: number | null;
  };
  /** «Під ризиком» = сегмент FADING (те саме число, що в картотеці й Deep). */
  atRisk: number;
  /** Скільки грошей на місяць під ризиком: витрати FADING-клієнтів за 30 днів до їхнього останнього візиту. */
  atRiskValueUah: number;
};

export async function loadCustomerHealth(clubId: string, now: Date = new Date()): Promise<CustomerHealth> {
  const [customers, bookings, seats] = await Promise.all([
    prisma.customer.findMany({ where: { clubId }, select: { id: true, createdAt: true } }),
    prisma.booking.findMany({
      where: { clubId, status: 'CONFIRMED', customerId: { not: null }, startTime: { lte: now } },
      select: { customerId: true, startTime: true, priceTotal: true },
    }),
    prisma.bookingSeat.findMany({
      where: { status: 'BOOKED', customerId: { not: null }, booking: { clubId, status: 'CONFIRMED', startTime: { lte: now } } },
      select: { customerId: true, price: true, booking: { select: { startTime: true } } },
    }),
  ]);

  const allVisits: VisitRow[] = [
    ...bookings.map((b) => ({ customerId: b.customerId as string, at: b.startTime, price: b.priceTotal })),
    ...seats.map((s) => ({ customerId: s.customerId as string, at: s.booking.startTime, price: s.price })),
  ];

  return buildCustomerHealth({ customers, allVisits }, now);
}

export function buildCustomerHealth(
  src: { customers: { id: string; createdAt: Date }[]; allVisits: VisitRow[] },
  now: Date,
): CustomerHealth {
  const byCustomer = new Map<string, { visits: number; last: Date | null; first: Date | null }>();
  for (const v of src.allVisits) {
    const r = byCustomer.get(v.customerId) ?? { visits: 0, last: null, first: null };
    r.visits += 1;
    if (!r.last || v.at > r.last) r.last = v.at;
    if (!r.first || v.at < r.first) r.first = v.at;
    byCustomer.set(v.customerId, r);
  }

  const segments: Record<CustomerTier, number> = { NEW: 0, ACTIVE: 0, FADING: 0, LOST: 0 };
  const fading = new Set<string>();
  for (const c of src.customers) {
    const r = byCustomer.get(c.id);
    const tier = tierOf(r?.last ?? null, c.createdAt, now, r?.visits ?? 0);
    segments[tier] += 1;
    if (tier === 'FADING') fading.add(c.id);
  }

  const retention = retentionFromVisits(
    src.allVisits.map((v) => ({ customerId: v.customerId, at: v.at })),
    now,
    WINDOW_DAYS,
  );

  /* Гроші під ризиком: що FADING-клієнти витрачали за 30 днів до свого
     останнього візиту — це «місяць», який ми можемо втратити. */
  const dayMs = 86_400_000;
  const atRiskValueKop = src.allVisits
    .filter((v) => {
      const last = byCustomer.get(v.customerId)?.last;
      return fading.has(v.customerId) && last !== null && last !== undefined
        && v.at.getTime() > last.getTime() - WINDOW_DAYS * dayMs;
    })
    .reduce((sum, v) => sum + v.price, 0);

  return {
    totalCustomers: src.customers.length,
    segments,
    thresholds: { activeDays: TIER_ACTIVE_DAYS, fadingDays: TIER_FADING_DAYS, newVisits: TIER_NEW_VISITS },
    last30d: {
      active: retention.active, new: retention.new, returning: retention.returning,
      reactivated: retention.reactivated, retentionPct: retention.retentionRate,
    },
    atRisk: segments.FADING,
    atRiskValueUah: Math.round(atRiskValueKop / 100),
  };
}
