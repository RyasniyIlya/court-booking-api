import { DateTime } from 'luxon';

import { prisma } from './db';
import { buildLoadProfile, type LoadProfile } from './loadProfile';

/**
 * Профіль завантаження клубу (день тижня × година) — одна функція для
 * GET /api/admin/analytics/load і для інструмента нейроаналітика
 * get_load_heatmap, щоб адмінка й чат ніколи не розійшлись у цифрах.
 *
 * Раніше запит жив прямо в роуті; виніс сюди без зміни логіки чи відповіді
 * роута (див. коментарі там-таки про вибір вікна й обрізання по createdAt).
 */
export const LOAD_MIN_BOOKINGS = 20;

export type ClubLoadWindow = { weeks: number; from: Date; to: Date };

export type ClubLoadResult =
  | { available: false; reason: 'NOT_ENOUGH_DATA'; window: ClubLoadWindow; bookings: number; needBookings: number }
  | { available: true; window: ClubLoadWindow; profile: LoadProfile };

export async function loadClubLoadProfile(
  clubId: string,
  weeks: number,
  now: DateTime = DateTime.now(),
): Promise<ClubLoadResult | null> {
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: {
      timezone: true,
      createdAt: true,
      hours: { select: { weekday: true, openMinute: true, closeMinute: true, isClosed: true } },
    },
  });
  if (!club) return null;

  const anchor = now.setZone(club.timezone).startOf('week');
  const to = anchor.toJSDate();
  const windowStart = anchor.minus({ weeks }).toJSDate();
  const from = club.createdAt > windowStart ? club.createdAt : windowStart;

  const [courts, blocks, bookings] = await Promise.all([
    prisma.court.findMany({ where: { clubId, isActive: true }, select: { id: true } }),
    prisma.block.findMany({
      where: { clubId, startTime: { lt: to }, endTime: { gt: from } },
      select: { courtId: true, startTime: true, endTime: true },
    }),
    prisma.booking.findMany({
      where: { clubId, status: 'CONFIRMED', startTime: { lt: to }, endTime: { gt: from } },
      select: { courtId: true, startTime: true, endTime: true, priceTotal: true },
    }),
  ]);

  const profile = buildLoadProfile({ from, to, timezone: club.timezone, hours: club.hours, courts, blocks, bookings });
  const window: ClubLoadWindow = { weeks, from, to };

  if (profile.totals.bookings < LOAD_MIN_BOOKINGS) {
    return { available: false, reason: 'NOT_ENOUGH_DATA', window, bookings: profile.totals.bookings, needBookings: LOAD_MIN_BOOKINGS };
  }
  return { available: true, window, profile };
}
