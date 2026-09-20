import { DateTime } from 'luxon';
import { prisma } from './db';
import { dateOnly, daysUntilBirthday } from './birthday';
import type { CellValue, SheetSpec } from './xlsx';

/**
 * Картотека клієнтів клубу: один збирач для екрана і для вивантаження.
 *
 * ── Чому спільний модуль, а не ще один запит у роуті ─────────────────────
 *
 * Екран «Клієнти» і файл, який клуб завантажує, мусять показувати те саме.
 * Доки це були два незалежні запити, будь-яка зміна правил (що рахується
 * візитом, хто потрапив у «згасає») розʼїжджалась між ними мовчки: на
 * екрані 340 активних, у файлі 317, і клуб не знає, котре число правда.
 *
 * ── Про розмежування клубів ──────────────────────────────────────────────
 *
 * База клієнтів одна на всю платформу, розділення — на рівні запиту:
 * `clubId` тут обовʼязковий аргумент, а не опція. Того ж вимагає схема —
 * `Customer.clubId` та `@@unique([clubId, phone])`: одна людина у двох
 * клубах це дві картки, і бачити чужу жоден клуб не може.
 *
 * Найтонше місце — місця в групових заняттях: у BookingSeat свого clubId
 * немає, він тільки в броні-контейнері. Тому фільтр іде через
 * `booking.clubId`, і послабити його не можна ніколи: без нього відвідування
 * чужого клубу дописались би в картку нашого.
 */

/**
 * Межі сегментів у днях від останнього відвідування.
 *
 * Не налаштування клубу — свідомо. Три сегменти мають означати те саме в
 * усіх клубах, інакше «згасає» в одному дорівнює «активний» в іншому, і
 * будь-яка розмова про цифри між нами й клубом розсипається.
 */
export const TIER_ACTIVE_DAYS = 30;
export const TIER_FADING_DAYS = 90;

/**
 * Скільки перших відвідувань людина ще вважається новачком.
 *
 * Пʼять занять — це приблизно місяць-півтора занять раз на тиждень, рівно
 * той строк, за який людина або стає постійною, або зникає.
 */
export const TIER_NEW_VISITS = 5;

export type CustomerTier = 'ACTIVE' | 'FADING' | 'LOST' | 'NEW';

/**
 * До якого сегмента належить клієнт.
 *
 * NEW окремо від LOST: людина, яка записалась учора, і людина, яка зникла
 * пів року тому, — це різні розмови. Перших зустрічають, других повертають.
 *
 * ── Чому новачок живе всередині «ходить», а не поруч ─────────────────────
 *
 * Спочатку рахуємо, чи людина взагалі ходить, і лише потім — чи вона ще
 * новачок. Тобто той, у кого три візити, але останній був три місяці тому,
 * це FADING, а не NEW.
 *
 * Інакше сегменти почали б брехати саме там, де вони найпотрібніші:
 * новачок, який сходив двічі й пропав, — це найважливіший дзвінок у всій
 * картотеці, а лишившись у «новачках» він виглядав би як людина, яку
 * просто ще не встигли зустріти.
 */
export function tierOf(
  lastVisit: Date | null,
  firstSeen: Date,
  now: Date,
  visits = 0,
): CustomerTier {
  if (!lastVisit) {
    const daysKnown = (now.getTime() - firstSeen.getTime()) / 86_400_000;
    return daysKnown <= TIER_ACTIVE_DAYS ? 'NEW' : 'LOST';
  }
  const days = (now.getTime() - lastVisit.getTime()) / 86_400_000;
  if (days > TIER_FADING_DAYS) return 'LOST';
  if (days > TIER_ACTIVE_DAYS) return 'FADING';
  return visits <= TIER_NEW_VISITS ? 'NEW' : 'ACTIVE';
}

/**
 * Сегмент людською мовою — і що з ним робити.
 *
 * Пояснення лежить поруч із назвою, а не в довідці збоку: у файлі, який
 * клуб відкриє через місяць, довідки не буде, а колонка «Сегмент» зі
 * словом «FADING» без неї не означає нічого.
 */
export const TIER_LABELS: Record<CustomerTier, { name: string; meaning: string }> = {
  NEW: {
    name: 'Новачок',
    meaning: `Ходить, але ще не більше ${TIER_NEW_VISITS} разів. Вирішує, лишатися чи ні — познайомтесь.`,
  },
  ACTIVE: {
    name: 'Постійний',
    meaning: `Був за останні ${TIER_ACTIVE_DAYS} днів і сходив більше ${TIER_NEW_VISITS} разів. Основа виручки.`,
  },
  FADING: {
    name: 'Згасає',
    meaning: `Останній візит ${TIER_ACTIVE_DAYS}–${TIER_FADING_DAYS} днів тому. Найкращий момент для дзвінка.`,
  },
  LOST: {
    name: 'Втрачений',
    meaning: `Не був понад ${TIER_FADING_DAYS} днів або не приходив жодного разу. Повернення коштує дорожче.`,
  },
};

