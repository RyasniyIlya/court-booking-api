/**
 * Акційні ціни на час корту.
 *
 * Клуб продає ранок і будні дешевше, ніж вечір пʼятниці, а імениннику дає
 * свій тиждень знижки. Доти єдиною ціною була `Court.pricePerHour`, і все
 * інше домовлялось телефоном — повз віджет і повз касу.
 *
 * ── Чому це живе на сервері ──────────────────────────────────────────────
 * Кабінет має дзеркало цього файлу (web/src/lib/promo.js), але воно вміє
 * лише показати очікувану ціну. Ціну, яку гравець реально заплатить, рахує
 * тільки цей модуль: значення, приїхале з браузера, не є домовленістю.
 * Тому обидві копії мають відповідати однаково — будь-яка розбіжність
 * гравець побачить як «на екрані було 250, списали 400».
 *
 * ── Ціна броні, а не слоту ───────────────────────────────────────────────
 * Акція має вікно всередині дня, а бронь буває довшою за нього. Рахуємо
 * по слотах сітки: кожен шматок бере ту акцію, що діє на його ПОЧАТОК.
 * Інакше година 13:30–14:30 на межі вікна коштувала б двома різними
 * цінами всередині себе, і жодна афіша цього не пояснить.
 */

import { DateTime } from 'luxon';

export type PromoKind = 'WEEKLY' | 'DATES' | 'BIRTHDAY';
export type PromoDiscount = 'PERCENT' | 'PRICE';

export type PromoRule = {
  id?: string;
  title?: string;
  kind: PromoKind;
  weekdays?: number[];
  dateFrom?: Date | string | null;
  dateTo?: Date | string | null;
  daysBefore?: number | null;
  daysAfter?: number | null;
  startMinute: number;
  endMinute: number;
  discountType: PromoDiscount;
  discountValue: number;
  courtIds?: string[];
  isActive?: boolean;
};

/**
 * Стеля знижки — 90%, та сама, що в кабінеті й у CHECK-констрейнті.
 * Не 100: «безкоштовно» майже завжди не акція, а зайвий нуль у полі.
 */
export const MAX_PERCENT = 90;

/** Ширше вікно дня народження — це вже не свято, а новий тариф. */
export const MAX_BIRTHDAY_DAYS = 60;

const DAY_MS = 86_400_000;

const clampKop = (kop: number) => Math.max(0, Math.round(kop));

/** Ціна години з урахуванням акції. Без акції — базова ціна корту. */
export function promoPrice(baseKop: number, promo?: PromoRule | null): number {
  const base = clampKop(baseKop ?? 0);
  if (!promo) return base;

  if (promo.discountType === 'PRICE') {
    /* Пряма ціна вище за базову — це не акція, а підвищення. Мовчки взяти
       з гравця більше, ніж написано на корті, не можна. */
    return Math.min(base, clampKop(promo.discountValue));
  }

  const percent = Math.min(MAX_PERCENT, Math.max(0, Number(promo.discountValue) || 0));
  return clampKop((base * (100 - percent)) / 100);
}

/** 'YYYY-MM-DD' з дати народження (DATE у базі — вже без часу). */
const ymd = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

/**
 * Той самий день народження в заданому році.
 *
 * 29 лютого в невисокосному році Date переносить на 1 березня — а святкують
 * у лютому. Притискаємо до останнього дня лютого, як і `daysUntilBirthday`
 * у src/lib/birthday.ts: знижка має прийти тоді, коли людина її чекає.
 */
const birthdayInYear = (year: number, month: number, day: number): number => {
  const ts = Date.UTC(year, month - 1, day);
  if (new Date(ts).getUTCMonth() !== month - 1) return Date.UTC(year, month, 0);
  return ts;
};

/**
 * Скільки днів між датою і найближчим днем народження:
 * мінус — до, плюс — після. `null`, якщо дати народження немає.
 *
 * Дивимось на три роки. Народженому 1 січня 28 грудня лишається чотири дні
 * до свята, а не 362 — інакше всі новорічні іменинники випадали б з акції
 * рівно тоді, коли вона їм потрібна.
 */
export function birthdayOffsetDays(
  birthDate: Date | string | null | undefined,
  date: string,
): number | null {
  const born = ymd(birthDate);
  const day = ymd(date);
  if (!born || !day) return null;

  const [by, bm, bd] = born.split('-').map(Number);
  const [dy, dm, dd] = day.split('-').map(Number);
  if (!by || !bm || !bd || !dy || !dm || !dd) return null;

  const dayTs = Date.UTC(dy, dm - 1, dd);
  return [dy - 1, dy, dy + 1]
    .map((year) => Math.round((dayTs - birthdayInYear(year, bm, bd)) / DAY_MS))
    .reduce((best, offset) => (Math.abs(offset) < Math.abs(best) ? offset : best));
}

const birthdayWindow = (promo: PromoRule) => ({
  before: Math.min(MAX_BIRTHDAY_DAYS, Math.max(0, Math.round(Number(promo.daysBefore) || 0))),
  after: Math.min(MAX_BIRTHDAY_DAYS, Math.max(0, Math.round(Number(promo.daysAfter) || 0))),
});

