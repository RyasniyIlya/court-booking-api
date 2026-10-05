import { describe, expect, it } from 'vitest';

import { COURT_USAGE_BLOCK_SELECT, COURT_USAGE_BOOKING_SELECT, COURT_USAGE_COURT_SELECT, buildCourtUsage } from './courtUsage';

const hours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, openMinute: 8 * 60, closeMinute: 22 * 60, isClosed: false }));
const now = new Date('2026-10-03T12:00:00Z');
const from = new Date('2026-09-03T12:00:00Z');
const b = (courtId: string, s: string, e: string, status = 'CONFIRMED') => ({ courtId, startTime: new Date(s), endTime: new Date(e), status });

describe('buildCourtUsage', () => {
  const bookings = [
    b('c1', '2026-10-01T15:00:00Z', '2026-10-01T17:00:00Z'), // 18-20 локально, 2 год
    b('c1', '2026-09-20T15:00:00Z', '2026-09-20T16:00:00Z'), // 18-19, 1 год
    b('c1', '2025-01-10T10:00:00Z', '2025-01-10T12:00:00Z'), // до періоду, 2 год
    b('c1', '2026-10-02T10:00:00Z', '2026-10-02T12:00:00Z', 'CANCELLED'),
    b('c1', '2026-10-05T10:00:00Z', '2026-10-05T12:00:00Z'), // майбутня
    b('c2', '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z'),
  ];
  const res = buildCourtUsage({
    courts: [{ id: 'c1', name: 'Корт 1' }, { id: 'c2', name: 'Корт 2' }],
    bookings, blocks: [], hours, timezone: 'Europe/Kyiv', from, now,
  });

  it('рахує години за весь час і за період, без скасованих і майбутніх', () => {
    expect(res[0]).toMatchObject({ courtId: 'c1', hoursPlayed: 5, hoursLastPeriod: 3 });
    expect(res[1]).toMatchObject({ courtId: 'c2', hoursPlayed: 1, hoursLastPeriod: 1 });
  });

  it('завантаженість = зайняті / відкриті години за період', () => {
    expect(res[0].occupancyPct).toBeGreaterThanOrEqual(0);
    expect(res[0].occupancyPct).toBeLessThanOrEqual(1);
    const full = buildCourtUsage({
      courts: [{ id: 'c1', name: 'K' }],
      bookings: [b('c1', '2026-10-01T05:00:00Z', '2026-10-01T19:00:00Z')],
      blocks: [], hours, timezone: 'Europe/Kyiv',
      from: new Date('2026-10-01T00:00:00Z'), now: new Date('2026-10-01T20:00:00Z'),
    });
    expect(full[0].occupancyPct).toBeGreaterThan(90);
    expect(full[0].occupancyPct).toBeLessThanOrEqual(100);
  });

  it('пікові години: до трьох, за спаданням зайнятості', () => {
    expect(res[0].peakHours).toEqual([18, 19]);
  });

  it('жодних полів гравців/грошей у виході й у select', () => {
    expect(Object.keys(res[0]).sort()).toEqual(['courtId', 'hoursLastPeriod', 'hoursPlayed', 'name', 'occupancyPct', 'peakHours']);
    const all = [...Object.keys(COURT_USAGE_BOOKING_SELECT), ...Object.keys(COURT_USAGE_BLOCK_SELECT), ...Object.keys(COURT_USAGE_COURT_SELECT)];
    expect(all.sort()).toEqual(['courtId', 'courtId', 'endTime', 'endTime', 'id', 'name', 'startTime', 'startTime', 'status']);
  });
});
