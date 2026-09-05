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
});
