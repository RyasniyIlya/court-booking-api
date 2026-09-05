import { DateTime } from 'luxon';

export type TrainerHoursRow = {
  weekday: number;
  openMinute: number;
  closeMinute: number;
  isClosed: boolean;
};

/**
 * Чи входить увесь інтервал заняття в регулярний робочий час тренера.
 *
 * Порожній розклад означає «ще не налаштовано» і лишає стару поведінку:
 * тренер доступний у години клубу. Це важливо для наявних тренерів після
 * міграції — вони не мають раптом зникнути з віджета.
 */
export function isTrainerAvailable(
  hours: TrainerHoursRow[],
  start: Date,
  end: Date,
  timezone: string,
): boolean {
  if (hours.length === 0) return true;
  if (end <= start) return false;

  const localStart = DateTime.fromJSDate(start).setZone(timezone);
  const localEnd = DateTime.fromJSDate(end).setZone(timezone);
  if (!localStart.isValid || !localEnd.isValid) return false;

  const weekday = localStart.weekday % 7;
  const row = hours.find((item) => item.weekday === weekday);
  if (!row || row.isClosed) return false;

  const startMinute = localStart.hour * 60 + localStart.minute + localStart.second / 60;
  let endMinute = localEnd.hour * 60 + localEnd.minute + localEnd.second / 60;
  const startDay = localStart.startOf('day');
  const endDay = localEnd.startOf('day');
  const dayOffset = Math.round(endDay.diff(startDay, 'days').days);
  if (dayOffset < 0 || dayOffset > 1) return false;
  endMinute += dayOffset * 1440;

  return startMinute >= row.openMinute && endMinute <= row.closeMinute;
}
