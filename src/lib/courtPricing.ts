/**
 * Ціна пакета залежно від кількості кортів.
 *
 * До INCLUDED_COURTS кортів включно — фіксована ціна плану, копійка в
 * копійку. Далі множник росте параболою від кортів понад включені:
 *
 *   m(n) = 1 + LINEAR·x + QUADRATIC·x²,   x = max(0, n − INCLUDED_COURTS)
 *
 * Чому парабола, а не лінія. Цінність софту росте з кількістю кортів майже
 * лінійно (більше годин — більше неявок, переписки й каси), а великий клуб
 * ще й користується глибше: зміни, кілька адмінів, тренери. Квадратичний
 * член це відображає. Коефіцієнти підібрані так, що ціна ЗА КОРТ спершу
 * падає (3 корти ≈ 833 грн/корт на «Аналітиці», 9–11 ≈ 585) і лише далі
 * повільно росте — знижка за обсяг лишається, як у ринку (аркуш «Сценарії»
 * у sales/КОРТ-ціна-для-клубу.xlsx: 7 кортів у регіоні — 3 500–5 000 грн,
 * тут 4 250).
 *
 * Понад AUTO_MAX_COURTS — індивідуальна пропозиція: формула лишається
 * підказкою, а ціну оператор ставить у Club.planPrice.
 *
 * Індивідуальна ціна (Club.planPrice) формулою НЕ множиться: це
 * домовленість про весь клуб, а не ставка за корт.
 */

export const INCLUDED_COURTS = 3;
export const LINEAR = 0.15;
export const QUADRATIC = 0.006;
/** Округлення розрахованої ціни — до 50 грн, копійки */
export const ROUND_TO = 50_00;
/** Далі — індивідуально */
export const AUTO_MAX_COURTS = 12;

export function courtMultiplier(courts: number | null | undefined): number {
  const n = Number.isFinite(courts) ? Math.floor(courts as number) : 0;
  const x = Math.max(0, n - INCLUDED_COURTS);
  return 1 + LINEAR * x + QUADRATIC * x * x;
}

/**
 * Ціна за період плану з урахуванням кортів, копійки.
 *
 * До включених кортів (і коли кількість невідома) — базова ціна без
 * округлення: сума з каталогу не має зсуватись на копійку.
 */
export function courtPrice(basePrice: number, courts: number | null | undefined): number {
  if (basePrice <= 0) return basePrice;
  if (courts == null || courts <= INCLUDED_COURTS) return basePrice;
  return Math.round((basePrice * courtMultiplier(courts)) / ROUND_TO) * ROUND_TO;
}

export function isCustomQuote(courts: number | null | undefined): boolean {
  return courts != null && courts > AUTO_MAX_COURTS;
}

/** Параметри для панелі оператора — щоб клієнт не тримав копію констант */
export const COURT_PRICING = {
  includedCourts: INCLUDED_COURTS,
  linear: LINEAR,
  quadratic: QUADRATIC,
  roundTo: ROUND_TO,
  autoMaxCourts: AUTO_MAX_COURTS,
} as const;
