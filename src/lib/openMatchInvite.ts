import { DateTime } from 'luxon';

import { prisma } from './db';
import { planFeatures } from './plans';
import { sendMessage } from './telegram';
import { bookingDayUrl, dayLabel, html, timeRange } from './playerBot';
import {
  INVITE_LIMIT,
  bandLabel,
  rankCandidates,
  seatsLeft,
  type Candidate,
  type MatchContext,
  type Ranked,
} from './openMatch';

/**
 * Кого кликати у відкриту гру — і як це зробити, не перетворивши бота на спам.
 *
 * ── Звідки беруться звички ──────────────────────────────────────────────
 *
 * Не з опитувальника. Людина не заповнює «мої звичні години», а якби й
 * заповнила — збрехала б не зі зла: грає вона о 19:00, а любить уранці.
 * Тому звички рахуються з того, що людина справді робила: години й дні
 * тижня її минулих візитів за останні три місяці.
 *
 * ── Чому агрегація в пам'яті, а не в SQL ────────────────────────────────
 *
 * Потрібні гістограми по годинах і днях тижня В ЧАСОВОМУ ПОЯСІ КЛУБУ, а
 * далі ще й ваги підбору. Це або запит, у якому логіка фічі розмазана по
 * SQL і його не перевірити тестом, або два звичайні findMany і чиста
 * функція поруч. Обсяг тут клубний, а не глобальний: три місяці однієї
 * локації — тисячі рядків, і вони читаються раз на створення гри.
 *
 * ── Чому запрошення разові ──────────────────────────────────────────────
 *
 * Пишемо один раз, при створенні гри, і не нагадуємо. Нагадування про
 * чужу гру — це вже розсилка: її вимикають разом із бронями й
 * нагадуваннями про власний корт, і клуб втрачає канал цілком.
 */

/** Глибина історії, з якої читаються звички гравця. */
const HABIT_DAYS = 90;

/** Скільки разів треба зіграти в цю годину, щоб вона вважалась звичною. */
const HABIT_MIN = 2;

type Visit = { customerId: string; start: Date; noShow: boolean };

/**
 * Зводить візити в звички. Чиста функція: те, що вирішує, кого клуб
 * потурбує повідомленням, має перевірятись тестом, а не очима.
 */
export function buildCandidates(
  people: { id: string; name: string; skillLevel: Candidate['level'] }[],
  visits: Visit[],
  tz: string,
  now: Date,
): Candidate[] {
  const byCustomer = new Map<string, Visit[]>();
  for (const v of visits) {
    const list = byCustomer.get(v.customerId);
    if (list) list.push(v);
    else byCustomer.set(v.customerId, [v]);
  }

  return people.map((p) => {
    const mine = byCustomer.get(p.id) ?? [];
    const hours = new Map<number, number>();
    const weekdays = new Map<number, number>();
    let last: Date | null = null;

    for (const v of mine) {
      const local = DateTime.fromJSDate(v.start).setZone(tz);
      hours.set(local.hour, (hours.get(local.hour) ?? 0) + 1);
      /* Luxon рахує понеділок як 1, неділю як 7; решта коду — як 0. */
      const weekday = local.weekday % 7;
      weekdays.set(weekday, (weekdays.get(weekday) ?? 0) + 1);
      if (!last || v.start > last) last = v.start;
    }

    const often = (m: Map<number, number>) =>
      [...m.entries()].filter(([, n]) => n >= HABIT_MIN).map(([key]) => key);

    return {
      id: p.id,
      name: p.name,
      level: p.skillLevel,
      hours: often(hours),
      weekdays: often(weekdays),
      noShows: mine.filter((v) => v.noShow).length,
      visits: mine.length,
      lastVisitDays: last ? Math.floor((now.getTime() - last.getTime()) / 86_400_000) : null,
    };
  });
}

/**
 * Кандидати клубу з їхніми звичками. Беремо тільки тих, кому фізично є
 * куди написати: без привʼязаного Telegram запрошення нікуди не піде, а в
 * списку «кого покликали» такий рядок був би обіцянкою, якої не виконали.
 */
export async function candidatesOf(clubId: string, tz: string, now: Date, withChat = true): Promise<Candidate[]> {
  const since = new Date(now.getTime() - HABIT_DAYS * 86_400_000);

  const [people, bookings, seats] = await Promise.all([
    prisma.customer.findMany({
      where: { clubId, isBlocked: false, ...(withChat ? { telegramChatId: { not: null } } : {}) },
      select: { id: true, name: true, skillLevel: true },
    }),
    /* Приватні броні: тільки вони знають, чи людина дійшла до корту. */
    prisma.booking.findMany({
      where: {
        clubId,
        capacity: null,
        status: { in: ['CONFIRMED', 'PENDING'] },
        customerId: { not: null },
        startTime: { gte: since, lt: now },
      },
      select: { customerId: true, startTime: true, attendance: true },
    }),
    /* Місця в групових і у відкритих іграх — той самий візит, тільки
       відмітки присутності там немає: її ставлять на бронь корту. */
    prisma.bookingSeat.findMany({
      where: {
        status: 'BOOKED',
        customerId: { not: null },
        booking: { clubId, startTime: { gte: since, lt: now } },
      },
      select: { customerId: true, booking: { select: { startTime: true } } },
    }),
  ]);

  const visits: Visit[] = [
    ...bookings.map((b) => ({
      customerId: b.customerId!,
      start: b.startTime,
      noShow: b.attendance === 'NO_SHOW',
    })),
    ...seats.map((s) => ({ customerId: s.customerId!, start: s.booking.startTime, noShow: false })),
  ];

  return buildCandidates(people, visits, tz, now);
}

