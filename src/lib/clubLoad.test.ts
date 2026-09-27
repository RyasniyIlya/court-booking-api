import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';

vi.mock('./db', () => ({
  prisma: {
    club: { findUnique: vi.fn() },
    court: { findMany: vi.fn() },
    block: { findMany: vi.fn() },
    booking: { findMany: vi.fn() },
  },
}));

import { prisma } from './db';
import { loadClubLoadProfile, LOAD_MIN_BOOKINGS } from './clubLoad';

const TZ = 'Europe/Kyiv';
const NOW = DateTime.fromISO('2026-09-23T12:00:00', { zone: TZ }); // середа

const openAllWeek = Array.from({ length: 7 }, (_, weekday) => ({ weekday, openMinute: 8 * 60, closeMinute: 22 * 60, isClosed: false }));

function arrange(opts: { createdAt?: Date; bookings?: number } = {}) {
  vi.mocked(prisma.club.findUnique).mockResolvedValue({
    timezone: TZ, createdAt: opts.createdAt ?? new Date('2020-01-01'), hours: openAllWeek,
  } as any);
  vi.mocked(prisma.court.findMany).mockResolvedValue([{ id: 'c1' }] as any);
  vi.mocked(prisma.block.findMany).mockResolvedValue([]);
  const n = opts.bookings ?? 0;
  // Тиждень до "to" (початок ПОТОЧНОГО тижня): бронь у поточному неповному тижні не входить у вікно.
  const lastWeek = NOW.startOf('week').minus({ weeks: 1 });
  vi.mocked(prisma.booking.findMany).mockResolvedValue(
    Array.from({ length: n }, (_, i) => ({
      courtId: 'c1',
      startTime: lastWeek.plus({ days: i % 7, hours: 10 }).toJSDate(),
      endTime: lastWeek.plus({ days: i % 7, hours: 11 }).toJSDate(),
      priceTotal: 10000,
    })) as any,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('loadClubLoadProfile', () => {
  it('клуб не знайдено -> null', async () => {
    vi.mocked(prisma.club.findUnique).mockResolvedValue(null);
    expect(await loadClubLoadProfile('missing', 8, NOW)).toBeNull();
  });

  it('менше за поріг спостережень -> available:false, без готового профілю', async () => {
    arrange({ bookings: LOAD_MIN_BOOKINGS - 1 });
    const out = await loadClubLoadProfile('c', 8, NOW);
    expect(out).toMatchObject({ available: false, reason: 'NOT_ENOUGH_DATA', bookings: LOAD_MIN_BOOKINGS - 1, needBookings: LOAD_MIN_BOOKINGS });
  });

  it('досить спостережень -> available:true з профілем day×hour', async () => {
    arrange({ bookings: LOAD_MIN_BOOKINGS });
    const out = await loadClubLoadProfile('c', 8, NOW);
    expect(out?.available).toBe(true);
    if (out?.available) {
      expect(out.profile.totals.bookings).toBe(LOAD_MIN_BOOKINGS);
      expect(out.window.weeks).toBe(8);
    }
  });

  it('вікно не заходить за дату створення клубу', async () => {
    const createdAt = NOW.minus({ weeks: 2 }).toJSDate();
    arrange({ createdAt, bookings: 0 });
    const out = await loadClubLoadProfile('c', 8, NOW);
    expect(out?.window.from.getTime()).toBe(createdAt.getTime());
  });
});
