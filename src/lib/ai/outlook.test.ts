import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';

vi.mock('../db', () => ({ prisma: { booking: { findMany: vi.fn() } } }));

import { prisma } from '../db';
import { bookingOutlook, type OwnerClub } from './outlook';

const club: OwnerClub = { id: 'c1', name: 'Клуб', timezone: 'Europe/Kyiv', address: null };
// 2026-09-23 — середа
const NOW = DateTime.fromISO('2026-09-23T12:00:00', { zone: 'Europe/Kyiv' });

const row = (date: DateTime, priceUah = 100) => ({
  startTime: date.toJSDate(), priceTotal: priceUah * 100, status: 'CONFIRMED',
});

beforeEach(() => vi.clearAllMocks());

describe('bookingOutlook — норма по дню тижня', () => {
  it('рахує рівно 8 останніх понеділків до сьогодні (раніше восьмий випадав до historyFrom і губився)', async () => {
    // Останній понеділок перед середою 2026-09-23 — 2026-09-21, далі щотижня назад.
    const lastMonday = NOW.startOf('day').minus({ days: 2 });
    const mondays = Array.from({ length: 8 }, (_, n) => lastMonday.minus({ weeks: n }));
    vi.mocked(prisma.booking.findMany).mockResolvedValue(mondays.map((d) => row(d)) as any);

    const out = await bookingOutlook(club, 6, NOW);

    // historyFrom має покривати восьмий понеділок назад.
    const call = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(DateTime.fromJSDate(call.where.startTime.gte).toMillis())
      .toBeLessThanOrEqual(mondays[7].toMillis());

    const monday = out.find((o) => o.date === '2026-09-28')!;
    expect(monday.weekday).toBe('пн');
    expect(monday.usual_for_weekday).toBe(1); // 8 бронь / 8 тижнів, не 7/8 = 0.9
  });

  it('явна українська позначка дня тижня, а не локаль сервера', async () => {
    vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
    const out = await bookingOutlook(club, 1, NOW);
    expect(out[0]).toMatchObject({ date: '2026-09-23', weekday: 'ср' });
  });

  it('сьогоднішній день тижня в норму не рахується (лише минулі настання)', async () => {
    const today = NOW.startOf('day');
    // Бронь сьогодні не має впливати на "норму середи" — тільки минулі середи.
    vi.mocked(prisma.booking.findMany).mockResolvedValue([row(today)] as any);
    const out = await bookingOutlook(club, 1, NOW);
    expect(out[0].usual_for_weekday).toBe(0);
    expect(out[0].booked).toBe(1);
  });
});
