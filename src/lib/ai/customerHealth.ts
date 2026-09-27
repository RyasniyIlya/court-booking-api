import { prisma } from '../db';
import { TIER_ACTIVE_DAYS, TIER_FADING_DAYS, TIER_NEW_VISITS, tierOf, type CustomerTier } from '../customerRoster';
import { retentionFromVisits, type Visit } from '../deepAnalytics';

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
 * ── Синтетична точка «перший візит за все життя» ─────────────────────────
 *
 * `retentionFromVisits` бачить лише те, що йому передали. Дай їй тільки
 * останні 60 днів — і клієнт, який ходив рік тому й повернувся цього
 * місяця, стане «новачком», а не «поверненцем»: усередині вікна це його
 * єдиний відомий візит. Тому до реальних візитів за 60 днів додаємо по
 * одній синтетичній точці на клієнта — дату його найпершого відомого
 * візиту за всю історію. Для вже активних цього тижня це нічого не міняє
 * (точка або дублює вже наявну, або старіша за обидва вікна), а для
 * поверненців рятує правильну класифікацію.
 */

const WINDOW_DAYS = 30;

type VisitRow = { customerId: string; at: Date; price: number };

export type CustomerHealth = {
  totalCustomers: number;
  segments: Record<CustomerTier, number>;
  thresholds: { activeDays: number; fadingDays: number; newVisits: number };
  last30d: {
    active: number; new: number; returning: number; reactivated: number;
    atRisk: number; retentionPct: number | null;
  };
  /** Скільки грошей на місяць під ризиком: витрати клієнтів із at-risk у попередньому 30-денному вікні. */
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
  for (const c of src.customers) {
    const r = byCustomer.get(c.id);
    segments[tierOf(r?.last ?? null, c.createdAt, now, r?.visits ?? 0)] += 1;
  }

  const dayMs = 86_400_000;
  const currentFrom = new Date(now.getTime() - WINDOW_DAYS * dayMs);
  const previousFrom = new Date(now.getTime() - WINDOW_DAYS * 2 * dayMs);

  const visits: Visit[] = src.allVisits
    .filter((v) => v.at >= previousFrom)
    .map((v) => ({ customerId: v.customerId, at: v.at }));
  for (const [id, r] of byCustomer) if (r.first) visits.push({ customerId: id, at: r.first });

  const retention = retentionFromVisits(visits, now, WINDOW_DAYS);

  const atRiskSet = new Set(retention.atRiskIds);
  const atRiskValueKop = src.allVisits
    .filter((v) => atRiskSet.has(v.customerId) && v.at >= previousFrom && v.at < currentFrom)
    .reduce((sum, v) => sum + v.price, 0);

  return {
    totalCustomers: src.customers.length,
    segments,
    thresholds: { activeDays: TIER_ACTIVE_DAYS, fadingDays: TIER_FADING_DAYS, newVisits: TIER_NEW_VISITS },
    last30d: {
      active: retention.active, new: retention.new, returning: retention.returning,
      reactivated: retention.reactivated, atRisk: retention.atRiskIds.length, retentionPct: retention.retentionRate,
    },
    atRiskValueUah: Math.round(atRiskValueKop / 100),
  };
}
