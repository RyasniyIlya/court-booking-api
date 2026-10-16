import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../botAnalytics', () => ({ courtAnalytics: vi.fn() }));
vi.mock('../db', () => ({ prisma: { club: { findUnique: vi.fn() } } }));
vi.mock('../clubLoad', () => ({ loadClubLoadProfile: vi.fn() }));
vi.mock('./customerHealth', () => ({ loadCustomerHealth: vi.fn() }));
vi.mock('../digest', () => ({ dayDigest: vi.fn(), weekReport: vi.fn() }));
vi.mock('../financeData', () => ({ loadLiabilityPasses: vi.fn() }));
vi.mock('../sections', () => ({ revenueBreakdown: vi.fn(), staffReport: vi.fn() }));
vi.mock('./outlook', () => ({ bookingOutlook: vi.fn() }));

import { loadClubLoadProfile } from '../clubLoad';
import { loadCustomerHealth } from './customerHealth';
import { dayDigest } from '../digest';
import { bookingOutlook } from './outlook';
import { revenueBreakdown, staffReport } from '../sections';
import { describeSnapshot, ownerSuggestions, snapshotHeadline, type ClubSnapshot } from './ownerContext';
import { ownerSystemPrompt, ownerTools, resetLoadHeatmapCache, type OwnerClub } from './ownerAssistant';
import { DEFAULT_POLICY, effectivePermissions, normalizePolicy } from './policy';

const club: OwnerClub = { id: 'c1', name: 'Клуб', timezone: 'Europe/Kyiv', address: null };
const perms = (over: Record<string, unknown>, role = 'OWNER') => effectivePermissions({ ...DEFAULT_POLICY, ...over }, role);

beforeEach(() => {
  vi.clearAllMocks();
  resetLoadHeatmapCache();
});

describe('ownerTools за правами', () => {
  it('без readFinance моделі не показуються фінансові інструменти', () => {
    const names = ownerTools(club, undefined, perms({ readFinance: false })).map((t) => t.decl.name);
    expect(names.sort()).toEqual(['get_booking_outlook', 'get_customer_health', 'get_load_heatmap', 'web_lookup']);
  });

  it('роль без доступу не отримує жодного інструмента', () => {
    expect(ownerTools(club, undefined, effectivePermissions(normalizePolicy(null), 'ADMIN'))).toEqual([]);
  });

  it('теплова карта без readFinance віддає завантаження, але не виручку по днях', async () => {
    vi.mocked(loadClubLoadProfile).mockResolvedValue({
      available: true,
      window: { from: new Date('2026-09-01'), to: new Date('2026-09-29') },
      profile: {
        totals: { occupancy: 0.5, bookings: 10, openMinutes: 600, bookedMinutes: 300 },
        byWeekday: [{ weekday: 1, occupancy: 0.5, bookings: 10, revenue: 500000 }],
        cells: [],
      },
    } as never);
    const heat = (p: ReturnType<typeof perms>) => ownerTools(club, undefined, p).find((t) => t.decl.name === 'get_load_heatmap')!;
    const closed: any = await heat(perms({ readFinance: false })).run({});
    expect(closed.by_weekday[0]).toEqual({ weekday: 'пн', occupancy_pct: 50, bookings: 10 });
    expect(JSON.stringify(closed)).not.toMatch(/revenue/);
    // кеш спільний: наступний виклик із повними правами виручку бачить
    const open: any = await heat(perms({})).run({});
    expect(open.by_weekday[0].court_revenue_uah).toBe(5000);
  });

  it('get_revenue_mix без readStaff не віддає тренерів поіменно', async () => {
    vi.mocked(revenueBreakdown).mockResolvedValue({
      total: 100000, bookings: 3, byCourt: [], trainerPart: 0, group: { bookings: 0, revenue: 0 },
    } as never);
    vi.mocked(staffReport).mockResolvedValue({ rows: [{ name: 'Іван', sessions: 3, revenue: 100000 }] } as never);
    const mix = (p: ReturnType<typeof perms>) => ownerTools(club, undefined, p).find((t) => t.decl.name === 'get_revenue_mix')!;
    const closed: any = await mix(perms({ readStaff: false })).run({});
    expect(JSON.stringify(closed)).not.toMatch(/Іван/);
    const open: any = await mix(perms({})).run({});
    expect(open.trainers[0].name).toBe('Іван');
  });
});

describe('системний промпт', () => {
  it('називає закриті області, щоб модель не вигадувала цифри', () => {
    const p = ownerSystemPrompt(club, '', perms({ readFinance: false, readStaff: false }));
    expect(p).toMatch(/Власник закрив для тебе/);
    expect(p).toMatch(/фінанси/);
    expect(p).toMatch(/персонал/);
    expect(p).not.toMatch(/клієнтів і їхній стан/);
  });

  it('повні права — без блоку про закрите; роль не названа власником', () => {
    expect(ownerSystemPrompt(club, '')).not.toMatch(/Власник закрив/);
    expect(ownerSystemPrompt(club, '')).toMatch(/власник клубу/);
    expect(ownerSystemPrompt(club, '', perms({}), 'ADMIN')).toMatch(/співробітник клубу \(роль ADMIN\), не власник/);
  });
});

