import { describe, expect, it } from 'vitest';
import { breakEven, monthlyPnl, passLiability, trainerPayouts, unearned, type PassLike } from './financeReports';
import type { CashRow } from './cashbook';

const NOW = new Date('2026-09-23T12:00:00Z');
const DAY = 86_400_000;

const pass = (p: Partial<PassLike>): PassLike => ({
  id: Math.random().toString(36),
  type: 'PACKAGE',
  totalSessions: 8,
  usedSessions: 3,
  validFrom: new Date(NOW.getTime() - 10 * DAY),
  validUntil: new Date(NOW.getTime() + 20 * DAY),
  price: 240000,
  revokedAt: null,
  customer: { id: 'c1', name: 'Оля', phone: '+380671234567' },
  ...p,
});

describe('unearned', () => {
  it('пакет — пропорційно невикористаним заняттям', () => {
    expect(unearned(pass({}), NOW)).toEqual({ value: 150000, left: 5 });
  });

  it('безліміт — пропорційно часу, що лишився', () => {
    const p = pass({ type: 'UNLIMITED', totalSessions: null, validFrom: new Date(NOW.getTime() - 15 * DAY), validUntil: new Date(NOW.getTime() + 15 * DAY), price: 300000 });
    expect(unearned(p, NOW).value).toBe(150000);
  });

  it('безліміт, що ще не почався, — уся ціна', () => {
    const p = pass({ type: 'UNLIMITED', totalSessions: null, validFrom: new Date(NOW.getTime() + DAY), validUntil: new Date(NOW.getTime() + 31 * DAY), price: 300000 });
    expect(unearned(p, NOW).value).toBe(300000);
  });

  it('знятий, прострочений чи подарований — нічого не винні', () => {
    expect(unearned(pass({ revokedAt: NOW }), NOW).value).toBe(0);
    expect(unearned(pass({ validUntil: new Date(NOW.getTime() - DAY) }), NOW).value).toBe(0);
    expect(unearned(pass({ price: 0 }), NOW).value).toBe(0);
  });
});

describe('passLiability', () => {
  it('рахує борг, те, що скоро згорить, і вже згоріле', () => {
    const r = passLiability([
      pass({}),
      pass({ id: 'soon', validUntil: new Date(NOW.getTime() + 3 * DAY) }),
      pass({ id: 'used-up', usedSessions: 8, validUntil: new Date(NOW.getTime() + 3 * DAY) }),
      pass({ id: 'burned', validUntil: new Date(NOW.getTime() - 5 * DAY), usedSessions: 6 }),
      pass({ id: 'old', validUntil: new Date(NOW.getTime() - 60 * DAY), usedSessions: 0 }),
    ], NOW);

    expect(r.total).toBe(300000);
    expect(r.count).toBe(2);
    expect(r.sessionsLeft).toBe(10);
    expect(r.expiringSoon.map((s) => s.passId)).toEqual(['soon']);
    expect(r.expiringSoon[0].daysLeft).toBe(3);
    expect(r.burned30).toEqual({ value: 60000, count: 1 });
  });
});

describe('trainerPayouts', () => {
  const s = (p: Partial<Parameters<typeof trainerPayouts>[0][number]>) => ({
    trainerId: 't1', trainerName: 'Андрій', pricePerHour: 50000, trainerPrice: 50000,
    startTime: new Date('2026-09-01T10:00:00Z'), endTime: new Date('2026-09-01T11:00:00Z'),
    attendance: 'UNKNOWN', ...p,
  });

  it('сума за зафіксованою ціною, ставка — довідка, неявки й без ціни — окремо', () => {
    const r = trainerPayouts([
      s({}),
      s({ endTime: new Date('2026-09-01T11:30:00Z'), trainerPrice: 75000, attendance: 'NO_SHOW' }),
      s({ trainerPrice: 0 }),
      s({ trainerId: 't2', trainerName: 'Ірина', trainerPrice: 90000 }),
    ]);
    expect(r.total).toBe(215000);
    expect(r.rows[0]).toMatchObject({ trainerId: 't1', sessions: 3, hours: 3.5, amount: 125000, byRate: 175000, noShows: 1, unpriced: 1 });
  });
});

describe('monthlyPnl', () => {
  const row = (at: string, amount: number, extra: Partial<CashRow> = {}): CashRow => ({
    id: at, at: new Date(at), kind: 'PAYMENT', method: 'CASH', account: '', amount,
    source: 'BOOKING', customer: null, description: '', actor: null, ...extra,
  });

  it('каса мінус витрати, бонуси не рахуються, місяць без витрат позначено', () => {
    const r = monthlyPnl(
      [
        row('2026-08-10T10:00:00Z', 100000),
        row('2026-08-11T10:00:00Z', 20000, { kind: 'REFUND' }),
        row('2026-08-12T10:00:00Z', 50000, { method: 'BONUS' }),
        row('2026-09-01T10:00:00Z', 70000),
      ],
      [{ month: new Date('2026-08-01T00:00:00Z'), category: 'RENT', amount: 50000 }],
      ['2026-08', '2026-09'],
      'Europe/Kyiv',
    );
    expect(r[0]).toMatchObject({ month: '2026-08', income: 80000, expenses: 50000, profit: 30000, expensesMissing: false });
    expect(r[0].byCategory).toEqual({ RENT: 50000 });
    expect(r[1]).toMatchObject({ income: 70000, expenses: 0, expensesMissing: true });
  });

  it('оплата о пів на першу ночі за Києвом — вже наступний місяць', () => {
    const r = monthlyPnl([row('2026-08-31T21:30:00Z', 10000)], [], ['2026-08', '2026-09'], 'Europe/Kyiv');
    expect(r.map((m) => m.income)).toEqual([0, 10000]);
  });
});

describe('breakEven', () => {
  it('години до нуля за середньою ціною години', () => {
    const r = breakEven({ monthExpenses: 1_000_000, fallbackExpenses: [], soldHours90: 100, revenue90: 5_000_000, soldHoursMonth: 12.5 });
    expect(r).toMatchObject({ available: true, avgHour: 50000, hoursNeeded: 20, hoursSold: 12.5, hoursLeft: 8, estimated: false });
  });

  it('без витрат місяця бере середнє попередніх і каже про це', () => {
    const r = breakEven({ monthExpenses: 0, fallbackExpenses: [0, 900_000, 1_100_000], soldHours90: 10, revenue90: 500_000, soldHoursMonth: 0 });
    expect(r).toMatchObject({ available: true, estimated: true, expenses: 1_000_000, hoursNeeded: 20 });
  });

  it('без витрат взагалі чи без продажів — не рахується', () => {
    expect(breakEven({ monthExpenses: 0, fallbackExpenses: [], soldHours90: 10, revenue90: 1, soldHoursMonth: 0 }).available).toBe(false);
    expect(breakEven({ monthExpenses: 5, fallbackExpenses: [], soldHours90: 0, revenue90: 0, soldHoursMonth: 0 }).available).toBe(false);
  });
});
