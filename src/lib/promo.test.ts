import { describe, it, expect } from 'vitest';

import {
  promoPrice, matchesSlot, bestPromo, birthdayOffsetDays, inBirthdayWindow,
  courtPriceWithPromos, MAX_PERCENT, MAX_BIRTHDAY_DAYS,
  type PromoRule,
} from './promo';

const weekly: PromoRule = {
  kind: 'WEEKLY',
  weekdays: [1, 2, 3],
  startMinute: 10 * 60,
  endMinute: 14 * 60,
  discountType: 'PERCENT',
  discountValue: 30,
  courtIds: [],
  isActive: true,
};

const birthday: PromoRule = {
  kind: 'BIRTHDAY',
  daysBefore: 7,
  daysAfter: 7,
  startMinute: 0,
  endMinute: 24 * 60,
  discountType: 'PERCENT',
  discountValue: 50,
  courtIds: [],
  isActive: true,
};

describe('promoPrice', () => {
  it('рахує відсоток і пряму ціну', () => {
    expect(promoPrice(40000, weekly)).toBe(28000);
    expect(promoPrice(40000, { ...weekly, discountType: 'PRICE', discountValue: 25000 })).toBe(25000);
  });

  /* Мовчки взяти більше, ніж написано на корті, не можна. */
  it('не піднімає ціну вище за базову', () => {
    expect(promoPrice(30000, { ...weekly, discountType: 'PRICE', discountValue: 50000 })).toBe(30000);
  });

  it('тримає стелю знижки', () => {
    expect(promoPrice(10000, { ...weekly, discountValue: 100 }))
      .toBe(promoPrice(10000, { ...weekly, discountValue: MAX_PERCENT }));
  });
});

describe('matchesSlot', () => {
  const monday = '2026-09-07';

  it('діє у свій день і своє вікно', () => {
    expect(matchesSlot(weekly, { date: monday, startMinute: 11 * 60 })).toBe(true);
    expect(matchesSlot(weekly, { date: '2026-09-12', startMinute: 11 * 60 })).toBe(false);
    expect(matchesSlot(weekly, { date: monday, startMinute: 14 * 60 })).toBe(false);
  });

  it('вимкнена акція не діє ніколи', () => {
    expect(matchesSlot({ ...weekly, isActive: false }, { date: monday, startMinute: 11 * 60 })).toBe(false);
  });

  it('список кортів обмежує акцію, порожній — ні', () => {
    const one = { ...weekly, courtIds: ['c1'] };
    expect(matchesSlot(one, { date: monday, startMinute: 11 * 60, courtId: 'c1' })).toBe(true);
    expect(matchesSlot(one, { date: monday, startMinute: 11 * 60, courtId: 'c2' })).toBe(false);
    expect(matchesSlot(weekly, { date: monday, startMinute: 11 * 60, courtId: 'c2' })).toBe(true);
  });

  it('акційні дні беруть проміжок включно і приймають Date з бази', () => {
    const dates: PromoRule = {
      ...weekly,
      kind: 'DATES',
      dateFrom: new Date('2026-09-07T00:00:00.000Z'),
      dateTo: new Date('2026-09-09T00:00:00.000Z'),
    };
    expect(matchesSlot(dates, { date: '2026-09-09', startMinute: 11 * 60 })).toBe(true);
    expect(matchesSlot(dates, { date: '2026-09-10', startMinute: 11 * 60 })).toBe(false);
  });
});