type Match = {
  id: string;
  clubId: string;
  title: string | null;
  startTime: Date;
  endTime: Date;
  capacity: number | null;
  pricePerSeat: number | null;
  levelMin: Candidate['level'];
  levelMax: Candidate['level'];
  court: { name: string };
  club: { slug: string; name: string; timezone: string; plan: Parameters<typeof planFeatures>[0] };
};

/**
 * Запросити гравців у щойно створену гру.
 *
 * Повертає тих, кого покликали, з причинами: кабінет показує цей список
 * одразу після створення, інакше «ми когось повідомили» доводиться брати
 * на віру.
 */
export async function inviteToMatch(match: Match, now: Date = new Date(), limit = INVITE_LIMIT): Promise<Ranked[]> {
  if (!match.capacity) return [];

  const local = DateTime.fromJSDate(match.startTime).setZone(match.club.timezone);
  const ctx: MatchContext = {
    levelMin: match.levelMin,
    levelMax: match.levelMax,
    hour: local.hour,
    weekday: local.weekday % 7,
    exclude: [],
  };

  const taken = await prisma.bookingSeat.count({
    where: { bookingId: match.id, status: { in: ['BOOKED', 'PENDING'] } },
  });
  const { free, full } = seatsLeft(match.capacity, taken);
  /* Гра вже зібралась, поки її створювали. Писати нема про що. */
  if (full) return [];

  /* Хто вже в грі — того не кличемо вдруге. */
  const inside = await prisma.bookingSeat.findMany({
    where: { bookingId: match.id, status: { in: ['BOOKED', 'PENDING'] }, customerId: { not: null } },
    select: { customerId: true },
  });
  ctx.exclude = inside.map((s) => s.customerId!);

  const candidates = await candidatesOf(match.clubId, match.club.timezone, now);
  const ranked = rankCandidates(candidates, ctx, limit);
  if (!ranked.length || !planFeatures(match.club.plan).telegram) return ranked;

  const chats = await prisma.customer.findMany({
    where: { id: { in: ranked.map((r) => r.id) } },
    select: { id: true, telegramChatId: true },
  });
  const chatOf = new Map(chats.map((c) => [c.id, c.telegramChatId]));

  for (const person of ranked) {
    const chatId = chatOf.get(person.id);
    if (!chatId) continue;
    /* Одне повідомлення, яке не дійшло, не має зривати решту запрошень. */
    await sendMessage(chatId, inviteText(match, free, now), inviteKeyboard(match)).catch((e) => {
      console.error('[open-match] запрошення не надіслане', match.id, person.id, e);
    });
  }

  return ranked;
}

/**
 * Те саме за id броні: зручний вхід для маршрутів, яким гра відома лише
 * ідентифікатором. Чужу або не-відкриту бронь не чіпає.
 */
export async function inviteMatch(bookingId: string, now: Date = new Date()): Promise<Ranked[]> {
  const match = await prisma.booking.findFirst({
    where: { id: bookingId, isOpenMatch: true, status: { in: ['PENDING', 'CONFIRMED'] } },
    select: {
      id: true, clubId: true, title: true, startTime: true, endTime: true,
      capacity: true, pricePerSeat: true, levelMin: true, levelMax: true,
      court: { select: { name: true } },
      club: { select: { slug: true, name: true, timezone: true, plan: true } },
    },
  });
  if (!match) return [];
  return inviteToMatch(match, now);
}

/** Текст запрошення: коли, який рівень, скільки місць і скільки коштує. */
export function inviteText(match: Match, free: number, now: Date = new Date()): string {
  const tz = match.club.timezone;
  const price = match.pricePerSeat ? `${Math.round(match.pricePerSeat / 100)} грн з гравця` : 'оплата на місці';
  return [
    '🎾 <b>Шукають партнерів на гру</b>',
    '',
    `<b>${dayLabel(match.startTime, tz, now)}, ${timeRange(match.startTime, match.endTime, tz)}</b>`,
    `${html(match.court.name)} · ${html(match.club.name)}`,
    '',
    `Рівень: ${html(bandLabel(match.levelMin, match.levelMax))}`,
    `Вільних місць: ${free} · ${html(price)}`,
    '',
    '<i>Ми пишемо тим, кому ця гра підходить за рівнем і звичним часом. Місце займає той, хто записався першим.</i>',
  ].join('\n');
}

function inviteKeyboard(match: Match) {
  const date = DateTime.fromJSDate(match.startTime).setZone(match.club.timezone).toFormat('yyyy-MM-dd');
  const url = bookingDayUrl(match.club.slug, date);
  if (!url) return undefined;
  return {
    inline_keyboard: [[
      url.startsWith('https://')
        ? { text: 'Приєднатись', web_app: { url } }
        : { text: 'Приєднатись', url },
    ]],
  };
}
