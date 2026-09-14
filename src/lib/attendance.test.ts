import { describe, it, expect } from 'vitest';
import { attendanceError, ARRIVE_EARLY_MS } from './attendance';

const start = new Date('2026-09-13T18:00:00Z');
const booking = (over: Record<string, unknown> = {}) => ({
  status: 'CONFIRMED', capacity: null, startTime: start, ...over,
});
const at = (ms: number) => new Date(start.getTime() + ms);

describe('attendanceError', () => {
  it('пускає «прийшов» за годину до старту, але не раніше', () => {
    expect(attendanceError(booking(), 'ARRIVED', at(-ARRIVE_EARLY_MS))).toBeNull();
    expect(attendanceError(booking(), 'ARRIVED', at(-ARRIVE_EARLY_MS - 1))).toBe('TOO_EARLY');
  });

  it('«не прийшов» — тільки після старту', () => {
    expect(attendanceError(booking(), 'NO_SHOW', at(-1))).toBe('TOO_EARLY');
    expect(attendanceError(booking(), 'NO_SHOW', at(0))).toBeNull();
  });

  it('скасовану, прострочену й групову бронь не відмічаємо', () => {
    expect(attendanceError(booking({ status: 'CANCELLED' }), 'ARRIVED', at(0))).toBe('BOOKING_CLOSED');
    expect(attendanceError(booking({ status: 'EXPIRED' }), 'UNKNOWN', at(0))).toBe('BOOKING_CLOSED');
    expect(attendanceError(booking({ capacity: 8 }), 'ARRIVED', at(0))).toBe('GROUP_ATTENDANCE_NOT_SUPPORTED');
  });

  it('скинути відмітку можна будь-коли, навіть до старту і без оплати', () => {
    expect(attendanceError(booking({ status: 'PENDING' }), 'UNKNOWN', at(-10 * ARRIVE_EARLY_MS))).toBeNull();
  });
});