describe('день народження', () => {
  it('рахує дні до і після', () => {
    expect(birthdayOffsetDays('1990-09-15', '2026-09-11')).toBe(-4);
    expect(birthdayOffsetDays('1990-09-15', '2026-09-15')).toBe(0);
    expect(birthdayOffsetDays('1990-09-15', '2026-09-20')).toBe(5);
  });

  /* Народженому 1 січня 28 грудня лишається чотири дні до свята, а не 362. */
  it('не губить іменинників через межу року', () => {
    expect(birthdayOffsetDays('1990-01-01', '2026-12-28')).toBe(-4);
    expect(birthdayOffsetDays('1990-12-31', '2027-01-03')).toBe(3);
  });

  /* Та сама поведінка, що й у daysUntilBirthday (src/lib/birthday.ts). */
  it('у невисокосний рік святкує 28 лютого', () => {
    expect(birthdayOffsetDays('2000-02-29', '2027-02-28')).toBe(0);
    expect(birthdayOffsetDays('2000-02-29', '2028-02-29')).toBe(0);
  });

  it('приймає Date з бази, а не лише рядок', () => {
    expect(birthdayOffsetDays(new Date('1990-09-15T00:00:00.000Z'), '2026-09-15')).toBe(0);
  });

  it('тримає вікно з обох боків', () => {
    const slot = (date: string) => ({ date, startMinute: 11 * 60, birthDate: '1990-09-15' });
    expect(matchesSlot(birthday, slot('2026-09-08'))).toBe(true);
    expect(matchesSlot(birthday, slot('2026-09-22'))).toBe(true);
    expect(matchesSlot(birthday, slot('2026-09-07'))).toBe(false);
    expect(matchesSlot(birthday, slot('2026-09-23'))).toBe(false);
  });

  /* Показати знижку всім, а на касі вимагати документ — гірше, ніж не
     показати зовсім. */
  it('без дати народження не діє', () => {
    expect(matchesSlot(birthday, { date: '2026-09-15', startMinute: 11 * 60 })).toBe(false);
    expect(inBirthdayWindow(birthday, null, '2026-09-15')).toBe(false);
  });

  it('нульове вікно — це рівно день народження', () => {
    const exact = { ...birthday, daysBefore: 0, daysAfter: 0 };
    const slot = (date: string) => ({ date, startMinute: 11 * 60, birthDate: '1990-09-15' });
    expect(matchesSlot(exact, slot('2026-09-15'))).toBe(true);
    expect(matchesSlot(exact, slot('2026-09-16'))).toBe(false);
  });

  it('не пускає вікно ширше за стелю', () => {
    const huge = { ...birthday, daysBefore: 900, daysAfter: 900 };
    const far = { date: '2026-03-15', startMinute: 11 * 60, birthDate: '1990-09-15' };
    expect(matchesSlot(huge, far)).toBe(false);
    expect(MAX_BIRTHDAY_DAYS).toBe(60);
  });
});

describe('bestPromo', () => {
  const slot = { date: '2026-09-07', startMinute: 11 * 60 };

  /* Порядок у списку не має вирішувати ціну. */
  it('обирає найвигіднішу для гравця, а не першу в списку', () => {
    const small = { ...weekly, discountValue: 10 };
    const big = { ...weekly, discountValue: 40 };
    expect(bestPromo([small, big], slot, 40000)).toBe(big);
    expect(bestPromo([big, small], slot, 40000)).toBe(big);
  });

  it('віддає null, коли жодна не діє', () => {
    expect(bestPromo([weekly], { date: '2026-09-12', startMinute: 11 * 60 }, 40000)).toBeNull();
  });
});

describe('courtPriceWithPromos', () => {
  const tz = 'Europe/Kyiv';
  const at = (hhmm: string) => new Date(`2026-09-07T${hhmm}:00+03:00`); // понеділок

  const price = (from: string, to: string, promos: PromoRule[], birthDate?: string) =>
    courtPriceWithPromos({
      pricePerHour: 40000,
      start: at(from),
      end: at(to),
      timezone: tz,
      slotMinutes: 60,
      courtId: 'c1',
      promos,
      birthDate,
    });

  it('без акцій віддає ту саму ціну, що й раніше', () => {
    expect(price('19:00', '21:00', []).price).toBe(80000);
  });

  /* Найтихіша з можливих поломок: клуб завів акцію на ранок, а вечірні
     броні почали коштувати на копійку інакше через округлення шматків. */
  it('не чіпає ціну, коли жодна акція не підійшла', () => {
    const res = price('19:00', '21:00', [weekly]);
    expect(res.price).toBe(80000);
    expect(res.applied).toEqual([]);
  });

  it('рахує знижку на всю бронь усередині вікна', () => {
    const res = price('11:00', '13:00', [weekly]);
    expect(res.price).toBe(56000);
    expect(res.basePrice).toBe(80000);
    expect(res.applied).toHaveLength(1);
  });

  /* Бронь довша за вікно акції. Шматок, що почався о 13:00, акційний
     цілком; той, що о 14:00, — уже ні. */
  it('ріже бронь по сітці, а не міряє перетин', () => {
    expect(price('13:00', '15:00', [weekly]).price).toBe(28000 + 40000);
  });

  it('день народження знає, хто бронює', () => {
    expect(price('19:00', '20:00', [birthday], '1990-09-10').price).toBe(20000);
    expect(price('19:00', '20:00', [birthday], '1990-03-10').price).toBe(40000);
    expect(price('19:00', '20:00', [birthday]).price).toBe(40000);
  });

  it('на збігу акцій бере найвигіднішу для гравця', () => {
    /* Понеділок 11:00 всередині «щасливих годин» (−30%), і той самий день
       за три дні до дня народження (−50%). Виграє −50%. */
    expect(price('11:00', '12:00', [weekly, birthday], '1990-09-10').price).toBe(20000);
  });
});
