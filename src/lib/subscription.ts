import { extendPaidUntil, PERIOD_PRICE } from './billing';
import { clubPrice } from './plans';

export type Period = 'MONTH' | 'QUARTER' | 'YEAR';

/**
 * Видача підписки — арифметика окремо від роута, щоб її можна було
 * перевірити тестом, а не переказом на бойовому клубі.
 */

/**
 * Від якої дати рахувати новий період.
 *
 * Оплачено до майбутнього — продовжуємо ВІД НЕЇ: клуб, який платить за
 * тиждень до кінця, не має втрачати цей тиждень. Строк вийшов — рахуємо від
 * сьогодні: клуб, який повернувся через три місяці, не платить за час, коли
 * нічим не користувався. Це не поблажка, а єдина відповідь, яку не соромно
 * сказати вголос по телефону.
 *
 * Пробний період тут навмисно не враховується. Він безкоштовний і тримає
 * доступ сам (див. clubBilling): якщо клуб купив місяць посеред пробного,
 * доступ усе одно діє до пізнішої з дат, і зайвих днів у нього не забирають.
 * Рахувати оплату від кінця пробного означало б продати те, що вже віддано.
 */
export function periodStart(paidUntil: Date | null | undefined, now: Date = new Date()): Date {
  if (paidUntil && paidUntil > now) return paidUntil;
  return now;
}

/** Межі періоду, який зараз видається */
export function nextPeriod(
  paidUntil: Date | null | undefined,
  period: Period,
  now: Date = new Date(),
): { from: Date; to: Date } {
  const from = periodStart(paidUntil, now);
  return { from, to: extendPaidUntil(from, period) };
}

/**
 * Скільки виставити, копійки.
 *
 * Ціна клуба б'є ціну плану, план б'є прайс за період. Останнє — для клубів
 * без призначеного плану: їх багато (усі, заведені до появи планів), і
 * рахунок їм виставляти теж треба.
 *
 * ЦІНА ПЛАНУ ДІЄ ТІЛЬКИ ЗА СВІЙ ПЕРІОД. План на 500 грн/місяць не означає
 * 500 грн за рік: якщо оператор видає інший період, ніж записано в плані,
 * береться прайс за цей період. Інакше один необережний клік на «рік»
 * продав би дванадцять місяців за ціною одного, і помітилось би це через
 * одинадцять.
 *
 * Оператор у будь-якому разі бачить суму в полі й може вписати свою — це
 * підказка, а не остаточне рішення.
 *
 * `0` проходить наскрізь: безкоштовне впровадження — реальна домовленість, і
 * рахунок на нуль гривень у ній має бути видимим рядком, а не порожнечею.
 */
export function periodAmount(
  plan: { price: number; period: string } | null | undefined,
  planPriceOverride: number | null | undefined,
  period: Period,
): number {
  if (plan && plan.period !== period) return PERIOD_PRICE[period];

  const own = clubPrice(plan, planPriceOverride);
  if (own !== null) return own;
  return PERIOD_PRICE[period];
}
