/**
 * Українські форми множини.
 *
 * «8 броней», «2 броні», «1 бронь» — три різні форми, і бот, який пише
 * «1 броней», виглядає як таблиця в базі, а не як повідомлення від свого
 * клубу. Дрібниця, яку помічають усі.
 *
 * Правило те саме, що в CLDR для української: одна форма для чисел, що
 * закінчуються на 1 (крім 11), друга — для 2–4 (крім 12–14), третя —
 * для решти.
 */

export type Forms = [one: string, few: string, many: string];

export function plural(n: number, forms: Forms): string {
  const abs = Math.abs(Math.trunc(n));
  const last = abs % 10;
  const lastTwo = abs % 100;

  /* 11–14 — виняток: «одинадцять броней», а не «одинадцять бронь».
     Без цієї перевірки 11 потрапило б у форму для одиниці. */
  if (lastTwo >= 11 && lastTwo <= 14) return forms[2];
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];

  return forms[2];
}

/** «8 броней» — число разом із потрібною формою */
export const count = (n: number, forms: Forms) => `${n} ${plural(n, forms)}`;

export const BOOKINGS: Forms = ['бронь', 'броні', 'броней'];
export const CUSTOMERS: Forms = ['новий клієнт', 'нові клієнти', 'нових клієнтів'];
export const DAYS: Forms = ['день', 'дні', 'днів'];
export const WEEKS: Forms = ['тиждень', 'тижні', 'тижнів'];
export const SESSIONS: Forms = ['заняття', 'заняття', 'занять'];
