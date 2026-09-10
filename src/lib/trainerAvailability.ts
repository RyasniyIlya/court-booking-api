import { DateTime } from 'luxon';

export type TrainerHoursRow = {
  weekday: number;
  openMinute: number;
  closeMinute: number;
  isClosed: boolean;
};
export type TrainerExceptionRow = {
  date: Date;
  isClosed: boolean;
  kind?: 'WORKING' | 'UNAVAILABLE' | 'DAY_OFF' | 'VACATION';
  intervals: unknown;
};
export type TrainerInterval = { startMinute: number; endMinute: number };

export function validIntervals(value: unknown): TrainerInterval[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is TrainerInterval => Boolean(row)
    && Number.isInteger((row as TrainerInterval).startMinute)
    && Number.isInteger((row as TrainerInterval).endMinute)
    && (row as TrainerInterval).startMinute >= 0
    && (row as TrainerInterval).endMinute <= 1800
    && (row as TrainerInterval).endMinute > (row as TrainerInterval).startMinute);
}

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
  exceptions: TrainerExceptionRow[] = [],
): boolean {
  if (end <= start) return false;

  const localStart = DateTime.fromJSDate(start).setZone(timezone);
  const localEnd = DateTime.fromJSDate(end).setZone(timezone);
  if (!localStart.isValid || !localEnd.isValid) return false;

  const weekday = localStart.weekday % 7;
  const localDate = localStart.toFormat('yyyy-MM-dd');
  const exception = exceptions.find((item) =>
    DateTime.fromJSDate(item.date, { zone: 'utc' }).toFormat('yyyy-MM-dd') === localDate);
  if (exception?.isClosed) return false;
  const row = hours.find((item) => item.weekday === weekday);
  if (!exception && hours.length === 0) return true;
  if (!exception && (!row || row.isClosed)) return false;

  const startMinute = localStart.hour * 60 + localStart.minute + localStart.second / 60;
  let endMinute = localEnd.hour * 60 + localEnd.minute + localEnd.second / 60;
  const startDay = localStart.startOf('day');
  const endDay = localEnd.startOf('day');
  const dayOffset = Math.round(endDay.diff(startDay, 'days').days);
  if (dayOffset < 0 || dayOffset > 1) return false;
  endMinute += dayOffset * 1440;

  if (exception) {
    if (exception.kind === 'UNAVAILABLE') {
      const insideRegular = hours.length === 0
        || Boolean(row && !row.isClosed && startMinute >= row.openMinute && endMinute <= row.closeMinute);
      if (!insideRegular) return false;
      return !validIntervals(exception.intervals).some((interval) =>
        startMinute < interval.endMinute && endMinute > interval.startMinute);
    }
    return validIntervals(exception.intervals).some((interval) =>
      startMinute >= interval.startMinute && endMinute <= interval.endMinute);
  }
  return startMinute >= row!.openMinute && endMinute <= row!.closeMinute;
}
