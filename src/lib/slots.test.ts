import { describe, it, expect } from 'vitest';
import { buildSlots, isAlignedToGrid, type Interval } from './slots';

/**
 * Сітка вільних годин. Порожні слоти в базі не лежать — вона рахується на
 * льоту, і будь-яка помилка тут або продає зайняту годину, або ховає вільну.
 *
 * Час скрізь фіксований (`now` — параметр саме заради цього): тест, що
 * залежить від годинника, падає вночі й проходить удень.
 */
const TZ = 'Europe/Kyiv';
/** 2026-08-25, 06:00 за Києвом (03:00 UTC) — сітка ще вся попереду */
const NOW = new Date('2026-08-25T03:00:00.000Z');

const base = {
  date: '2026-08-25',
  timezone: TZ,
  openMinute: 8 * 60,
  closeMinute: 22 * 60,
  slotMinutes: 60,
  leadTimeMinutes: 0,
  busy: [] as Interval[],
  now: NOW,
};

/** Київ улітку — UTC+3, тому 08:00 місцевого це 05:00 UTC */
const kyiv = (hhmm: string) => new Date(`2026-08-25T${hhmm}:00.000Z`);

describe('buildSlots', () => {
  it('будує слоти від відкриття до закриття', () => {
    const slots = buildSlots(base);
    expect(slots).toHaveLength(14); // 08:00..21:00
    expect(slots[0].label).toBe('08:00');
    expect(slots.at(-1)!.label).toBe('21:00');
  });

  it('мітка — час КЛУБУ, а не UTC', () => {
    const slots = buildSlots(base);
    expect(slots[0].label).toBe('08:00');
    expect(slots[0].start).toBe('2026-08-25T05:00:00.000Z');
  });

  it('зайнята година позначається BOOKED і не пропадає з сітки', () => {
    const slots = buildSlots({
      ...base,
      busy: [{ startTime: kyiv('07:00'), endTime: kyiv('08:00') }], // 10:00 місцевого
    });
    const ten = slots.find((s) => s.label === '10:00')!;
    expect(ten.available).toBe(false);
    expect(ten.reason).toBe('BOOKED');
    // Гравець має бачити, що вечір розібрано, а не порожню сітку
    expect(slots).toHaveLength(14);
  });

  it('бронь, що накриває кілька годин, гасить їх усі', () => {
    const slots = buildSlots({
      ...base,
      busy: [{ startTime: kyiv('07:00'), endTime: kyiv('10:00') }], // 10:00–13:00
    });
    const busyLabels = slots.filter((s) => !s.available).map((s) => s.label);
    expect(busyLabels).toEqual(['10:00', '11:00', '12:00']);
  });

  it('дотик встик не рахується перетином', () => {
    // Бронь 10:00–11:00 не має гасити слот 11:00 — інакше клуб втрачає годину
    const slots = buildSlots({
      ...base,
      busy: [{ startTime: kyiv('07:00'), endTime: kyiv('08:00') }],
    });
    expect(slots.find((s) => s.label === '11:00')!.available).toBe(true);
  });

  it('минулі години закриті з причиною PAST', () => {
    const slots = buildSlots({ ...base, now: kyiv('12:00') }); // 15:00 місцевого
    const past = slots.find((s) => s.label === '10:00')!;
    expect(past.available).toBe(false);
    expect(past.reason).toBe('PAST');
  });

  it('leadTime відрізає найближчі години окремою причиною', () => {
    const slots = buildSlots({
      ...base,
      now: kyiv('09:30'),        // 12:30 місцевого
      leadTimeMinutes: 60,
    });
    const soon = slots.find((s) => s.label === '13:00')!;
    expect(soon.available).toBe(false);
    // Саме LEAD_TIME, а не BOOKED: година вільна, просто пізно бронювати
    expect(soon.reason).toBe('LEAD_TIME');
    expect(slots.find((s) => s.label === '14:00')!.available).toBe(true);
  });

  it('крок 30 хвилин дає вдвічі більше слотів', () => {
    const slots = buildSlots({ ...base, slotMinutes: 30 });
    expect(slots).toHaveLength(28);
    expect(slots[1].label).toBe('08:30');
  });

  it('неповний слот у кінці не створюється', () => {
    // 08:00–09:30 із кроком 60 — друга година не влазить
    const slots = buildSlots({ ...base, closeMinute: 9 * 60 + 30 });
    expect(slots.map((s) => s.label)).toEqual(['08:00']);
  });

  it('клуб, що працює за північ, будує слоти далі 24:00', () => {
    const slots = buildSlots({ ...base, openMinute: 22 * 60, closeMinute: 26 * 60 });
    expect(slots.map((s) => s.label)).toEqual(['22:00', '23:00', '00:00', '01:00']);
  });

  it('закриття не пізніше відкриття — порожня сітка, а не виняток', () => {
    expect(buildSlots({ ...base, closeMinute: base.openMinute })).toEqual([]);
  });

  it('нульовий крок — це помилка налаштувань, і про неї треба знати', () => {
    expect(() => buildSlots({ ...base, slotMinutes: 0 })).toThrow();
  });
});

describe('isAlignedToGrid', () => {
  const grid = { timezone: TZ, openMinute: 8 * 60, closeMinute: 22 * 60, slotMinutes: 60 };

  it('рівна година в сітці проходить', () => {
    expect(isAlignedToGrid({ ...grid, start: kyiv('05:00'), end: kyiv('06:00') })).toBe(true);
  });

  it('кілька годин поспіль проходять', () => {
    expect(isAlignedToGrid({ ...grid, start: kyiv('05:00'), end: kyiv('08:00') })).toBe(true);
  });

  it('зсув на пів години не проходить', () => {
    expect(isAlignedToGrid({ ...grid, start: kyiv('05:30'), end: kyiv('06:30') })).toBe(false);
  });

  it('тривалість не кратна кроку не проходить', () => {
    expect(isAlignedToGrid({ ...grid, start: kyiv('05:00'), end: kyiv('06:30') })).toBe(false);
  });

  it('до відкриття не проходить', () => {
    expect(isAlignedToGrid({ ...grid, start: kyiv('04:00'), end: kyiv('05:00') })).toBe(false);
  });

  it('за закриття не проходить', () => {
    // 21:00–22:00 місцевого — останній валідний; 22:00–23:00 уже ні
    expect(isAlignedToGrid({ ...grid, start: kyiv('19:00'), end: kyiv('20:00') })).toBe(false);
  });

  it('нульова тривалість не проходить', () => {
    expect(isAlignedToGrid({ ...grid, start: kyiv('05:00'), end: kyiv('05:00') })).toBe(false);
  });
});
