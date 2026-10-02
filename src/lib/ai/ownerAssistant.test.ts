import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../botAnalytics', () => ({ courtAnalytics: vi.fn() }));
vi.mock('../db', () => ({ prisma: { club: { findUnique: vi.fn() } } }));
vi.mock('../clubLoad', () => ({ loadClubLoadProfile: vi.fn() }));
vi.mock('./customerHealth', () => ({ loadCustomerHealth: vi.fn() }));
vi.mock('../digest', () => ({ dayDigest: vi.fn(), weekReport: vi.fn() }));
vi.mock('../financeData', () => ({ loadLiabilityPasses: vi.fn() }));
vi.mock('../sections', () => ({ revenueBreakdown: vi.fn(), staffReport: vi.fn() }));
vi.mock('./outlook', () => ({ bookingOutlook: vi.fn(), }));

import { courtAnalytics } from '../botAnalytics';
import { prisma } from '../db';
import { loadClubLoadProfile } from '../clubLoad';
import { loadCustomerHealth } from './customerHealth';
import { dayDigest, weekReport } from '../digest';
import { loadLiabilityPasses } from '../financeData';
import { revenueBreakdown, staffReport } from '../sections';
import { ownerTools, resetCustomerHealthCache, resetLoadHeatmapCache, type OwnerClub } from './ownerAssistant';

const club: OwnerClub = { id: 'c1', name: 'Клуб', timezone: 'Europe/Kyiv', address: null };
const tool = (name: string) => ownerTools(club).find((t) => t.decl.name === name)!;

beforeEach(() => {
  vi.clearAllMocks();
  resetLoadHeatmapCache();
  resetCustomerHealthCache();
});

describe('ownerTools — набір і межі', () => {
  it('точний список імен — PII-запобіжник: новий інструмент має пройти той самий огляд', () => {
    expect(ownerTools(club).map((t) => t.decl.name).sort()).toEqual([
      'get_booking_outlook', 'get_court_report', 'get_customer_health', 'get_day_summary',
      'get_load_heatmap', 'get_passes_status', 'get_revenue_mix', 'get_revenue_trend', 'web_lookup',
    ]);
  });
});

describe('get_customer_health', () => {
  const health = {
    totalCustomers: 40,
    segments: { NEW: 5, ACTIVE: 20, FADING: 10, LOST: 5 },
    thresholds: { activeDays: 30, fadingDays: 90, newVisits: 5 },
    last30d: { active: 25, new: 5, returning: 15, reactivated: 2, retentionPct: 60 },
    atRisk: 10,
    atRiskValueUah: 12000,
  };

  it('мапить у snake_case і додає підказку, як побачити людей', async () => {
    vi.mocked(loadCustomerHealth).mockResolvedValue(health);
    const out: any = await tool('get_customer_health').run({});
    expect(out).toMatchObject({
      total_customers: 40,
      segments: { NEW: 5, ACTIVE: 20, FADING: 10, LOST: 5 },
      last_30d: { active: 25, new: 5, returning: 15, reactivated: 2, retention_pct: 60 },
      at_risk: 10,
      at_risk_value_uah: 12000,
    });
    expect(out.how_to_see_names).toMatch(/Клієнти/);
    expect(JSON.stringify(out)).not.toMatch(/phone|телефон|email|\+380/i);
  });

  it('кеш: другий виклик у межах TTL не б\'є повторно в loadCustomerHealth', async () => {
    vi.mocked(loadCustomerHealth).mockResolvedValue(health);
    await tool('get_customer_health').run({});
    await tool('get_customer_health').run({});
    expect(loadCustomerHealth).toHaveBeenCalledTimes(1);
  });
});

describe('get_day_summary / get_revenue_trend — копійки в гривні', () => {
  it('day_summary округлює копійки до гривень', async () => {
    vi.mocked(dayDigest).mockResolvedValue({
      from: new Date(), to: new Date(), bookings: 3, revenue: 12345, newCustomers: 1,
      topCourt: { name: 'Корт 1', bookings: 2 }, prevRevenue: 9999,
    });
    const out: any = await tool('get_day_summary').run({});
    expect(out.revenue_uah).toBe(123); // 12345 коп round -> 123
    expect(out.prev_day_revenue_uah).toBe(100); // 9999 коп round -> 100
  });

  it('revenue_trend округлює суми періоду', async () => {
    vi.mocked(weekReport).mockResolvedValue({ points: [{ day: '2026-09-01', label: '01.09', revenue: 5050, bookings: 2 }], total: 10050, bookings: 5, prevTotal: 8000 });
    const out: any = await tool('get_revenue_trend').run({ days: 7 });
    expect(out.total_uah).toBe(101);
    expect(out.by_day[0].revenue_uah).toBe(51);
  });
});

