import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';

vi.mock('../db', () => ({
  prisma: { booking: { count: vi.fn(), findMany: vi.fn() }, court: { count: vi.fn() } },
}));
vi.mock('../digest', () => ({ dayDigest: vi.fn(), weekReport: vi.fn() }));
vi.mock('./outlook', () => ({ bookingOutlook: vi.fn() }));

import { prisma } from '../db';
import { dayDigest, weekReport } from '../digest';
import { bookingOutlook } from './outlook';
import {
  describeSnapshot, loadOwnerSnapshot, ownerSuggestions, resetSnapshotCache, snapshotHeadline,
  type ClubSnapshot,
} from './ownerContext';
import { ownerTools } from './ownerAssistant';

const club = { id: 'c1', name: 'Клуб', timezone: 'Europe/Kyiv', address: null, planName: 'Аналітика' };
// 2026-09-26 — субота
const NOW = DateTime.fromISO('2026-09-26T12:00:00', { zone: 'Europe/Kyiv' });

const snap = (over: Partial<ClubSnapshot> = {}): ClubSnapshot => ({
  date: '2026-09-26', courts: 4, planName: 'Аналітика',
  today: { bookings: 6, revenueUah: 3600, newCustomers: 1, topCourt: 'Корт 1' },
  yesterdayRevenueUah: 3000,
  week: { revenueUah: 22400, prevRevenueUah: 20000, changePct: 12, bookings: 40 },
  pending: 0, weakestDay: null, strongestDay: null, ...over,
});

const day = (date: string, booked: number, usual: number) => ({ date, weekday: 'x', booked, revenue_booked_uah: 0, usual_for_weekday: usual });

function arrange(opts: { outlook?: any[]; total?: number; prevTotal?: number } = {}) {
  vi.mocked(dayDigest).mockResolvedValue({
    from: new Date(), to: new Date(), bookings: 6, revenue: 360000, newCustomers: 2,
    topCourt: { name: 'Корт 1', bookings: 3 }, prevRevenue: 300000,
  });
  vi.mocked(weekReport).mockResolvedValue({ points: [], total: opts.total ?? 2240000, bookings: 40, prevTotal: opts.prevTotal ?? 2000000 });
  vi.mocked(bookingOutlook).mockResolvedValue(opts.outlook ?? []);
  vi.mocked(prisma.booking.count).mockResolvedValue(3);
  vi.mocked(prisma.court.count).mockResolvedValue(4);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSnapshotCache();
});

describe('describeSnapshot / snapshotHeadline', () => {
  it('null -> порожньо', () => {
    expect(describeSnapshot(null)).toBe('');
    expect(snapshotHeadline(null)).toBeNull();
  });

  it('блок із тегами, гривнями, відсотком і слабким днем; застереження стоїть перед блоком', () => {
    const t = describeSnapshot(snap({ weakestDay: { date: '2026-10-01', weekday: 'чт', booked: 4, usual: 9 }, pending: 2 }));
    expect(t.indexOf('не інструкції')).toBeGreaterThan(-1);
    expect(t.indexOf('не інструкції')).toBeLessThan(t.indexOf('<club_snapshot>'));
    expect(t).toContain('</club_snapshot>');
    expect(t).toMatch(/3\s?600 грн/);
    expect(t).toContain('+12%');
    expect(t).toContain('чт 2026-10-01 — 4 броней при нормі 9');
    expect(t).toContain('PENDING): 2');
  });

  it('заголовок: сьогодні, тиждень, слабкий день', () => {
    const h = snapshotHeadline(snap({ weakestDay: { date: '2026-10-01', weekday: 'чт', booked: 4, usual: 9 } }))!;
    expect(h).toMatch(/^Сьогодні 6 броней, 3\s?600 грн · тиждень \+12% до минулого · слабкий день: чт \(4 при нормі 9\)$/);
  });

  it('без порівняння тижня — без частини про тиждень', () => {
    const h = snapshotHeadline(snap({ week: { revenueUah: 0, prevRevenueUah: 0, changePct: null, bookings: 0 } }))!;
    expect(h).not.toContain('тиждень');
  });
});

