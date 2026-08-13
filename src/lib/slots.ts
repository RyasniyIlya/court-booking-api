import { DateTime } from 'luxon';

export type Interval = { startTime: Date; endTime: Date };

export type SlotInput = {
  /** YYYY-MM-DD — локальна дата клубу, а не UTC */
  date: string;
  timezone: string;
  /** хвилини від опівночі, локальний час клубу */
  openMinute: number;
  closeMinute: number;
  slotMinutes: number;
  /** мінімальний запас часу до старту, хв */
  leadTimeMinutes: number;
  /** зайнятий час: активні броні + блокування (UTC) */
  busy: Interval[];
  /** "зараз" — параметр, щоб логіка була тестованою */
  now?: Date;
};

export type Slot = {
  /** ISO UTC */
  start: string;
  end: string;
  /** HH:mm у таймзоні клубу — те, що бачить клієнт */
  label: string;
  available: boolean;
  reason?: 'BOOKED' | 'PAST' | 'LEAD_TIME';
};

const overlaps = (aStart: number, aEnd: number, b: Interval) =>
  aStart < b.endTime.getTime() && aEnd > b.startTime.getTime();

/**
 * Порожні слоти в базі не зберігаються — сітка будується на льоту.
 * closeMinute може бути > 1440 (клуб працює за північ, напр. 26*60 = 02:00).
 */
export function buildSlots(input: SlotInput): Slot[] {
  const {
    date, timezone, openMinute, closeMinute,
    slotMinutes, leadTimeMinutes, busy, now = new Date(),
  } = input;

  if (slotMinutes <= 0) throw new Error('slotMinutes must be > 0');
  if (closeMinute <= openMinute) return [];

  const dayStart = DateTime.fromISO(date, { zone: timezone }).startOf('day');
  if (!dayStart.isValid) throw new Error(`Invalid date/timezone: ${date} / ${timezone}`);

  const cutoff = now.getTime() + leadTimeMinutes * 60_000;
  const slots: Slot[] = [];

  for (let m = openMinute; m + slotMinutes <= closeMinute; m += slotMinutes) {
    // plus({minutes}) коректно переживає перехід на літній/зимовий час
    const start = dayStart.plus({ minutes: m });
    const end = dayStart.plus({ minutes: m + slotMinutes });
    const startMs = start.toMillis();
    const endMs = end.toMillis();

    let available = true;
    let reason: Slot['reason'];

    if (startMs < now.getTime()) {
      available = false; reason = 'PAST';
    } else if (startMs < cutoff) {
      available = false; reason = 'LEAD_TIME';
    } else if (busy.some((b) => overlaps(startMs, endMs, b))) {
      available = false; reason = 'BOOKED';
    }

    slots.push({
      start: start.toUTC().toISO()!,
      end: end.toUTC().toISO()!,
      label: start.toFormat('HH:mm'),
      available,
      ...(reason ? { reason } : {}),
    });
  }

  return slots;
}

/** Перевірка, що бронь лягає в робочі години й у сітку — щоб не приймати довільні інтервали з фронту */
export function isAlignedToGrid(params: {
  start: Date; end: Date; timezone: string;
  openMinute: number; closeMinute: number; slotMinutes: number;
}): boolean {
  const { start, end, timezone, openMinute, closeMinute, slotMinutes } = params;
  const s = DateTime.fromJSDate(start).setZone(timezone);
  const dayStart = s.startOf('day');
  const offset = Math.round(s.diff(dayStart, 'minutes').minutes);
  const duration = Math.round(
    DateTime.fromJSDate(end).diff(DateTime.fromJSDate(start), 'minutes').minutes,
  );

  if (duration <= 0 || duration % slotMinutes !== 0) return false;
  if ((offset - openMinute) % slotMinutes !== 0) return false;
  if (offset < openMinute || offset + duration > closeMinute) return false;
  return true;
}