describe('get_court_report', () => {
  it('структуровані дані замість Telegram-розмітки', async () => {
    vi.mocked(courtAnalytics).mockResolvedValue({
      clubName: 'Клуб', timezone: 'Europe/Kyiv', label: '01.09.2026 — 02.09.2026', generated: 'now',
      rows: [{ name: 'Корт 1', confirmed: 3, pending: 1, cancelled: 0, expired: 0, amount: 15000, paid: 2, paymentPending: 1, refunded: 0, bookedHours: 4.5, freeHours: 3.5, occupancy: 56.25 }],
    });
    const out: any = await tool('get_court_report').run({ range: 'today' });
    expect(out.period_label).toBe('01.09.2026 — 02.09.2026');
    expect(out.courts[0]).toEqual({
      court: 'Корт 1', confirmed: 3, pending: 1, cancelled: 0, expired: 0,
      revenue_uah: 150, occupancy_pct: 56.3, booked_hours: 4.5, free_hours: 3.5,
      paid_online: 2, payment_pending: 1, refunded: 0,
    });
    expect(JSON.stringify(out)).not.toMatch(/<[a-z]/i); // жодного HTML/Telegram-тега
    expect(JSON.stringify(out)).not.toContain('/analytics');
  });

  it('невалідний range — ToolInputError, без запиту до бази', async () => {
    await expect(tool('get_court_report').run({ range: 'all' })).rejects.toThrow();
    expect(courtAnalytics).not.toHaveBeenCalled();
  });

  it('дані недоступні -> available:false замість кидання помилки', async () => {
    vi.mocked(courtAnalytics).mockResolvedValue(null);
    const out: any = await tool('get_court_report').run({ range: 'today' });
    expect(out).toEqual({ available: false, note: 'Дані за цей період недоступні.' });
  });
});

describe('get_revenue_mix', () => {
  it('гривні, частки й топ-10 тренерів', async () => {
    vi.mocked(revenueBreakdown).mockResolvedValue({
      total: 100000, bookings: 10,
      byCourt: [{ name: 'Корт 1', revenue: 60000 }, { name: 'Корт 2', revenue: 40000 }],
      trainerPart: 25000,
      group: { bookings: 2, revenue: 15000 },
    });
    vi.mocked(staffReport).mockResolvedValue({
      rows: Array.from({ length: 12 }, (_, i) => ({ name: `Тренер ${i}`, sessions: 1, revenue: (12 - i) * 100 })),
      sessions: 12, revenue: 1000,
    });

    const out: any = await tool('get_revenue_mix').run({ days: 30 });

    expect(out.total_uah).toBe(1000);
    expect(out.by_court).toEqual([
      { court: 'Корт 1', revenue_uah: 600, share_pct: 60 },
      { court: 'Корт 2', revenue_uah: 400, share_pct: 40 },
    ]);
    expect(out.trainer_part_uah).toBe(250);
    expect(out.trainer_share_pct).toBe(25);
    expect(out.group).toEqual({ sessions: 2, revenue_uah: 150 });
    expect(out.trainers).toHaveLength(10); // обрізано до топ-10
  });

  it('нема броней -> частки 0, а не NaN/Infinity', async () => {
    vi.mocked(revenueBreakdown).mockResolvedValue({ total: 0, bookings: 0, byCourt: [], trainerPart: 0, group: { bookings: 0, revenue: 0 } });
    vi.mocked(staffReport).mockResolvedValue({ rows: [], sessions: 0, revenue: 0 });
    const out: any = await tool('get_revenue_mix').run({});
    expect(out.trainer_share_pct).toBe(0);
    expect(out.days).toBe(30);
  });

  it('невалідний days — ToolInputError', async () => {
    await expect(tool('get_revenue_mix').run({ days: 0 })).rejects.toThrow();
  });
});