describe('ownerSuggestions', () => {
  const ok = (a: string[]) => {
    expect(a).toHaveLength(3);
    expect(new Set(a).size).toBe(3);
  };

  it('null і «нічого особливого» — типові три', () => {
    ok(ownerSuggestions(null));
    expect(ownerSuggestions(snap())).toEqual(ownerSuggestions(null));
  });

  it('слабкий день, pending, падіння — свої питання першими, все ще рівно 3', () => {
    const a = ownerSuggestions(snap({
      weakestDay: { date: '2026-10-01', weekday: 'чт', booked: 4, usual: 9 },
      pending: 2,
      week: { revenueUah: 10, prevRevenueUah: 20, changePct: -50, bookings: 1 },
    }));
    ok(a);
    expect(a).toEqual([
      'Чому у чт порожньо і що зробити?',
      'Що з бронями, які чекають підтвердження?',
      'Чому виручка корту впала за тиждень?',
    ]);
  });

  it('одна ситуація — решта добирається типовими', () => {
    const a = ownerSuggestions(snap({ pending: 1 }));
    ok(a);
    expect(a[0]).toBe('Що з бронями, які чекають підтвердження?');
  });
});

describe('loadOwnerSnapshot', () => {
  it('збирає поля з джерел, гривні з копійок, дата в tz клубу', async () => {
    arrange({ outlook: [] });
    const s = await loadOwnerSnapshot(club, NOW);
    expect(s).toMatchObject({
      date: '2026-09-26', courts: 4, planName: 'Аналітика', pending: 3,
      today: { bookings: 6, revenueUah: 3600, newCustomers: 2, topCourt: 'Корт 1' },
      yesterdayRevenueUah: 3000,
      week: { revenueUah: 22400, prevRevenueUah: 20000, changePct: 12, bookings: 40 },
      weakestDay: null, strongestDay: null,
    });
    expect(prisma.booking.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ clubId: 'c1', status: 'PENDING' }),
    }));
    expect(prisma.court.count).toHaveBeenCalledWith({ where: { clubId: 'c1', isActive: true } });
  });

  it('кеш: другий виклик не б\'є в БД/digest; після reset — б\'є', async () => {
    arrange();
    await loadOwnerSnapshot(club, NOW);
    await loadOwnerSnapshot(club, NOW);
    expect(dayDigest).toHaveBeenCalledTimes(1);
    expect(prisma.booking.count).toHaveBeenCalledTimes(1);
    resetSnapshotCache();
    await loadOwnerSnapshot(club, NOW);
    expect(dayDigest).toHaveBeenCalledTimes(2);
    expect(prisma.court.count).toHaveBeenCalledTimes(2);
  });

  it('weakest/strongest: відсікає usual<1 і пороги 0.75 / 1.25', async () => {
    arrange({
      outlook: [
        day('2026-09-26', 0, 0.5),   // нема норми — ігноруємо, хоч і 0 броней
        day('2026-09-27', 9, 10),    // 0.9 — у нормі
        day('2026-09-28', 5, 10),    // 0.5 — слабкий
        day('2026-09-29', 8, 10),    // 0.8
        day('2026-09-30', 20, 10),   // 2.0 — сильний
        day('2026-10-01', 13, 10),   // 1.3
      ],
    });
    const s = await loadOwnerSnapshot(club, NOW);
    expect(s.weakestDay).toEqual({ date: '2026-09-28', weekday: 'пн', booked: 5, usual: 10 });
    expect(s.strongestDay).toEqual({ date: '2026-09-30', weekday: 'ср', booked: 20, usual: 10 });
  });

  it('усі дні в межах порогів — обидва null', async () => {
    arrange({ outlook: [day('2026-09-27', 8, 10), day('2026-09-28', 12, 10)] });
    const s = await loadOwnerSnapshot(club, NOW);
    expect(s.weakestDay).toBeNull();
    expect(s.strongestDay).toBeNull();
  });

  it('prev=0 -> changePct null', async () => {
    arrange({ prevTotal: 0 });
    expect((await loadOwnerSnapshot(club, NOW)).week.changePct).toBeNull();
  });

  it('у знімку нема жодних персональних даних клієнтів', async () => {
    arrange();
    const json = JSON.stringify(await loadOwnerSnapshot(club, NOW));
    expect(json).not.toMatch(/phone|телефон|email|customerName/i);
  });
});

describe('web_lookup', () => {
  it('помилка пошуку -> available:false, а не виняток', async () => {
    const generate = vi.fn(async () => { throw new Error('429'); });
    const tool = ownerTools(club, generate as any).find((t) => t.decl.name === 'web_lookup')!;
    const out: any = await tool.run({ topic: 'погода на 5 днів' });
    expect(out.available).toBe(false);
    expect(out.note).toContain('недоступний');
    expect(generate).toHaveBeenCalled();
  });
});