describe('знімок без фінансів', () => {
  const snap: ClubSnapshot = {
    date: '2026-10-16', courts: 4, planName: 'Аналітика',
    today: { bookings: 7, revenueUah: 12345, newCustomers: 2, topCourt: 'Корт 1' },
    yesterdayRevenueUah: 9999,
    week: { revenueUah: 88888, prevRevenueUah: 77777, changePct: -12, bookings: 40 },
    pending: 3,
    weakestDay: { date: '2026-10-18', weekday: 'нд', booked: 2, usual: 9 },
    strongestDay: null,
  };

  it('жодної гривні в тексті знімка, броні лишаються', () => {
    const text = describeSnapshot(snap, false);
    expect(text).not.toMatch(/грн|виручк|12\s?345|88\s?888|Аналітика/i);
    expect(text).toMatch(/7 підтверджених броней/);
    expect(text).toMatch(/40 броней/);
    expect(text).toMatch(/нд 2026-10-18/);
  });

  it('із фінансами — як і раніше', () => {
    expect(describeSnapshot(snap)).toMatch(/виручка корту/);
  });

  it('заголовок і питання кабінету без фінансів', () => {
    expect(snapshotHeadline(snap, false)).not.toMatch(/грн|тиждень/);
    expect(ownerSuggestions(snap, false).join(' ')).not.toMatch(/виручка/);
    expect(ownerSuggestions(snap, true).join(' ')).toMatch(/виручка/);
  });
});

describe('вміст відповідей без прав', () => {
  const tool = (name: string, p: ReturnType<typeof perms>) => ownerTools(club, undefined, p).find((t) => t.decl.name === name)!;

  it('get_booking_outlook без readFinance не віддає суми броней', async () => {
    vi.mocked(bookingOutlook).mockResolvedValue([
      { date: '2026-10-17', weekday: 'сб', booked: 4, revenue_booked_uah: 2400, usual_for_weekday: 5 },
    ] as never);
    const closed: any = await tool('get_booking_outlook', perms({ readFinance: false })).run({});
    expect(closed[0]).toEqual({ date: '2026-10-17', weekday: 'сб', booked: 4, usual_for_weekday: 5 });
    expect(JSON.stringify(closed)).not.toMatch(/revenue|2400/);
    const open: any = await tool('get_booking_outlook', perms({})).run({});
    expect(open[0].revenue_booked_uah).toBe(2400);
  });

  it('get_customer_health без readFinance не віддає гроші під ризиком, але лишає кількість', async () => {
    vi.mocked(loadCustomerHealth).mockResolvedValue({
      totalCustomers: 40, segments: { NEW: 5, ACTIVE: 20, FADING: 10, LOST: 5 },
      thresholds: { activeDays: 30, fadingDays: 90, newVisits: 5 },
      last30d: { active: 25, new: 5, returning: 15, reactivated: 2, retentionPct: 60 },
      atRisk: 10, atRiskValueUah: 12000,
    } as never);
    const closed: any = await tool('get_customer_health', perms({ readFinance: false })).run({});
    expect(closed.at_risk).toBe(10);
    expect(JSON.stringify(closed)).not.toMatch(/at_risk_value|12000/);
    const open: any = await tool('get_customer_health', perms({})).run({});
    expect(open.at_risk_value_uah).toBe(12000);
  });

  it('get_day_summary без readCustomers не віддає нових клієнтів', async () => {
    vi.mocked(dayDigest).mockResolvedValue({ bookings: 3, revenue: 150000, newCustomers: 7, topCourt: null, prevRevenue: null } as never);
    const closed: any = await tool('get_day_summary', perms({ readCustomers: false })).run({});
    expect(closed.bookings).toBe(3);
    expect(JSON.stringify(closed)).not.toMatch(/new_customers/);
    const open: any = await tool('get_day_summary', perms({})).run({});
    expect(open.new_customers).toBe(7);
  });

  it('знімок без readCustomers не називає нових клієнтів (з фінансами й без)', () => {
    const snap = {
      date: '2026-10-16', courts: 4, planName: null,
      today: { bookings: 7, revenueUah: 100, newCustomers: 9, topCourt: null }, yesterdayRevenueUah: null,
      week: { revenueUah: 1, prevRevenueUah: 1, changePct: 0, bookings: 5 }, pending: 0, weakestDay: null, strongestDay: null,
    } as ClubSnapshot;
    for (const fin of [true, false]) {
      expect(describeSnapshot(snap, fin, false)).not.toMatch(/клієнтів|9/);
      expect(describeSnapshot(snap, fin, true)).toMatch(/нових клієнтів 9/);
    }
  });
});
