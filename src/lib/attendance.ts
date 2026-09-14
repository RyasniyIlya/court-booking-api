/**
 * Стадія 3 броні: клієнт прийшов / не прийшов.
 *
 * Правила винесені сюди, а не в роут, щоб межі перевірялись тестом без бази:
 *   • скасовану чи прострочену бронь не відмічаємо — корту вже немає;
 *   • групові заняття не відмічаємо цілком — там приходять люди, а не бронь;
 *   • «прийшов» — не раніше ніж за годину до старту (гравець розминається),
 *     «не прийшов» — тільки після старту: раніше це не факт, а здогадка;
 *   • скинути відмітку (UNKNOWN) можна будь-коли — помилився, виправив.
 */

export const ATTENDANCE = ['UNKNOWN', 'ARRIVED', 'NO_SHOW'] as const;
export type AttendanceValue = (typeof ATTENDANCE)[number];

/** За скільки до старту вже можна відмітити «прийшов». */
export const ARRIVE_EARLY_MS = 60 * 60_000;

type BookingForAttendance = {
  status: string;
  capacity: number | null;
  startTime: Date;
};

export function attendanceError(
  booking: BookingForAttendance,
  next: AttendanceValue,
  now: Date = new Date(),
): string | null {
  if (booking.capacity !== null) return 'GROUP_ATTENDANCE_NOT_SUPPORTED';
  if (booking.status === 'CANCELLED' || booking.status === 'EXPIRED') return 'BOOKING_CLOSED';
  if (next === 'UNKNOWN') return null;

  const start = booking.startTime.getTime();
  if (next === 'ARRIVED' && now.getTime() < start - ARRIVE_EARLY_MS) return 'TOO_EARLY';
  if (next === 'NO_SHOW' && now.getTime() < start) return 'TOO_EARLY';
  return null;
}
