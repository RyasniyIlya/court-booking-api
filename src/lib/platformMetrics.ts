import { Prisma } from '@prisma/client';

import { prisma } from './db';
import { clubHealth, type ClubHealth } from './clubHealth';
import { isCustomQuote } from './courtPricing';
import { periodAmount, PERIOD_MONTHS, type Period } from './subscription';

/**
 * Метрики клубів для панелі оператора.
 *
 * Головне обмеження — ФІКСОВАНА кількість запитів, скільки б не було клубів:
 * сторінка «Клуби» і «Огляд» відкриваються щоразу, а цикл «по запиту на клуб»
 * на 300 клубах — це 3000 запитів до бази заради одного екрана. Тому все
 * рахується groupBy по clubId і розкладається в Map у памʼяті.
 *
 * Оператор бачить лише агрегати. Імен і телефонів гравців тут немає й бути
 * не має: клуб — володар даних своїх клієнтів, а платформа — його підрядник.
 */

const DAY_MS = 86_400_000;

/** Броні, що не рахуються: скасовані й прострочені не займали корт */
const DEAD_STATUSES = ['CANCELLED', 'EXPIRED'] as const;

export type ClubFeatures = {
  onlinePayments: boolean;
  passes: boolean;
  trainers: boolean;
  promos: boolean;
  groups: boolean;
};

export type ClubMetrics = {
  bookings30: number;
  bookingsPrev30: number;
  /** Копійки, за датою гри (accrual) */
  revenue30: number;
  /** 0..1, null — броней не було */
  onlineShare30: number | null;
  /** 0..1, null — немає годин роботи або активних кортів */
  occupancy30: number | null;
  customersTotal: number;
  newCustomers30: number;
  lastBookingAt: Date | null;
  lastStaffActivityAt: Date | null;
  upcoming7: number;
  tgLinked: boolean;
  features: ClubFeatures;
};

export type ClubMetricsBundle = {
  activeCourts: number;
  courts: number;
  metrics: ClubMetrics;
};

/** Скільки годин на тиждень клуб відкритий. Нічна зміна (close < open) — через північ. */
export function weeklyOpenHours(
  rows: { openMinute: number; closeMinute: number; isClosed?: boolean }[],
): number {
  let minutes = 0;
  for (const r of rows) {
    if (r.isClosed) continue;
    const span = r.closeMinute > r.openMinute ? r.closeMinute - r.openMinute : r.closeMinute + 1440 - r.openMinute;
    minutes += Math.min(span, 1440);
  }
  return minutes / 60;
}

type Grouped = { clubId: string };

function byClub<T extends Grouped>(rows: T[]): Map<string, T> {
  return new Map(rows.map((r) => [r.clubId, r]));
}

/**
 * Метрики всіх клубів (або переданих) за фіксовану кількість запитів.
 * `now` параметром — щоб тест не залежав від годинника.
 */