/** Чи потрапляє дата у вікно дня народження цього гравця. */
export function inBirthdayWindow(
  promo: PromoRule,
  birthDate: Date | string | null | undefined,
  date: string,
): boolean {
  const offset = birthdayOffsetDays(birthDate, date);
  if (offset == null) return false;
  const { before, after } = birthdayWindow(promo);
  return offset >= -before && offset <= after;
}

export type SlotContext = {
  /** Локальна дата клубу, 'YYYY-MM-DD'. */
  date: string;
  /** Хвилина ПОЧАТКУ слоту від опівночі, локальний час клубу. */
  startMinute: number;
  courtId?: string;
  /** Дата народження гравця; без неї акція на ДН не діє. */
  birthDate?: Date | string | null;
};

/** Чи діє правило на конкретну годину конкретного корту. */
export function matchesSlot(promo: PromoRule, slot: SlotContext): boolean {
  if (!promo || promo.isActive === false) return false;

  const courts = promo.courtIds ?? [];
  if (courts.length > 0 && (!slot.courtId || !courts.includes(slot.courtId))) return false;

  const min = Number(slot.startMinute);
  if (!(min >= Number(promo.startMinute) && min < Number(promo.endMinute))) return false;

  /* Без дати народження — ні. Показати знижку в сітці всім, а на касі
     вимагати документ, гірше, ніж не показувати зовсім. */
  if (promo.kind === 'BIRTHDAY') return inBirthdayWindow(promo, slot.birthDate, slot.date);

  if (promo.kind === 'DATES') {
    const from = ymd(promo.dateFrom);
    const to = ymd(promo.dateTo);
    return Boolean(from && to && slot.date >= from && slot.date <= to);
  }

  const [y, m, d] = slot.date.split('-').map(Number);
  if (!y || !m || !d) return false;
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (promo.weekdays ?? []).includes(weekday);
}

/**
 * Яка акція діє на слот, коли їх кілька: та, що дає найнижчу ціну.
 *
 * Єдине правило, якого не доводиться пояснювати ні гравцю, ні
 * адміністратору: збіг двох акцій не може зробити дорожче. Порядок у
 * списку нічого не вирішує — інакше ціна залежала б від того, яку акцію
 * клуб завів раніше.
 */
export function bestPromo(
  promos: PromoRule[] | null | undefined,
  slot: SlotContext,
  baseKop: number,
): PromoRule | null {
  return (promos ?? [])
    .filter((p) => matchesSlot(p, slot))
    .reduce<PromoRule | null>(
      (best, p) => (best == null || promoPrice(baseKop, p) < promoPrice(baseKop, best) ? p : best),
      null,
    );
}

export type CourtPriceInput = {
  pricePerHour: number;
  start: Date;
  end: Date;
  timezone: string;
  /** Крок сітки клубу/корту, хв. По ньому ріжемо бронь на шматки. */
  slotMinutes: number;
  courtId: string;
  promos: PromoRule[];
  birthDate?: Date | string | null;
};

export type CourtPriceResult = {
  /** Скільки взяти за корт, копійки. */
  price: number;
  /** Скільки коштувало б без акцій — для «було 400, стало 280». */
  basePrice: number;
  /** Які акції спрацювали хоч на одному шматку броні. */
  applied: PromoRule[];
};

/**
 * Ціна корту за бронь із урахуванням акцій.
 *
 * Ріжемо на шматки по сітці й для кожного питаємо, яка акція діє на його
 * початок. Бронь вирівняна по сітці (isAlignedToGrid), тож останній шматок
 * рівний; але залишок усе одно рахуємо чесно, щоб функція не брехала на
 * даних, які колись прийдуть з адмінського роуту з довільним інтервалом.
 */
export function courtPriceWithPromos(input: CourtPriceInput): CourtPriceResult {
  const { pricePerHour, start, end, timezone, courtId, promos, birthDate } = input;
  const step = Math.max(1, Math.round(input.slotMinutes));

  const total = Math.round((end.getTime() - start.getTime()) / 60_000);
  const basePrice = clampKop((pricePerHour * total) / 60);
  if (total <= 0) return { price: 0, basePrice: 0, applied: [] };
  if (promos.length === 0) return { price: basePrice, basePrice, applied: [] };

  const from = DateTime.fromJSDate(start).setZone(timezone);
  const applied = new Map<PromoRule, true>();
  let price = 0;

  for (let offset = 0; offset < total; offset += step) {
    const minutes = Math.min(step, total - offset);
    const at = from.plus({ minutes: offset });
    const promo = bestPromo(
      promos,
      {
        date: at.toFormat('yyyy-MM-dd'),
        startMinute: at.hour * 60 + at.minute,
        courtId,
        birthDate,
      },
      pricePerHour,
    );

    if (promo) applied.set(promo, true);
    price += clampKop((promoPrice(pricePerHour, promo) * minutes) / 60);
  }

  /* Жодна не спрацювала — віддаємо рівно ту саму цифру, що й до появи
     акцій. Інакше клуб без жодної підхожої акції ловив би копійчані
     розбіжності від округлення шматків, і зійтись із касою стало б важче. */
  if (applied.size === 0) return { price: basePrice, basePrice, applied: [] };

  return { price, basePrice, applied: [...applied.keys()] };
}
