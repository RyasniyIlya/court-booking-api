import { describe, expect, it } from 'vitest';
import { onShiftAt, shiftForDate, shiftMinutes } from './staffShift';

/* 2026-09-15 — вівторок, 2026-09-19 — субота. */
const TUE = '2026-09-15';
const SAT = '2026-09-19';

const weekly = (weekday: number, openMinute: number, closeMinute: number) =>
  ({ weekday, openMinute, closeMinute, isClosed: false });

const utc = (date: string) => new Date(`${date}T00:00:00.000Z`);

const exception = (date: string, kind: 'WORKING' | 'UNAVAILABLE' | 'DAY_OFF' | 'VACATION', intervals: unknown, note: string | null = null) =>
  ({ date: utc(date), isClosed: false, kind, intervals, note });

describe('shiftForDate', () => {
  it('an empty roster is «not filled in», not «everyone is off»', () => {
    /* Клуб, який графіка не веде, має бачити порожній табель, а не
       сімох людей у відпустці. */
    expect(shiftForDate([], [], TUE)).toMatchObject({ source: 'none', kind: 'OFF' });
  });

  it('takes the weekly shift for that weekday', () => {
    const hours = [weekly(2, 540, 1080), weekly(6, 600, 900)];
    expect(shiftForDate(hours, [], TUE)).toMatchObject({
      source: 'weekly', kind: 'WORKING', intervals: [{ startMinute: 540, endMinute: 1080 }],
    });
    /* День, якого в шаблоні немає, — вихідний, і це вже відповідь. */
    expect(shiftForDate(hours, [], '2026-09-16')).toMatchObject({ source: 'weekly', kind: 'OFF' });
    expect(shiftForDate(hours, [], SAT).intervals).toEqual([{ startMinute: 600, endMinute: 900 }]);
  });

  it('lets an exception replace the weekly shift, not add to it', () => {
    /* «Цього вівторка я з 14:00» означає саме це, а не «з 9:00 за
       шаблоном І з 14:00». */
    const hours = [weekly(2, 540, 1080)];
    const shift = shiftForDate(hours, [exception(TUE, 'WORKING', [{ startMinute: 840, endMinute: 1200 }])], TUE);
    expect(shift).toMatchObject({ source: 'exception', kind: 'WORKING' });
    expect(shift.intervals).toEqual([{ startMinute: 840, endMinute: 1200 }]);
  });

  it('cuts a hole out of the usual shift for UNAVAILABLE', () => {
    const hours = [weekly(2, 540, 1080)];
    const shift = shiftForDate(hours, [exception(TUE, 'UNAVAILABLE', [{ startMinute: 780, endMinute: 900 }])], TUE);
    expect(shift.intervals).toEqual([
      { startMinute: 540, endMinute: 780 },
      { startMinute: 900, endMinute: 1080 },
    ]);
  });

  it('shows a day off and a vacation apart, and keeps the note', () => {
    const hours = [weekly(2, 540, 1080)];
    expect(shiftForDate(hours, [exception(TUE, 'DAY_OFF', [], 'Підміна з Олею')], TUE))
      .toMatchObject({ kind: 'DAY_OFF', intervals: [], note: 'Підміна з Олею' });
    expect(shiftForDate(hours, [exception(TUE, 'VACATION', [])], TUE))
      .toMatchObject({ kind: 'VACATION', intervals: [] });
  });

  it('ignores impossible intervals instead of trusting the json', () => {
    const bad = [{ startMinute: 900, endMinute: 600 }, { startMinute: -5, endMinute: 100 }, null];
    expect(shiftForDate([], [exception(TUE, 'WORKING', bad)], TUE)).toMatchObject({ kind: 'OFF', intervals: [] });
  });

  it('answers «on shift right now» and the day total', () => {
    const shift = shiftForDate([weekly(2, 540, 1080)], [], TUE);
    expect(shiftMinutes(shift)).toBe(540);
    expect(onShiftAt(shift, 600)).toBe(true);
    expect(onShiftAt(shift, 1080)).toBe(false);
    expect(onShiftAt(shift, 400)).toBe(false);
  });
});