export async function loadClubMetrics(
  clubIds?: string[],
  now: Date = new Date(),
): Promise<Map<string, ClubMetricsBundle>> {
  if (clubIds && clubIds.length === 0) return new Map();

  const scope = clubIds ? { clubId: { in: clubIds } } : {};
  const from30 = new Date(now.getTime() - 30 * DAY_MS);
  const from60 = new Date(now.getTime() - 60 * DAY_MS);
  const to7 = new Date(now.getTime() + 7 * DAY_MS);
  const live = { notIn: [...DEAD_STATUSES] };
  const last30 = { ...scope, startTime: { gte: from30, lt: now }, status: live };

  const idFilter = clubIds ? Prisma.sql`AND "clubId" = ANY(${clubIds}::uuid[])` : Prisma.empty;

  const [
    clubs,
    courtRows,
    hourRows,
    cur,
    prev,
    online,
    groups,
    upcoming,
    lastBooking,
    hoursRows,
    customers,
    newCustomers,
    staffActivity,
    trainers,
    promos,
    ownerTg,
  ] = await Promise.all([
    prisma.club.findMany({
      where: clubIds ? { id: { in: clubIds } } : undefined,
      select: { id: true, prepayEnabled: true, passesEnabled: true, telegramChatId: true },
    }),
    prisma.court.groupBy({ by: ['clubId', 'isActive'], where: scope, _count: { _all: true } }),
    prisma.clubHours.findMany({
      where: { ...scope, isClosed: false },
      select: { clubId: true, openMinute: true, closeMinute: true },
    }),
    prisma.booking.groupBy({
      by: ['clubId'],
      where: last30,
      _count: { _all: true },
      _sum: { priceTotal: true },
    }),
    prisma.booking.groupBy({
      by: ['clubId'],
      where: { ...scope, startTime: { gte: from60, lt: from30 }, status: live },
      _count: { _all: true },
    }),
    prisma.booking.groupBy({
      by: ['clubId'],
      where: { ...last30, source: { not: 'ADMIN' } },
      _count: { _all: true },
    }),
    prisma.booking.groupBy({
      by: ['clubId'],
      where: { ...last30, capacity: { not: null } },
      _count: { _all: true },
    }),
    prisma.booking.groupBy({
      by: ['clubId'],
      where: { ...scope, startTime: { gte: now, lt: to7 }, status: live },
      _count: { _all: true },
    }),
    prisma.booking.groupBy({ by: ['clubId'], where: scope, _max: { createdAt: true } }),
    /* Години — сума тривалостей, а groupBy сумувати різницю двох колонок не
       вміє. Один агрегатний запит замість вибірки всіх броней за місяць. */
    prisma.$queryRaw<{ clubId: string; hours: number }[]>`
      SELECT "clubId"::text AS "clubId",
             COALESCE(SUM(EXTRACT(EPOCH FROM ("endTime" - "startTime")) / 3600), 0)::float8 AS hours
        FROM "Booking"
       WHERE "startTime" >= ${from30}
         AND "startTime" < ${now}
         AND "status" NOT IN ('CANCELLED', 'EXPIRED')
         ${idFilter}
       GROUP BY "clubId"
    `,
    prisma.customer.groupBy({ by: ['clubId'], where: scope, _count: { _all: true } }),
    prisma.customer.groupBy({
      by: ['clubId'],
      where: { ...scope, createdAt: { gte: from30 } },
      _count: { _all: true },
    }),
    prisma.changeLog.groupBy({ by: ['clubId'], where: scope, _max: { at: true } }),
    prisma.trainer.groupBy({
      by: ['clubId'],
      where: { ...scope, isActive: true },
      _count: { _all: true },
    }),
    prisma.promo.groupBy({
      by: ['clubId'],
      where: { ...scope, isActive: true },
      _count: { _all: true },
    }),
    prisma.user.groupBy({
      by: ['clubId'],
      where: { ...scope, role: 'OWNER', tgChatId: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const curBy = byClub(cur);
  const prevBy = byClub(prev);
  const onlineBy = byClub(online);
  const groupsBy = byClub(groups);
  const upcomingBy = byClub(upcoming);
  const lastBy = byClub(lastBooking);
  const bookedHoursBy = byClub(hoursRows);
  const customersBy = byClub(customers);
  const newCustomersBy = byClub(newCustomers);
  const staffBy = byClub(staffActivity);
  const trainersBy = byClub(trainers);
  const promosBy = byClub(promos);
  const ownerTgBy = byClub(ownerTg);

  const activeCourts = new Map<string, number>();
  const allCourts = new Map<string, number>();
  for (const r of courtRows) {
    allCourts.set(r.clubId, (allCourts.get(r.clubId) ?? 0) + r._count._all);
    if (r.isActive) activeCourts.set(r.clubId, r._count._all);
  }

  const weekly = new Map<string, { openMinute: number; closeMinute: number }[]>();
  for (const h of hourRows) {
    const list = weekly.get(h.clubId) ?? [];
    list.push(h);
    weekly.set(h.clubId, list);
  }

  const result = new Map<string, ClubMetricsBundle>();

  for (const club of clubs) {
    const id = club.id;
    const bookings30 = curBy.get(id)?._count._all ?? 0;
    const onlineCount = onlineBy.get(id)?._count._all ?? 0;
    const active = activeCourts.get(id) ?? 0;

    const openHours = weeklyOpenHours(weekly.get(id) ?? []);
    const capacityHours = active * openHours * (30 / 7);
    const occupancy30 =
      capacityHours > 0
        ? Math.max(0, Math.min(1, (bookedHoursBy.get(id)?.hours ?? 0) / capacityHours))
        : null;

    result.set(id, {
      activeCourts: active,
      courts: allCourts.get(id) ?? 0,
      metrics: {
        bookings30,
        bookingsPrev30: prevBy.get(id)?._count._all ?? 0,
        revenue30: curBy.get(id)?._sum.priceTotal ?? 0,
        onlineShare30: bookings30 > 0 ? onlineCount / bookings30 : null,
        occupancy30,
        customersTotal: customersBy.get(id)?._count._all ?? 0,
        newCustomers30: newCustomersBy.get(id)?._count._all ?? 0,
        lastBookingAt: lastBy.get(id)?._max.createdAt ?? null,
        lastStaffActivityAt: staffBy.get(id)?._max.at ?? null,
        upcoming7: upcomingBy.get(id)?._count._all ?? 0,
        tgLinked: Boolean(club.telegramChatId) || (ownerTgBy.get(id)?._count._all ?? 0) > 0,
        features: {
          onlinePayments: club.prepayEnabled,
          passes: club.passesEnabled,
          trainers: (trainersBy.get(id)?._count._all ?? 0) > 0,
          promos: (promosBy.get(id)?._count._all ?? 0) > 0,
          groups: (groupsBy.get(id)?._count._all ?? 0) > 0,
        },
      },
    });
  }

  return result;
}

/** Порожні метрики — для клубу, якого немає в Map (щойно створений між запитами) */
export const EMPTY_BUNDLE: ClubMetricsBundle = {
  activeCourts: 0,
  courts: 0,
  metrics: {
    bookings30: 0,
    bookingsPrev30: 0,
    revenue30: 0,
    onlineShare30: null,
    occupancy30: null,
    customersTotal: 0,
    newCustomers30: 0,
    lastBookingAt: null,
    lastStaffActivityAt: null,
    upcoming7: 0,
    tgLinked: false,
    features: { onlinePayments: false, passes: false, trainers: false, promos: false, groups: false },
  },
};

type HealthClub = {
  isActive: boolean;
  createdAt: Date;
  paidUntil: Date | null;
  trialEndsAt: Date | null;
};

/** Здоровʼя клубу з його рядка й метрик — щоб список і картка не розходились */
export function healthOf(club: HealthClub, metrics: ClubMetrics, now: Date = new Date()): ClubHealth {
  return clubHealth(
    {
      isActive: club.isActive,
      createdAt: club.createdAt,
      paidUntil: club.paidUntil,
      trialEndsAt: club.trialEndsAt,
      bookings30: metrics.bookings30,
      bookingsPrev30: metrics.bookingsPrev30,
      onlineShare30: metrics.onlineShare30,
      lastBookingAt: metrics.lastBookingAt,
      lastStaffActivityAt: metrics.lastStaffActivityAt,
      tgLinked: metrics.tgLinked,
      features: metrics.features,
    },
    now,
  );
}

type PricedClub = {
  planPrice: number | null;
  billingPeriod: string;
  plan: { price: number; period: string } | null;
};

export type ClubListPrice = {
  /** За який період виставляється рахунок: період плану, а без плану — клубу */
  period: Period;
  /** Скільки клуб платить за цей період, копійки, з урахуванням активних кортів */
  listPrice: number;
  /** Те саме, приведене до місяця — для MRR */
  listPriceMonthly: number;
  priceSource: 'override' | 'plan' | 'default';
  /** Кортів більше, ніж бере формула, і ціни ще не домовлено: ставить оператор */
  customQuote: boolean;
};

/**
 * Ціна клубу так, як її порахує видача підписки (та сама periodAmount, ті самі
 * активні корти) — інакше список показував би одну суму, а кнопка «Зарахувати»
 * пропонувала іншу.
 */
export function clubListPrice(club: PricedClub, activeCourts: number): ClubListPrice {
  const period = (club.plan?.period ?? club.billingPeriod) as Period;
  const listPrice = periodAmount(club.plan, club.planPrice, period, activeCourts);
  const priceSource = club.planPrice !== null ? 'override' : club.plan ? 'plan' : 'default';

  return {
    period,
    listPrice,
    listPriceMonthly: Math.round(listPrice / (PERIOD_MONTHS[period] ?? 1)),
    priceSource,
    /* Домовлена ціна вже і є індивідуальною пропозицією — прапорець «треба
       прорахувати» на ній був би шумом. */
    customQuote: priceSource !== 'override' && isCustomQuote(activeCourts),
  };
}
