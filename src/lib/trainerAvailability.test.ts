import { describe, expect, it } from 'vitest';
import { isTrainerAvailable } from './trainerAvailability';

const hours = [
  { weekday: 1, openMinute: 9 * 60, closeMinute: 18 * 60, isClosed: false },
  { weekday: 2, openMinute: 0, closeMinute: 0, isClosed: true },
];

describe('isTrainerAvailable', () => {
  it('keeps legacy trainers without configured hours available', () => {
    expect(isTrainerAvailable([], new Date('2026-09-07T07:00:00Z'), new Date('2026-09-07T08:00:00Z'), 'Europe/Kyiv')).toBe(true);
  });

  it('accepts a lesson fully inside the local interval', () => {
    expect(isTrainerAvailable(hours, new Date('2026-09-07T07:00:00Z'), new Date('2026-09-07T08:00:00Z'), 'Europe/Kyiv')).toBe(true);
  });

  it('rejects a lesson extending past the trainer shift', () => {
    expect(isTrainerAvailable(hours, new Date('2026-09-07T14:30:00Z'), new Date('2026-09-07T15:30:00Z'), 'Europe/Kyiv')).toBe(false);
  });

  it('rejects a closed weekday', () => {
    expect(isTrainerAvailable(hours, new Date('2026-09-08T09:00:00Z'), new Date('2026-09-08T10:00:00Z'), 'Europe/Kyiv')).toBe(false);
  });

  it('a date exception closes a normally working day', () => {
    expect(isTrainerAvailable(hours, new Date('2026-09-07T07:00:00Z'), new Date('2026-09-07T08:00:00Z'), 'Europe/Kyiv', [
      { date: new Date('2026-09-07'), isClosed: true, intervals: [] },
    ])).toBe(false);
  });

  it('a date exception can open selected hours on a regular day off', () => {
    expect(isTrainerAvailable(hours, new Date('2026-09-08T10:00:00Z'), new Date('2026-09-08T11:00:00Z'), 'Europe/Kyiv', [
      { date: new Date('2026-09-08'), isClosed: false, intervals: [{ startMinute: 12 * 60, endMinute: 15 * 60 }] },
    ])).toBe(true);
  });

  it('supports split shifts and rejects a lesson crossing the break', () => {
    const exception = [{ date: new Date('2026-09-07'), isClosed: false, intervals: [
      { startMinute: 9 * 60, endMinute: 12 * 60 }, { startMinute: 15 * 60, endMinute: 18 * 60 },
    ] }];
    expect(isTrainerAvailable(hours, new Date('2026-09-07T07:00:00Z'), new Date('2026-09-07T08:00:00Z'), 'Europe/Kyiv', exception)).toBe(true);
    expect(isTrainerAvailable(hours, new Date('2026-09-07T09:30:00Z'), new Date('2026-09-07T13:30:00Z'), 'Europe/Kyiv', exception)).toBe(false);
  });

  it('removes only the unavailable interval from the regular day', () => {
    const exception = [{ date: new Date('2026-09-07'), isClosed: false, kind: 'UNAVAILABLE' as const,
      intervals: [{ startMinute: 12 * 60, endMinute: 15 * 60 }] }];
    expect(isTrainerAvailable(hours, new Date('2026-09-07T07:00:00Z'), new Date('2026-09-07T08:00:00Z'), 'Europe/Kyiv', exception)).toBe(true);
    expect(isTrainerAvailable(hours, new Date('2026-09-07T10:30:00Z'), new Date('2026-09-07T11:30:00Z'), 'Europe/Kyiv', exception)).toBe(false);
    expect(isTrainerAvailable(hours, new Date('2026-09-07T13:00:00Z'), new Date('2026-09-07T14:00:00Z'), 'Europe/Kyiv', exception)).toBe(true);
  });
});
