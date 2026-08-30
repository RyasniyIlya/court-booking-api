import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  buildLoadProfile,
  clubDayCutoff,
  clubWeekday,
  type HoursRow,
  type LoadProfileInput,
} from './loadProfile';

/**
 * Завантаження по днях і годинах. Помилка тут не падає й не кидає 500 —
 * вона малює правдоподібний графік з неправильними числами, за яким клуб
 * підніме ціну не на ту годину. Тому весь час фіксований, а перевіряються
 * саме ті місця, де арифметика часу підводить: довгі броні, робота за
 * північ і перехід на зимовий час.
 */

const TZ = 'Europe/Kyiv';

/** Локальний час Києва -> Date. Улітку це UTC+3, узимку UTC+2. */
const kyiv = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toJSDate();

/** Клуб відкритий 08:00–22:00 усі сім днів */
const openAllWeek: HoursRow[] = Array.from({ length: 7 }, (_, weekday) => ({
  weekday,
  openMinute: 8 * 60,
  closeMinute: 22 * 60,
  isClosed: false,
}));

const court = (id: string, created = '2020-01-01T00:00') => ({ id, createdAt: kyiv(created) });

/** Понеділок 2026-08-03 00:00 — рівно тиждень до наступного понеділка */
const base: LoadProfileInput = {
  from: kyiv('2026-08-03T00:00'),
  to: kyiv('2026-08-10T00:00'),
  timezone: TZ,
  hours: openAllWeek,
  courts: [court('a'), court('b')],
  blocks: [],
  bookings: [],
};

const hourOf = (p: ReturnType<typeof buildLoadProfile>, h: number) =>
  p.byHour.find((x) => x.hour === h)!;

/** 0 = неділя, 1 = понеділок … як у ClubHours */
const weekdayOf = (p: ReturnType<typeof buildLoadProfile>, d: number) =>
  p.byWeekday.find((x) => x.weekday === d)!;

describe('знаменник — скільки клуб міг продати', () => {
  it('дві години на корт на день дають рівно стільки хвилин, скільки відкрито', () => {
    const p = buildLoadProfile(base);

    // 14 відкритих годин: 08:00..21:00
    expect(p.byHour).toHaveLength(14);
    // Кожна година: 7 днів × 2 корти × 60 хв
    expect(hourOf(p, 8).openMinutes).toBe(840);
    expect(hourOf(p, 21).openMinutes).toBe(840);
    // Понеділок: 14 годин × 2 корти × 60
    expect(weekdayOf(p, 1).openMinutes).toBe(1680);
  });

  it('закритий день не потрапляє в знаменник', () => {
    const hours = openAllWeek.map((h) => (h.weekday === 0 ? { ...h, isClosed: true } : h));
    const p = buildLoadProfile({ ...base, hours });

    expect(weekdayOf(p, 0).openMinutes).toBe(0);
    expect(weekdayOf(p, 0).occupancy).toBe(0);
    // 6 днів замість 7
    expect(hourOf(p, 8).openMinutes).toBe(720);
  });

  it('корт, заведений посеред тижня, не простоює до свого народження', () => {
    const p = buildLoadProfile({
      ...base,
      courts: [court('a'), court('b', '2026-08-07T00:00')], // з п'ятниці
    });

    // Понеділок: тільки один корт
    expect(weekdayOf(p, 1).openMinutes).toBe(840);
    // П'ятниця: обидва
    expect(weekdayOf(p, 5).openMinutes).toBe(1680);
  });

  it('блокування корту віднімається з доступних хвилин', () => {
    const p = buildLoadProfile({
      ...base,
      blocks: [{ courtId: 'a', startTime: kyiv('2026-08-03T10:00'), endTime: kyiv('2026-08-03T12:00') }],
    });

    // 10-та година втратила годину одного корту
    expect(hourOf(p, 10).openMinutes).toBe(840 - 60);
    expect(hourOf(p, 11).openMinutes).toBe(840 - 60);
    expect(hourOf(p, 12).openMinutes).toBe(840);
  });

  it('блокування всього клубу знімає всі корти', () => {
    const p = buildLoadProfile({
      ...base,
      blocks: [{ courtId: null, startTime: kyiv('2026-08-03T10:00'), endTime: kyiv('2026-08-03T11:00') }],
    });

    expect(hourOf(p, 10).openMinutes).toBe(840 - 120);
  });

  it('блокування поза робочими годинами нічого не змінює', () => {
    const p = buildLoadProfile({
      ...base,
      blocks: [{ courtId: 'a', startTime: kyiv('2026-08-03T02:00'), endTime: kyiv('2026-08-03T06:00') }],
    });

    expect(p.totals.openMinutes).toBe(buildLoadProfile(base).totals.openMinutes);
  });
});