export type RosterRow = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  note: string | null;
  tags: string[];
  isBlocked: boolean;
  requiresPrepay: boolean;
  hasCabinet: boolean;
  birthDate: string | null;
  daysUntilBirthday: number | null;
  discountPercent: number;
  bonusBalance: number;
  since: string;
  visits: number;
  spend: number;
  lastVisit: string | null;
  tier: CustomerTier;
};

export type RosterFilter = {
  tier?: CustomerTier;
  tag?: string;
  q?: string;
};

/**
 * Умова пошуку для Prisma.
 *
 * По хвосту телефона шукаємо тільки коли в запиті є цифри. Спершу тут при
 * пошуку по літерах у OR підставлялось значення, яке «свідомо не
 * збігається» — і Postgres відхиляв ВЕСЬ запит (22021: нульовий байт не є
 * валідним UTF8), тобто пошук по імені не працював зовсім. Тепер умову
 * просто не додаємо, замість вигадування значення, що не може збігтися.
 */
export function searchCondition(q?: string) {
  if (!q) return null;
  const digits = q.replace(/[^0-9]/g, '').slice(-7);
  return [
    { name: { contains: q, mode: 'insensitive' as const } },
    { email: { contains: q, mode: 'insensitive' as const } },
    ...(digits.length >= 3 ? [{ phoneTail: { endsWith: digits } }] : []),
  ];
}

/**
 * Зібрати картотеку клубу.
 *
 * `tier` тут НЕ фільтрує: сегмент рахується після запиту, і клуб має
 * бачити підсумок по всіх сегментах, навіть коли дивиться на один. Фільтр
 * накладає викликач — разом із сортуванням, яке в екрана й файла різне.
 */
export async function loadRoster(
  clubId: string,
  filter: RosterFilter,
  now: Date,
): Promise<RosterRow[]> {
  const search = searchCondition(filter.q);

  const customers = await prisma.customer.findMany({
    where: {
      clubId,
      ...(filter.tag ? { tags: { has: filter.tag } } : {}),
      ...(search ? { OR: search } : {}),
    },
    select: {
      id: true, name: true, phone: true, note: true, tags: true, email: true,
      isBlocked: true, requiresPrepay: true, createdAt: true, telegramChatId: true,
      birthDate: true, discountPercent: true, bonusBalance: true,
      /* Рівень гри: у списку він потрібен, щоб адміністратор бачив, у кого
         його ще не спитали — без рівня людина не потрапляє в підбір. */
      skillLevel: true,
    },
  });
  if (customers.length === 0) return [];

  const ids = customers.map((c) => c.id);

  /* Два джерела відвідувань. Скасовані не рахуються в жодному: людина
     записалась і не прийшла — це не візит, і в статистику лояльності
     він потрапляти не має. */
  const [bookings, seats] = await Promise.all([
    prisma.booking.findMany({
      where: {
        clubId,
        customerId: { in: ids },
        status: 'CONFIRMED',
        startTime: { lte: now },
      },
      select: { customerId: true, priceTotal: true, startTime: true },
    }),
    prisma.bookingSeat.findMany({
      where: {
        customerId: { in: ids },
        status: 'BOOKED',
        /* clubId саме тут, через контейнер: у місця свого немає. */
        booking: { clubId, status: 'CONFIRMED', startTime: { lte: now } },
      },
      select: { customerId: true, price: true, booking: { select: { startTime: true } } },
    }),
  ]);

  type Stat = { visits: number; spend: number; last: Date | null };
  const stats = new Map<string, Stat>();
  const bump = (id: string, when: Date, money: number) => {
    const r = stats.get(id) ?? { visits: 0, spend: 0, last: null };
    r.visits += 1;
    r.spend += money;
    if (!r.last || when > r.last) r.last = when;
    stats.set(id, r);
  };

  for (const b of bookings) bump(b.customerId!, b.startTime, b.priceTotal);
  for (const s of seats) bump(s.customerId!, s.booking.startTime, s.price);

  return customers.map((c) => {
    const r = stats.get(c.id) ?? { visits: 0, spend: 0, last: null };
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      note: c.note,
      tags: c.tags,
      isBlocked: c.isBlocked,
      requiresPrepay: c.requiresPrepay,
      hasCabinet: Boolean(c.birthDate),
      birthDate: dateOnly(c.birthDate),
      daysUntilBirthday: daysUntilBirthday(c.birthDate, now),
      discountPercent: c.discountPercent,
      bonusBalance: c.bonusBalance,
      since: c.createdAt.toISOString(),
      visits: r.visits,
      spend: r.spend,
      lastVisit: r.last?.toISOString() ?? null,
      tier: tierOf(r.last, c.createdAt, now, r.visits),
    };
  });
}

