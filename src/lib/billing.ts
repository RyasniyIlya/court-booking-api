import { DateTime } from 'luxon';

/**
 * Стан обслуговування клубу — одне місце, де він рахується.
 *
 * Правило одне: `paidUntil` у минулому більше ніж на GRACE_DAYS -> онлайн-запис
 * вимикається. Але ця функція навмисно не знає, ЩО саме вимикається — вона
 * віддає стан, а рішення приймають роути. Інакше логіка розповзеться по
 * трьох файлах і почне розходитись між віджетом і кабінетом.
 *
 * ── Чому тиждень, а не два дні ────────────────────────────────────────────
 *
 * 500 грн — це менше, ніж коштує одна година корту. Клуб не «не хоче
 * платити», він забув: власник у відрядженні, бухгалтер у відпустці, рахунок
 * загубився в пошті. Відсічка на другий день перетворює забудькуватість на
 * ворожнечу, а ринок тут — 300–500 клубів, де всі одне одного знають.
 *
 * ── Чому кабінет не блокується ────────────────────────────────────────────
 *
 * У кабінеті лежать броні клубу — його робота і його гроші. Забрати до них
 * доступ за 500 грн боргу непропорційно, і це саме той крок, після якого
 * пишуть у профільні чати. Вимикається тільки онлайн-запис: дзвінки
 * повертаються на адміністратора, і мотивація заплатити виникає сама.
 *
 * ── Чому гравець не бачить помилки ────────────────────────────────────────
 *
 * Він не винен, що клуб забув заплатити. Замість зламаного віджета він
 * бачить робочий блок з телефоном — рівно те, як усе працювало до нас.
 */

/** Скільки днів після кінця оплаченого періоду онлайн-запис ще працює */
export const GRACE_DAYS = 7;

/** За скільки днів до кінця починаємо попереджати */
export const WARN_DAYS = 14;

export type BillingState =
  /** Оплачено, до кінця більше WARN_DAYS */
  | 'ok'
  /** Скоро кінець — показуємо спокійну плашку */
  | 'due'
  /** Строк вийшов, але тиждень пільги ще йде: все працює, плашка червона */
  | 'grace'
  /** Пільга скінчилась — онлайн-запис вимкнено */
  | 'blocked';

export type BillingInfo = {
  state: BillingState;
  /** Дата, до якої оплачено. null — ще жодного разу не платили */
  paidUntil: Date | null;
  /**
   * Днів до кінця оплаченого періоду. Відʼємне — стільки днів прострочено.
   * null, якщо paidUntil не заданий.
   */
  daysLeft: number | null;
  /** Скільки днів пільги лишилось. 0 — пільга скінчилась */
  graceLeft: number;
  /** Чи працює онлайн-запис у віджеті */
  online: boolean;
};

type ClubLike = {
  paidUntil?: Date | null;
  isActive?: boolean;
};

/**
 * Порахувати стан.
 *
 * `now` параметром, а не `new Date()` усередині: інакше цю функцію не можна
 * протестувати, не переводячи системний годинник.
 *
 * Дні рахуються по КАЛЕНДАРНИХ днях, а не діленням мілісекунд на 86400000.
 * Різниця видна на переході на зимовий час: доба тоді 25 годин, і «залишилось
 * 7 днів» перетворилось би на 6,96 -> 6 після Math.floor. Клуб побачив би, що
 * день зник нізвідки.
 */
export function clubBilling(club: ClubLike, now: Date = new Date()): BillingInfo {
  // Вимкнений вручну — це не про гроші, а про рішення людини. Але назовні
  // виглядає так само: онлайн-запис не працює.
  if (club.isActive === false) {
    return {
      state: 'blocked',
      paidUntil: club.paidUntil ?? null,
      daysLeft: null,
      graceLeft: 0,
      online: false,
    };
  }

  const paidUntil = club.paidUntil ?? null;

  // Ще жодного разу не платили. Так виглядає свіже впровадження, де перший
  // рік входить у встановлення, — блокувати такий клуб було б абсурдом.
  if (!paidUntil) {
    return { state: 'ok', paidUntil: null, daysLeft: null, graceLeft: GRACE_DAYS, online: true };
  }

  const end = DateTime.fromJSDate(paidUntil).startOf('day');
  const today = DateTime.fromJSDate(now).startOf('day');
  const daysLeft = Math.round(end.diff(today, 'days').days);

  if (daysLeft > WARN_DAYS) {
    return { state: 'ok', paidUntil, daysLeft, graceLeft: GRACE_DAYS, online: true };
  }
  if (daysLeft >= 0) {
    return { state: 'due', paidUntil, daysLeft, graceLeft: GRACE_DAYS, online: true };
  }

  const overdue = -daysLeft;
  if (overdue <= GRACE_DAYS) {
    return {
      state: 'grace',
      paidUntil,
      daysLeft,
      graceLeft: GRACE_DAYS - overdue,
      online: true,
    };
  }

  return { state: 'blocked', paidUntil, daysLeft, graceLeft: 0, online: false };
}

/** Наступна дата закінчення, якщо продовжити на один період від `from` */
export function extendPaidUntil(from: Date, period: 'MONTH' | 'QUARTER' | 'YEAR'): Date {
  const d = DateTime.fromJSDate(from);
  const step = period === 'YEAR' ? { years: 1 } : period === 'QUARTER' ? { months: 3 } : { months: 1 };
  return d.plus(step).toJSDate();
}

/**
 * Скільки коштує період. Копійки.
 *
 * Рік дешевший не з жадібності до знижок, а тому що одна транзакція замість
 * дванадцяти економить нам дванадцять нагадувань — і саме це ми віддаємо
 * клубу як тисячу гривень.
 */
export const PERIOD_PRICE: Record<'MONTH' | 'QUARTER' | 'YEAR', number> = {
  MONTH: 500_00,
  QUARTER: 1_500_00,
  YEAR: 5_000_00,
};

export const PERIOD_LABEL: Record<'MONTH' | 'QUARTER' | 'YEAR', string> = {
  MONTH: 'місяць',
  QUARTER: 'квартал',
  YEAR: 'рік',
};