describe('чисельник — що продано', () => {
  const booking = (start: string, end: string, priceTotal = 40_000) => ({
    courtId: 'a',
    startTime: kyiv(start),
    endTime: kyiv(end),
    priceTotal,
  });

  it('двогодинна бронь лягає в ОБИДВІ години', () => {
    const p = buildLoadProfile({ ...base, bookings: [booking('2026-08-03T19:00', '2026-08-03T21:00')] });

    expect(hourOf(p, 19).bookedMinutes).toBe(60);
    expect(hourOf(p, 20).bookedMinutes).toBe(60);
  });

  it('штука броні й гроші рахуються лише в годині початку', () => {
    const p = buildLoadProfile({ ...base, bookings: [booking('2026-08-03T19:00', '2026-08-03T21:00')] });

    expect(hourOf(p, 19).bookings).toBe(1);
    expect(hourOf(p, 19).revenue).toBe(40_000);
    expect(hourOf(p, 20).bookings).toBe(0);
    expect(hourOf(p, 20).revenue).toBe(0);
    expect(p.totals.bookings).toBe(1);
    expect(p.totals.revenue).toBe(40_000);
  });

  it('півтори години розкладаються 60 + 30', () => {
    const p = buildLoadProfile({ ...base, bookings: [booking('2026-08-03T18:30', '2026-08-03T20:00')] });

    expect(hourOf(p, 18).bookedMinutes).toBe(30);
    expect(hourOf(p, 19).bookedMinutes).toBe(60);
  });

  it('завантаження — це дріб, а не кількість броней', () => {
    // Одна година з двох доступних у цій клітинці одного дня
    const p = buildLoadProfile({
      ...base,
      from: kyiv('2026-08-03T00:00'),
      to: kyiv('2026-08-04T00:00'),
      bookings: [booking('2026-08-03T19:00', '2026-08-03T20:00')],
    });

    expect(hourOf(p, 19).openMinutes).toBe(120); // два корти
    expect(hourOf(p, 19).occupancy).toBe(0.5);
  });

  it('бронь поза робочими годинами не дає завантаження понад 100%', () => {
    const p = buildLoadProfile({
      ...base,
      from: kyiv('2026-08-03T00:00'),
      to: kyiv('2026-08-04T00:00'),
      bookings: [
        booking('2026-08-03T19:00', '2026-08-03T20:00'),
        booking('2026-08-03T19:00', '2026-08-03T20:00'),
        booking('2026-08-03T19:00', '2026-08-03T20:00'),
      ],
    });

    expect(hourOf(p, 19).occupancy).toBe(1);
  });

  it('бронь за межами вікна обрізається, а не викидається цілком', () => {
    const p = buildLoadProfile({
      ...base,
      bookings: [booking('2026-08-09T23:00', '2026-08-10T01:00')],
    });

    // До вікна входить тільки перша година
    expect(hourOf(p, 23)).toBeUndefined(); // клуб о 23:00 зачинений — у знаменнику її нема
    expect(p.totals.bookedMinutes).toBe(60);
  });
});

describe('матриця для теплової карти', () => {
  it('усі сім днів на кожну відкриту годину', () => {
    const p = buildLoadProfile(base);

    expect(p.cells).toHaveLength(14 * 7);
    expect(new Set(p.cells.map((c) => c.hour)).size).toBe(14);
  });

  it('зачинений день лишається в матриці з нульовою місткістю', () => {
    const hours = openAllWeek.map((h) => (h.weekday === 0 ? { ...h, isClosed: true } : h));
    const p = buildLoadProfile({ ...base, hours });

    const sunday = p.cells.filter((c) => c.weekday === 0);
    expect(sunday).toHaveLength(14);
    // Клітинку видно, але вона порожня — карта намалює її штриховкою,
    // а не нулем: зачинено і «ніхто не прийшов» — різні речі.
    expect(sunday.every((c) => c.openMinutes === 0)).toBe(true);
  });

  it('клітинка знає своє завантаження окремо від сусідів', () => {
    const p = buildLoadProfile({
      ...base,
      bookings: [{
        courtId: 'a',
        startTime: kyiv('2026-08-03T19:00'),
        endTime: kyiv('2026-08-03T20:00'),
        priceTotal: 40_000,
      }],
    });

    const cell = p.cells.find((c) => c.weekday === 1 && c.hour === 19)!;
    expect(cell.bookings).toBe(1);
    expect(cell.bookedMinutes).toBe(60);
    expect(cell.openMinutes).toBe(120); // два корти в один понеділок
    expect(cell.occupancy).toBe(0.5);

    const quiet = p.cells.find((c) => c.weekday === 2 && c.hour === 19)!;
    expect(quiet.bookedMinutes).toBe(0);
  });
});