/** Скільки людей у кожному сегменті. Рахується до будь-яких фільтрів. */
export function tierCounts(rows: RosterRow[]): Record<CustomerTier, number> {
  const counts: Record<CustomerTier, number> = { NEW: 0, ACTIVE: 0, FADING: 0, LOST: 0 };
  for (const row of rows) counts[row.tier] += 1;
  return counts;
}

/* ── Колонки вивантаження ─────────────────────────────────────────────── */

/**
 * Опис однієї колонки файла.
 *
 * Колонки описані даними, а не двома незалежними списками (шапка окремо,
 * значення окремо). Так неможливо додати заголовок і забути значення —
 * найчастіша помилка у вивантаженнях, після якої телефони опиняються під
 * шапкою «Email».
 */
type Column = {
  header: string;
  width: number;
  /** Для xlsx: типізоване значення, щоб Excel умів сортувати й сумувати. */
  cell: (row: RosterRow) => CellValue;
  /** Для CSV: усе рядком, бо типів там немає. */
  text?: (row: RosterRow) => string;
};

const money = (kopecks: number) => Math.round(kopecks) / 100;

/** ISO -> Date у таймзоні клубу, зведена до півночі: у файлі потрібна дата. */
function localDate(iso: string | null, tz: string): Date | null {
  if (!iso) return null;
  const local = DateTime.fromISO(iso, { zone: tz });
  if (!local.isValid) return null;
  /* Беремо календарну дату клубу і кладемо її як UTC-північ: Excel читає
     серійне число без таймзони, тож інакше заняття о 22:00 у Києві стало б
     учорашнім днем у файлі. */
  return new Date(Date.UTC(local.year, local.month - 1, local.day));
}

/** Скільки днів минуло від візиту — головне число для обдзвону. */
function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
}

export function rosterColumns(tz: string, now: Date): Column[] {
  return [
    { header: 'Імʼя', width: 26, cell: (r) => r.name },
    /* Телефон рядком навіть у xlsx: як число «+380671234567» втрачає плюс
       і стає 380671234567 у експоненційній формі. */
    { header: 'Телефон', width: 18, cell: (r) => r.phone },
    { header: 'Email', width: 26, cell: (r) => r.email ?? '' },
    { header: 'Сегмент', width: 14, cell: (r) => TIER_LABELS[r.tier].name },
    { header: 'Візитів', width: 10, cell: (r) => r.visits },
    { header: 'Витратив, грн', width: 15, cell: (r) => money(r.spend) },
    {
      header: 'Середній чек, грн',
      width: 18,
      cell: (r) => (r.visits ? money(Math.round(r.spend / r.visits)) : ''),
    },
    { header: 'Останній візит', width: 15, cell: (r) => localDate(r.lastVisit, tz) },
    { header: 'Днів без візиту', width: 16, cell: (r) => daysSince(r.lastVisit, now) ?? '' },
    { header: 'У базі з', width: 13, cell: (r) => localDate(r.since, tz) },
    { header: 'День народження', width: 17, cell: (r) => localDate(r.birthDate, tz) },
    { header: 'Днів до дня народження', width: 23, cell: (r) => r.daysUntilBirthday ?? '' },
    { header: 'Знижка, %', width: 11, cell: (r) => r.discountPercent },
    { header: 'Бонуси, грн', width: 13, cell: (r) => money(r.bonusBalance) },
    {
      header: 'Мітки',
      width: 28,
      cell: (r) => r.tags.join(', '),
    },
    { header: 'Заблокований', width: 14, cell: (r) => (r.isBlocked ? 'так' : '') },
    { header: 'Лише передоплата', width: 18, cell: (r) => (r.requiresPrepay ? 'так' : '') },
    { header: 'Нотатка', width: 40, cell: (r) => r.note ?? '' },
  ];
}

/** Дата для людини у назві файла й шапці звіту. */
function stamp(now: Date, tz: string): string {
  return DateTime.fromJSDate(now).setZone(tz).toFormat('yyyy-LL-dd');
}

export type ExportMeta = {
  clubName: string;
  timezone: string;
  now: Date;
  filter: RosterFilter;
};

/**
 * Книга Excel: картотека плюс аркуш «Як читати».
 *
 * Другий аркуш не формальність. Файл живе довше за вкладку браузера: його
 * пересилають бухгалтеру, відкривають через пів року, віддають новому
 * адміністратору. Без пояснень «Сегмент: Згасає» і «Витратив» у ньому
 * означають що завгодно, і клуб дзвонить не тим людям.
 */
