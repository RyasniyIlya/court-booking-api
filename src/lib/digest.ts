import { DateTime } from 'luxon';

import { prisma } from './db';
import { telegramHtml } from './telegramHtml';
import { barChart, groupBars } from './charts';
import { BOOKINGS, count, CUSTOMERS, DAYS, WEEKS } from './plural';

/**
 * Цифри дня для власника: скільки броней, скільки грошей, скільки нових
 * людей і який корт сьогодні найзавантаженіший.
 *
 * Окремо від analytics.ts навмисно. Той рахує тиждень і місяць із
 * порівнянням до попереднього періоду — це звіт, у який дивляться раз на
 * тиждень. Тут інше питання: «як пройшов сьогоднішній день», і відповідь
 * має бути в одне повідомлення, без відсотків динаміки.
 *
 * День рахується в ТАЙМЗОНІ КЛУБУ, а не сервера. Render живе в UTC, і
 * київський вечір там уже завтра: власник о 23:00 отримав би цифри
 * наступного дня, тобто нулі.
 */

export type DayDigest = {
  /** Початок і кінець доби клубу, UTC */
  from: Date;
  to: Date;
  bookings: number;
  /** Копійки. Тільки підтверджені — скасоване не гроші */
  revenue: number;
  /** Скільки людей уперше потрапили в картотеку саме сьогодні */
  newCustomers: number;
  /** Найзавантаженіший корт дня і скільки на ньому броней */
  topCourt: { name: string; bookings: number } | null;
  /**
   * Виручка попереднього дня — щоб показати динаміку прямо в зведенні.
   * Необовʼязкове: саме число нічого не варте без сьогоднішнього, і
   * повідомлення без нього лишається цілим.
   */
  prevRevenue?: number;
};

/** Межі сьогоднішньої доби в таймзоні клубу */
export function clubDayBounds(timezone: string, now: DateTime = DateTime.now()) {
  const local = now.setZone(timezone);
  return {
    from: local.startOf('day').toUTC().toJSDate(),
    to: local.endOf('day').toUTC().toJSDate(),
  };
}

export async function dayDigest(clubId: string, timezone: string, now?: DateTime): Promise<DayDigest> {
  const { from, to } = clubDayBounds(timezone, now);

  /* Броні беремо разом із кортом одним запитом: рахувати найпопулярніший
     корт окремим groupBy означало б другий похід у базу заради даних, які
     вже приїхали. Днів по 40 броней — сортувати в памʼяті дешевше. */
  const bookings = await prisma.booking.findMany({
    where: {
      clubId,
      status: 'CONFIRMED',
      startTime: { gte: from, lte: to },
    },
    select: {
      priceTotal: true,
      court: { select: { name: true } },
    },
  });

  const perCourt = new Map<string, number>();
  let revenue = 0;

  for (const b of bookings) {
    revenue += b.priceTotal;
    const name = b.court?.name;
    if (name) perCourt.set(name, (perCourt.get(name) ?? 0) + 1);
  }

  let topCourt: DayDigest['topCourt'] = null;
  for (const [name, n] of perCourt) {
    if (!topCourt || n > topCourt.bookings) topCourt = { name, bookings: n };
  }

  /* «Нові» — ті, чия картка створена сьогодні, а не ті, хто сьогодні вперше
     прийшов. Це різні числа, і саме перше відповідає на питання «скільки
     людей у нас додалось»: картка заводиться при першій броні. */
  const newCustomers = await prisma.customer.count({
    where: { clubId, createdAt: { gte: from, lte: to } },
  });

  /* Виручка попереднього дня — заради одного рядка «↑ 12%». Саме по собі
     число «4 200 грн» не каже нічого: добрий це день чи поганий, видно
     тільки в порівнянні. Окремим запитом, бо це інша доба, а сума —
     єдине, що з неї потрібне. */
  const prev = clubDayBounds(timezone, (now ?? DateTime.now()).minus({ days: 1 }));
  const prevAgg = await prisma.booking.aggregate({
    where: {
      clubId,
      status: 'CONFIRMED',
      startTime: { gte: prev.from, lte: prev.to },
    },
    _sum: { priceTotal: true },
  });

  return {
    from,
    to,
    bookings: bookings.length,
    revenue,
    newCustomers,
    topCourt,
    prevRevenue: prevAgg._sum.priceTotal ?? 0,
  };
}

/** 45000 -> «450 грн» */
export const hrn = (kop: number) => `${(kop / 100).toLocaleString('uk-UA')} грн`;

/** Повні назви днів — у шапці зведення читається краще за «пн» */
export const WEEKDAY_FULL = [
  'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота', 'неділя',
];

/**
 * Шапка повідомлення.
 *
 * Назва клубу окремим рядком, дата — приглушено під нею. Один рядок із
 * усім разом читається як заголовок таблиці; два — як картка, а саме
 * карткою це й є.
 */
