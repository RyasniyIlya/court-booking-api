import { DateTime } from 'luxon';

import { buildLoadProfile, type BlockRow, type HoursRow } from './loadProfile';

/**
 * Мотогодини й завантаженість кортів для партнера-будівельника (Ц-1, Ц-2).
 *
 * ПРИВАТНІСТЬ: функції тут бачать лише courtId/start/end броні (і блокування).
 * Гравців, сум і платежів у вхідних типах немає взагалі. Вмикається тільки
 * згодою клубу (Club.shareStatsWithPartner) — це перевіряє роут.
 */

/** Єдиний білий список полів, які читаються з БД для цієї статистики. */
export const COURT_USAGE_BOOKING_SELECT = { courtId: true, startTime: true, endTime: true, status: true } as const;
export const COURT_USAGE_BLOCK_SELECT = { courtId: true, startTime: true, endTime: true } as const;
export const COURT_USAGE_COURT_SELECT = { id: true, name: true } as const;

export type UsageBooking = { courtId: string; startTime: Date; endTime: Date; status: string };

export type CourtUsage = {
  courtId: string;
  name: string;
  /** За весь час, завершені не скасовані, години з десятими */
  hoursPlayed: number;
  /** Те саме в межах періоду */
  hoursLastPeriod: number;
  /** Зайняті / відкриті години за період, 0..100 */
  occupancyPct: number;
  /** До 3 найзавантаженіших годин доби (0..23) */
  peakHours: number[];
};

export type CourtUsageInput = {
  courts: { id: string; name: string }[];
  bookings: UsageBooking[];
  blocks: BlockRow[];
  hours: HoursRow[];
  timezone: string;
  /** Початок періоду (UTC) */
  from: Date;
  now: Date;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export function periodFrom(now: Date, months: number, timezone: string, clubCreatedAt?: Date): Date {
  const f = DateTime.fromJSDate(now).setZone(timezone).minus({ months }).toJSDate();
  return clubCreatedAt && clubCreatedAt > f ? clubCreatedAt : f;
}

export function buildCourtUsage(input: CourtUsageInput): CourtUsage[] {
  const { courts, blocks, hours, timezone, from, now } = input;
  /* Тільки завершені: CONFIRMED, що вже закінчились. */
  const done = input.bookings.filter((b) => b.status === 'CONFIRMED' && b.endTime.getTime() <= now.getTime());
  const fromMs = from.getTime();

  return courts.map((court) => {
    const mine = done.filter((b) => b.courtId === court.id);
    const allMs = mine.reduce((s, b) => s + (b.endTime.getTime() - b.startTime.getTime()), 0);
    const periodMs = mine.reduce((s, b) => {
      const a = Math.max(b.startTime.getTime(), fromMs);
      return s + Math.max(0, b.endTime.getTime() - a);
    }, 0);

    const profile = buildLoadProfile({
      from, to: now, timezone, hours,
      courts: [{ id: court.id }],
      blocks,
      bookings: mine.map((b) => ({ courtId: b.courtId, startTime: b.startTime, endTime: b.endTime, priceTotal: 0 })),
    });
    const t = profile.totals;
    const peakHours = profile.byHour
      .filter((h) => h.bookedMinutes > 0)
      .sort((a, b) => b.bookedMinutes - a.bookedMinutes || a.hour - b.hour)
      .slice(0, 3)
      .map((h) => h.hour);

    return {
      courtId: court.id,
      name: court.name,
      hoursPlayed: round1(allMs / 3_600_000),
      hoursLastPeriod: round1(periodMs / 3_600_000),
      occupancyPct: t.openMinutes > 0 ? Math.min(100, Math.round((t.bookedMinutes / t.openMinutes) * 100)) : 0,
      peakHours,
    };
  });
}