export function rosterWorkbookSheets(rows: RosterRow[], meta: ExportMeta): SheetSpec[] {
  const columns = rosterColumns(meta.timezone, meta.now);
  const counts = tierCounts(rows);
  const spend = rows.reduce((sum, r) => sum + r.spend, 0);
  const visits = rows.reduce((sum, r) => sum + r.visits, 0);

  const filters: string[] = [];
  if (meta.filter.tier) filters.push(`сегмент: ${TIER_LABELS[meta.filter.tier].name}`);
  if (meta.filter.tag) filters.push(`мітка: ${meta.filter.tag}`);
  if (meta.filter.q) filters.push(`пошук: ${meta.filter.q}`);

  const guide: CellValue[][] = [
    ['Клуб', meta.clubName],
    ['Вивантажено', stamp(meta.now, meta.timezone)],
    ['Часовий пояс дат у файлі', meta.timezone],
    ['Відбір', filters.length ? filters.join('; ') : 'уся картотека клубу'],
    ['Карток у файлі', rows.length],
    [],
    ['Сегмент', 'Карток', 'Що це означає'],
    ...(['ACTIVE', 'NEW', 'FADING', 'LOST'] as const).map((tier) => [
      TIER_LABELS[tier].name,
      counts[tier],
      TIER_LABELS[tier].meaning,
    ]),
    [],
    ['Разом візитів', visits],
    ['Разом витрачено, грн', money(spend)],
    [],
    ['Як це пораховано', ''],
    ['Візит', 'Підтверджений запис, початок якого вже минув. Місця в групових заняттях рахуються нарівні з бронями корту.'],
    ['Витратив', 'Ціна цих самих записів. Це не каса й не банківська виписка: оплата готівкою тут не підтверджується.'],
    ['Останній візит', 'Дата найпізнішого такого запису. Порожньо — людина ще не була жодного разу.'],
    ['Днів без візиту', 'Скільки днів минуло від останнього візиту на момент вивантаження.'],
    ['Скасовані записи', 'Не рахуються ніде: записався і не прийшов — це не візит.'],
    [],
    ['Персональні дані', 'Файл містить телефони й email клієнтів вашого клубу. Зберігайте його як персональні дані: не пересилайте відкритими каналами і не лишайте на спільному комп’ютері.'],
  ];

  return [
    {
      name: 'Картотека',
      headers: columns.map((c) => c.header),
      widths: columns.map((c) => c.width),
      rows: rows.map((row) => columns.map((c) => c.cell(row))),
    },
    {
      name: 'Як читати',
      headers: ['Показник', 'Значення', 'Пояснення'],
      widths: [30, 22, 90],
      rows: guide,
    },
  ];
}

/* ── CSV ──────────────────────────────────────────────────────────────── */

/** Excel в українській локалі читає CSV із роздільником зі своїх налаштувань. */
const SEP = ';';

/**
 * Значення -> клітинка CSV.
 *
 * Провідний '=', '+', '-' чи '@' Excel вважає формулою — для телефонів на
 * кшталт +380… це означає #NAME? замість номера, а в гіршому випадку
 * виконання чужого виразу з нотатки. Лапки цього не рятують, тому такі
 * значення отримують апостроф.
 */
export function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /["\n\r;,]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Картотека в CSV.
 *
 * Той самий набір колонок, що й у книзі, але без другого аркуша: у CSV
 * аркушів немає, а домішувати пояснення в ті самі рядки — зіпсувати файл
 * рівно там, де його збираються рахувати. Пояснення лишаються в xlsx.
 */
export function rosterCsv(rows: RosterRow[], meta: ExportMeta): string {
  const columns = rosterColumns(meta.timezone, meta.now);
  const fmt = (value: CellValue): string => {
    if (value instanceof Date) return DateTime.fromJSDate(value, { zone: 'utc' }).toFormat('dd.LL.yyyy');
    if (value == null) return '';
    return String(value);
  };
  const body = [
    columns.map((c) => c.header),
    ...rows.map((row) => columns.map((c) => fmt(c.cell(row)))),
  ];
  /* BOM: без нього Excel відкриває кирилицю кракозябрами — він не вгадує
     UTF-8, а бере системну кодову сторінку. */
  return '﻿' + body.map((row) => row.map(csvCell).join(SEP)).join('\r\n');
}

/** Назва файла: клуб, відбір і дата — щоб три вивантаження не злиплися. */
export function rosterFileName(meta: ExportMeta, extension: 'csv' | 'xlsx'): string {
  const slug = (text: string) =>
    text.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40);
  const parts = ['клієнти', slug(meta.clubName)];
  if (meta.filter.tier) parts.push(slug(TIER_LABELS[meta.filter.tier].name));
  if (meta.filter.tag) parts.push(slug(meta.filter.tag));
  parts.push(stamp(meta.now, meta.timezone));
  return `${parts.filter(Boolean).join('-')}.${extension}`;
}