describe('get_passes_status', () => {
  it('абонементи вимкнені в клубі -> лише enabled:false, без запиту до liability', async () => {
    vi.mocked(prisma.club.findUnique).mockResolvedValue({ passesEnabled: false, passPlans: [] } as any);
    const out: any = await tool('get_passes_status').run({});
    expect(out).toEqual({ enabled: false });
    expect(loadLiabilityPasses).not.toHaveBeenCalled();
  });

  it('гривні, лічильники й тарифи без жодного клієнта поіменно', async () => {
    vi.mocked(prisma.club.findUnique).mockResolvedValue({
      passesEnabled: true,
      passPlans: [{ name: '8 занять', type: 'PACKAGE', totalSessions: 8, days: 30, price: 240000 }],
    } as any);
    vi.mocked(loadLiabilityPasses).mockResolvedValue({
      total: 150000, count: 5, sessionsLeft: 20,
      expiringSoon: [
        { passId: 'p1', customerId: 'c1', name: 'Іван', phone: '+380671234567', left: 2, daysLeft: 3, value: 50000 },
        { passId: 'p2', customerId: 'c2', name: 'Оля', phone: '+380671234568', left: 1, daysLeft: 10, value: 30000 },
      ],
      burned30: { value: 40000, count: 2 },
    });

    const out: any = await tool('get_passes_status').run({});

    expect(out).toEqual({
      enabled: true, active_count: 5, unearned_uah: 1500, sessions_left: 20,
      expiring_14d: { count: 2, value_uah: 800 },
      burned_30d: { count: 2, value_uah: 400 },
      plans: [{ name: '8 занять', type: 'PACKAGE', sessions: 8, days: 30, price_uah: 2400 }],
    });
    expect(JSON.stringify(out)).not.toMatch(/Іван|Оля|\+380/);
  });
});

describe('get_load_heatmap', () => {
  const cell = (weekday: number, hour: number, occ: number, open = 60) => ({ weekday, hour, openMinutes: open, bookedMinutes: open * occ, bookings: 1, revenue: 1000, occupancy: occ });

  it('замало даних -> available:false з причиною', async () => {
    vi.mocked(loadClubLoadProfile).mockResolvedValue({ available: false, reason: 'NOT_ENOUGH_DATA', window: { weeks: 8, from: new Date(), to: new Date() }, bookings: 3, needBookings: 20 });
    const out: any = await tool('get_load_heatmap').run({});
    expect(out).toEqual({ available: false, reason: 'NOT_ENOUGH_DATA', bookings: 3, need_bookings: 20 });
  });

  it('досить даних -> тихі й гучні клітинки, закриті години не потрапляють у top', async () => {
    vi.mocked(loadClubLoadProfile).mockResolvedValue({
      available: true,
      window: { weeks: 8, from: new Date('2026-01-01'), to: new Date('2026-01-08') },
      profile: {
        byWeekday: [{ weekday: 1, occupancy: 0.5, bookings: 10, revenue: 100000, openMinutes: 100, bookedMinutes: 50 }],
        byHour: [],
        cells: [
          cell(1, 8, 0.1), // найтихіша відкрита
          cell(1, 20, 0.95), // найгучніша
          { weekday: 2, hour: 3, openMinutes: 0, bookedMinutes: 0, bookings: 0, revenue: 0, occupancy: 0 }, // зачинено — не має потрапити нікуди
        ],
        totals: { openMinutes: 1000, bookedMinutes: 400, bookings: 20, revenue: 200000, occupancy: 0.4 },
      },
    } as any);

    const out: any = await tool('get_load_heatmap').run({ weeks: 8 });
    expect(out.available).toBe(true);
    expect(out.occupancy_pct).toBe(40);
    expect(out.quietest[0]).toMatchObject({ weekday: 'пн', hour: '08:00', occupancy_pct: 10 });
    expect(out.busiest[0]).toMatchObject({ weekday: 'пн', hour: '20:00', occupancy_pct: 95 });
    expect(out.quietest.some((c: any) => c.hour === '03:00')).toBe(false);
    expect(out.busiest.some((c: any) => c.hour === '03:00')).toBe(false);
  });

  it('кеш: другий виклик у межах TTL не б\'є повторно в loadClubLoadProfile', async () => {
    vi.mocked(loadClubLoadProfile).mockResolvedValue({ available: false, reason: 'NOT_ENOUGH_DATA', window: { weeks: 8, from: new Date(), to: new Date() }, bookings: 0, needBookings: 20 });
    await tool('get_load_heatmap').run({});
    await tool('get_load_heatmap').run({});
    expect(loadClubLoadProfile).toHaveBeenCalledTimes(1);
  });

  it('невалідний weeks — ToolInputError', async () => {
    await expect(tool('get_load_heatmap').run({ weeks: 1 })).rejects.toThrow();
  });
});