describe('клуб, що працює за північ', () => {
  const lateHours: HoursRow[] = Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    openMinute: 8 * 60,
    closeMinute: 26 * 60, // до 02:00
    isClosed: false,
  }));

  it('поріг доби береться з найпізнішого закриття', () => {
    expect(clubDayCutoff(openAllWeek)).toBe(0);
    expect(clubDayCutoff(lateHours)).toBe(120);
  });

  it('00:30 суботи належить п\'ятниці', () => {
    const at = DateTime.fromISO('2026-08-08T00:30', { zone: TZ }); // субота
    expect(clubWeekday(at, 0)).toBe(6);   // без нічної роботи — субота
    expect(clubWeekday(at, 120)).toBe(5); // з роботою до 02:00 — п'ятниця
  });

  it('нічна бронь рахується в день, коли клуб її продав', () => {
    const p = buildLoadProfile({
      ...base,
      hours: lateHours,
      bookings: [{
        courtId: 'a',
        startTime: kyiv('2026-08-08T00:00'), // ніч з п'ятниці на суботу
        endTime: kyiv('2026-08-08T01:00'),
        priceTotal: 50_000,
      }],
    });

    expect(weekdayOf(p, 5).bookedMinutes).toBe(60); // п'ятниця
    expect(weekdayOf(p, 6).bookedMinutes).toBe(0);  // субота
    expect(hourOf(p, 0).bookedMinutes).toBe(60);    // година доби — все ще нульова
  });
});

describe('межі вікна', () => {
  it('бронь, що почалась до вікна, віддає хвилини, але не штуку й не гроші', () => {
    const p = buildLoadProfile({
      ...base,
      hours: Array.from({ length: 7 }, (_, weekday) => ({
        weekday, openMinute: 0, closeMinute: 24 * 60, isClosed: false,
      })),
      bookings: [{
        courtId: 'a',
        startTime: kyiv('2026-08-02T23:00'), // неділя, до початку вікна
        endTime: kyiv('2026-08-03T01:00'),   // понеділок, уже у вікні
        priceTotal: 60_000,
      }],
    });

    // Година у вікні зайнята — це правда, корт стояв зайнятий
    expect(p.totals.bookedMinutes).toBe(60);
    // А продали її минулого тижня, і там вона вже порахована
    expect(p.totals.bookings).toBe(0);
    expect(p.totals.revenue).toBe(0);
  });

  it('бронь рівно на початку вікна рахується повністю', () => {
    const p = buildLoadProfile({
      ...base,
      hours: Array.from({ length: 7 }, (_, weekday) => ({
        weekday, openMinute: 0, closeMinute: 24 * 60, isClosed: false,
      })),
      bookings: [{
        courtId: 'a',
        startTime: kyiv('2026-08-03T00:00'),
        endTime: kyiv('2026-08-03T01:00'),
        priceTotal: 60_000,
      }],
    });

    expect(p.totals.bookings).toBe(1);
    expect(p.totals.revenue).toBe(60_000);
  });
});

describe('перехід на зимовий час', () => {
  /* Ніч 25.10.2026 у Києві: 04:00 стає 03:00, доба триває 25 годин.
     Той самий випадок, на якому тестується сітка слотів. */
  const allDay: HoursRow[] = Array.from({ length: 7 }, (_, weekday) => ({
    weekday, openMinute: 0, closeMinute: 24 * 60, isClosed: false,
  }));

  const dstBase = {
    from: kyiv('2026-10-25T00:00'),
    to: kyiv('2026-10-26T00:00'),
    timezone: TZ,
    hours: allDay,
    courts: [court('a')],
    blocks: [],
  };

  it('доба з подвійною третьою годиною не ламає знаменник', () => {
    const p = buildLoadProfile({
      ...dstBase,
      bookings: [{
        courtId: 'a',
        startTime: kyiv('2026-10-25T10:00'),
        endTime: kyiv('2026-10-25T11:00'),
        priceTotal: 30_000,
      }],
    });

    /* Головне: жодна клітинка не виходить за 100%, а сума хвилин дорівнює
       рівно тому, що клуб виставив на продаж (1440 хв від відкриття). */
    expect(p.totals.openMinutes).toBe(1440);
    expect(p.byHour.every((h) => h.occupancy <= 1)).toBe(true);
    expect(p.totals.bookedMinutes).toBe(60);
  });

  it('бронь усередині подвоєної години не губить хвилин', () => {
    /* 00:30 UTC — це вже ДРУГА третя година в Києві (перша йде з UTC+3,
       друга з UTC+2). Курсор стартує всередині неоднозначного часу, і
       саме тут наївний обхід годинних меж або зациклюється, або мовчки
       обриває інтервал. */
    const p = buildLoadProfile({
      ...dstBase,
      bookings: [{
        courtId: 'a',
        startTime: new Date('2026-10-25T00:30:00.000Z'),
        endTime: new Date('2026-10-25T02:30:00.000Z'),
        priceTotal: 30_000,
      }],
    });

    expect(p.totals.bookedMinutes).toBe(120);
    expect(p.totals.bookings).toBe(1);
  });

  it('година, що існує двічі, має подвійну місткість, а не подвійне завантаження', () => {
    const p = buildLoadProfile({ ...dstBase, bookings: [] });

    const three = p.byHour.find((h) => h.hour === 3)!;
    const four = p.byHour.find((h) => h.hour === 4)!;
    expect(three.openMinutes).toBe(120); // 03:00 цієї доби триває дві години
    expect(four.openMinutes).toBe(60);
  });
});