export const header = (clubName: string, sub: string) =>
  `🎾 <b>${telegramHtml(clubName)}</b>\n<i>${sub}</i>`;

/**
 * Підзаголовок періоду: «останні 4 тижні · 03.08 – 30.08».
 *
 * Довгі відрізки називаємо тижнями: саме так про них думають, а «останні
 * 28 днів» доводиться перераховувати в голові.
 */
export function periodSub(days: number, timezone: string, now: DateTime = DateTime.now()) {
  const end = now.setZone(timezone);
  const start = end.minus({ days: days - 1 });

  const period = days > 14 && days % 7 === 0
    ? `останні ${count(days / 7, WEEKS)}`
    : `останні ${count(days, DAYS)}`;

  return `${period} · ${start.toFormat('dd.MM')} – ${end.toFormat('dd.MM')}`;
}

/** Межі періоду в зоні клубу, як UTC-моменти для запиту */
export function periodBounds(days: number, timezone: string, now: DateTime = DateTime.now()) {
  const end = now.setZone(timezone).endOf('day');
  return {
    from: end.minus({ days: days - 1 }).startOf('day').toUTC().toJSDate(),
    to: end.toUTC().toJSDate(),
  };
}

/**
 * Текст зведення для Telegram. HTML — той самий parse_mode, що і в решті.
 *
 * Порядок рядків — за спаданням важливості: гроші, обсяг, люди, корти.
 * Власник дивиться на це повідомлення секунду, і перше число має бути
 * тим, заради якого він його відкрив.
 */
export function digestText(clubName: string, d: DayDigest, timezone: string): string {
  const local = DateTime.fromJSDate(d.from).setZone(timezone);
  const sub = `${WEEKDAY_FULL[local.weekday - 1]}, ${local.toFormat('dd.MM')}`;

  /* Порожній день — окреме речення, а не чотири нулі. Нулі читаються як
     «щось зламалось», фраза — як відповідь на питання. */
  if (d.bookings === 0) {
    return `${header(clubName, sub)}\n\nПідтверджених броней поки немає.`;
  }

  const change = d.prevRevenue === undefined ? null : trend(d.revenue, d.prevRevenue);

  return [
    header(clubName, sub),
    '',
    `💰 <b>${hrn(d.revenue)}</b>${change ? `  <i>${change} до попереднього дня</i>` : ''}`,
    `📋 ${count(d.bookings, BOOKINGS)}`,
    d.newCustomers > 0 ? `👤 ${count(d.newCustomers, CUSTOMERS)}` : '',
    d.topCourt
      ? `🏟 ${telegramHtml(d.topCourt.name)} — ${count(d.topCourt.bookings, BOOKINGS)}`
      : '',
  ].filter(Boolean).join('\n');
}

/* ── Тиждень ──────────────────────────────────────────────────────────────
   Зведення дня відповідає на «як минув сьогоднішній день». Тут інше
   питання: «як минув тиждень і чи кращий він за попередній» — і на нього
   одним числом не відповісти, потрібна форма кривої по днях.

   Окремо від analytics.ts свідомо, з тієї ж причини, що й dayDigest: там
   звіт для екрана з відсотками по кожному розрізу, тут — одне
   повідомлення в месенджер. */

export type DayPoint = {
  /** Локальна дата клубу, yyyy-MM-dd — ключ, а не те, що бачить людина */
  day: string;
  /** Підпис на графіку: «Пн 25.08» */
  label: string;
  revenue: number;
  bookings: number;
};

export type WeekReport = {
  points: DayPoint[];
  total: number;
  bookings: number;
  /** Виручка за попередній такий самий відрізок — для порівняння */
  prevTotal: number;
};

/** Скорочення днів тижня. Явною таблицею, а не через локаль luxon:
    набір локалей у Node залежить від збірки, і на Render легко отримати
    англійські «Mon» замість «Пн» без жодної помилки в логах. */
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];

/**
 * Виручка по днях за останні `days` днів, включно з сьогоднішнім.
 *
 * Один запит на подвійне вікно: другу половину віддаємо як prevTotal.
 * Два окремі запити коштували б два походи в базу заради одного числа.
 */
