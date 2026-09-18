import { DateTime } from 'luxon';

/**
 * Графік змін співробітника кабінету.
 *
 * Це саме табель — хто й коли працює, — а не замок. Він нічого не
 * забороняє: модератор поза зміною відкриє кабінет і зробить усе, що й
 * завжди. Так вирішено свідомо. Замок на годинах ламається рівно там, де
 * він найдорожчий: підміна о шостій ранку, затримка через хворого
 * змінника, помилка власника в годинах — і людина за стійкою не може
 * прийняти оплату, поки власник не прокинеться й не перепише графік.
 *
 * Тому тут немає жодної перевірки «чи можна». Є тільки відповідь на
 * питання «хто сьогодні на зміні», і вона однакова для кабінету власника
 * й для самого співробітника.
 */

export type ShiftHoursRow = {
  weekday: number;
  openMinute: number;
  closeMinute: number;
  isClosed: boolean;
};

export type ShiftKind = 'WORKING' | 'UNAVAILABLE' | 'DAY_OFF' | 'VACATION';

export type ShiftExceptionRow = {
  date: Date;
  isClosed: boolean;
  kind: ShiftKind;
  intervals: unknown;
  note?: string | null;
};

export type ShiftInterval = { startMinute: number; endMinute: number };

/** Порожня зміна: цього дня людина не працює. */
export type ResolvedShift = {
  /** Чому саме так: тижневий шаблон чи виняток на цю дату. */
  source: 'weekly' | 'exception' | 'none';
  kind: ShiftKind | 'OFF';
  intervals: ShiftInterval[];
  note: string | null;
};

const EMPTY: ResolvedShift = { source: 'none', kind: 'OFF', intervals: [], note: null };

/** Інтервали з JSON. Сміття мовчки відкидаємо: рядок «з 25:00» — не зміна. */
export function validIntervals(value: unknown): ShiftInterval[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is ShiftInterval => Boolean(row)
    && Number.isInteger((row as ShiftInterval).startMinute)
    && Number.isInteger((row as ShiftInterval).endMinute)
    && (row as ShiftInterval).startMinute >= 0
    && (row as ShiftInterval).endMinute <= 1800
    && (row as ShiftInterval).endMinute > (row as ShiftInterval).startMinute);
}

const isoDate = (date: Date) => DateTime.fromJSDate(date, { zone: 'utc' }).toFormat('yyyy-MM-dd');

/**
 * Зміна на конкретну дату.
 *
 * Виняток б'є тижневий шаблон цілком, а не доповнює його: «цього вівторка
 * я з 14:00» має означати саме це, а не «з 9:00 за шаблоном І з 14:00».
 * UNAVAILABLE — єдиний виняток із цього правила: він вирізає години з
 * шаблону, бо «сьогодні я з 13 до 15 на складі» описує дірку в звичайній
 * зміні, а не зміну цілком.
 *
 * Порожній тижневий графік означає «ще не заповнено», і це НЕ те саме, що
 * «не працює»: клуб, який графіка не веде, має бачити порожній табель, а
 * не сімох людей у відпустці.
 */
export function shiftForDate(
  hours: ShiftHoursRow[],
  exceptions: ShiftExceptionRow[],
  date: string,
): ResolvedShift {
  const exception = exceptions.find((row) => isoDate(row.date) === date);
  const day = DateTime.fromISO(date, { zone: 'utc' });
  if (!day.isValid) return EMPTY;

  const weekday = day.weekday % 7;
  const row = hours.find((item) => item.weekday === weekday);
  const weekly: ShiftInterval[] = row && !row.isClosed
    ? [{ startMinute: row.openMinute, endMinute: row.closeMinute }]
    : [];

  if (!exception) {
    if (hours.length === 0) return EMPTY;
    return weekly.length > 0
      ? { source: 'weekly', kind: 'WORKING', intervals: weekly, note: null }
      : { source: 'weekly', kind: 'OFF', intervals: [], note: null };
  }

  const note = exception.note ?? null;
  if (exception.kind === 'DAY_OFF' || exception.kind === 'VACATION' || exception.isClosed) {
    return { source: 'exception', kind: exception.kind === 'VACATION' ? 'VACATION' : 'DAY_OFF', intervals: [], note };
  }

  if (exception.kind === 'UNAVAILABLE') {
    const holes = validIntervals(exception.intervals);
    const left = cutOut(weekly, holes);
    return { source: 'exception', kind: left.length > 0 ? 'WORKING' : 'OFF', intervals: left, note };
  }

  const intervals = validIntervals(exception.intervals);
  return { source: 'exception', kind: intervals.length > 0 ? 'WORKING' : 'OFF', intervals, note };
}

/** Що лишається від зміни, коли з неї вирізали дірки. */
function cutOut(base: ShiftInterval[], holes: ShiftInterval[]): ShiftInterval[] {
  let left = base;
  for (const hole of holes) {
    const next: ShiftInterval[] = [];
    for (const span of left) {
      if (hole.endMinute <= span.startMinute || hole.startMinute >= span.endMinute) {
        next.push(span);
        continue;
      }
      if (hole.startMinute > span.startMinute) {
        next.push({ startMinute: span.startMinute, endMinute: hole.startMinute });
      }
      if (hole.endMinute < span.endMinute) {
        next.push({ startMinute: hole.endMinute, endMinute: span.endMinute });
      }
    }
    left = next;
  }
  return left;
}

/** Скільки хвилин виходить за день. Для підсумку «за тиждень N годин». */
export const shiftMinutes = (shift: ResolvedShift) =>
  shift.intervals.reduce((sum, i) => sum + (i.endMinute - i.startMinute), 0);

/**
 * Чи людина на зміні в цей момент. Використовується тільки для показу
 * «зараз на зміні» — нічого не блокує.
 */
export function onShiftAt(shift: ResolvedShift, minuteOfDay: number): boolean {
  return shift.intervals.some((i) => minuteOfDay >= i.startMinute && minuteOfDay < i.endMinute);
}