export async function weekReport(
  clubId: string,
  timezone: string,
  days = 7,
  now: DateTime = DateTime.now(),
): Promise<WeekReport> {
  const local = now.setZone(timezone);
  const endOfToday = local.endOf('day');
  const startOfWindow = local.minus({ days: days - 1 }).startOf('day');
  const startOfPrev = startOfWindow.minus({ days });

  const rows = await prisma.booking.findMany({
    where: {
      clubId,
      status: 'CONFIRMED',
      startTime: { gte: startOfPrev.toUTC().toJSDate(), lte: endOfToday.toUTC().toJSDate() },
    },
    select: { priceTotal: true, startTime: true },
  });

  /* Порожні дні мають лишитись у графіку нулями: тиждень із провалом у
     вівторок — це і є те, заради чого власник дивиться на форму кривої. */
  const points: DayPoint[] = [];
  const byDay = new Map<string, DayPoint>();

  for (let i = 0; i < days; i += 1) {
    const d = startOfWindow.plus({ days: i });
    const point: DayPoint = {
      day: d.toFormat('yyyy-MM-dd'),
      label: `${WEEKDAYS[d.weekday - 1]} ${d.toFormat('dd.MM')}`,
      revenue: 0,
      bookings: 0,
    };
    points.push(point);
    byDay.set(point.day, point);
  }

  let total = 0;
  let bookings = 0;
  let prevTotal = 0;

  for (const b of rows) {
    const day = DateTime.fromJSDate(b.startTime).setZone(timezone).toFormat('yyyy-MM-dd');
    const point = byDay.get(day);

    if (!point) {
      /* Не потрапило у вікно — значить, попередній відрізок. */
      prevTotal += b.priceTotal;
      continue;
    }

    point.revenue += b.priceTotal;
    point.bookings += 1;
    total += b.priceTotal;
    bookings += 1;
  }

  return { points, total, bookings, prevTotal };
}

/** 420000 -> «4 200» (без «грн» — на графіку одиниця написана в шапці) */
export const kopShort = (kop: number) => Math.round(kop / 100).toLocaleString('uk-UA');

/**
 * «↑ 12%» / «↓ 8%» / «без змін» / null, якщо порівнювати нема з чим.
 *
 * Стрілка, а не «+12%»: напрямок видно раніше, ніж прочитано число, і в
 * стрічці повідомлень це головне. Мінус тут теж справжній (−), а не
 * дефіс — інакше він губиться поруч із цифрами.
 */
export function trend(now: number, prev: number): string | null {
  if (prev <= 0) return null;
  const pct = Math.round(((now - prev) / prev) * 100);
  if (pct === 0) return 'без змін';
  return `${pct > 0 ? '↑' : '↓'} ${Math.abs(pct)}%`;
}

/**
 * Текст тижневого звіту з графіком.
 *
 * Графік у <pre>: у звичайному тексті Telegram малює пропорційний шрифт,
 * і стовпчики з'їжджають сходинкою — рівно те, заради чого графік і
 * будувався, зникає.
 */
export function weekText(clubName: string, r: WeekReport, days = 7): string {
  /* Проміжок пишемо і в порожньому випадку: без нього незрозуміло, за що
     саме «не було» — за тиждень чи за місяць. */
  const span = r.points.length
    ? `${shortDate(r.points[0].label)} – ${shortDate(r.points[r.points.length - 1].label)}`
    : '';
  /* Довгі періоди називаємо тижнями: «останні 4 тижні» — це те, як про
     них думають, а «останні 28 днів» доводиться перераховувати в голові. */
  const period = days > 14 && days % 7 === 0
    ? `останні ${count(days / 7, WEEKS)}`
    : `останні ${count(days, DAYS)}`;
  const sub = [period, span].filter(Boolean).join(' · ');

  if (r.bookings === 0) {
    return `${header(clubName, sub)}\n\nПідтверджених броней за цей час не було.`;
  }

  /* Місяць по днях — тридцять рядків, які гортають, а не читають. Згорнуті
     в тижні, ті самі дані відповідають на питання, з яким на них дивляться:
     росте чи падає. До двох тижнів залишаємо як є — там форма кривої по
     днях ще читається і саме вона цінна. */
  const bars = days > 14
    ? groupBars(
        r.points.map((p) => ({ label: p.label, value: p.revenue })),
        7,
        (chunk) => `${shortDate(chunk[0].label)}–${shortDate(chunk[chunk.length - 1].label)}`,
      )
    : r.points.map((p) => ({ label: p.label, value: p.revenue }));

  const chart = barChart(bars, { format: kopShort });

  const change = trend(r.total, r.prevTotal);
  /* Округлюємо до цілої гривні, а не до копійки: «4 228,57 грн у
     середньому за день» — це точність, якої в цьому числі немає. */
  const avg = Math.round(r.total / days / 100) * 100;

  /* Найкращий день варто назвати вголос: у стовпчиках він видно, але
     сказати, ЯКИЙ саме це був день, графік не вміє. */
  const best = r.points.reduce((a, b) => (b.revenue > a.revenue ? b : a), r.points[0]);

  return [
    header(clubName, sub),
    '',
    `<pre>${telegramHtml(chart)}</pre>`,
    `Разом <b>${hrn(r.total)}</b> · ${count(r.bookings, BOOKINGS)}`,
    `У середньому ${hrn(avg)} за день · найкращий ${best.label} (${hrn(best.revenue)})`,
    change ? `До попереднього періоду: <b>${change}</b>` : '',
  ].filter(Boolean).join('\n');
}

/** «Пн 24.08» -> «24.08». У згорнутому підписі день тижня зайвий. */
const shortDate = (label: string) => label.replace(/^\S+\s/, '');
