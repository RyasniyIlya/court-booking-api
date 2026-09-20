import { DateTime } from 'luxon';

import { prisma } from './db';
import { sendMessage } from './telegram';
import { bookingDayUrl, dayLabel, html, timeRange } from './playerBot';
import { bandLabel, fits, seatsLeft } from './openMatch';

/**
 * Підбір гри для гравця — у Telegram.
 *
 * ── Чому саме тут, а не у віджеті ───────────────────────────────────────
 *
 * Віджет відкривають, коли вже вирішили грати: там обирають годину й
 * платять. Пошук партнерів — інша історія: він починається з «а з ким?» і
 * тягнеться днями. Сидіти у вкладці й перевіряти, чи хтось зібрав гру на
 * твій рівень, ніхто не буде, а бот сам пише, коли така гра зʼявилась.
 * Тому у віджеті лишається кнопка, яка веде в чат, а сам підбір живе тут.
 *
 * ── Що бачить гравець ───────────────────────────────────────────────────
 *
 * Тільки те, куди він справді може піти: ігри його клубів, на його рівень
 * (сусідній рівень теж — див. fits), у майбутньому і з вільними місцями.
 * Гра, до якої не долізти, у списку гірша за порожній список: людина
 * тисне «Приєднатись» і впирається в «місць немає».
 *
 * ── Межа відповідальності ───────────────────────────────────────────────
 *
 * Бот показує і веде. Місце займається там само, де й завжди, — у віджеті,
 * бо там ціна, оплата й підтвердження. Другої реалізації запису в бота ми
 * не робимо: місць у грі одиниці, і розійтись двом гілкам коду тут
 * коштувало б проданого двічі стільця.
 */

/** Наскільки вперед дивимось. Далі за два тижні гру однаково перезберуть. */
const HORIZON_DAYS = 14;

/** Скільки ігор показуємо за раз: список у чаті гортають, а не вивчають. */
const LIMIT = 5;

type Match = {
  id: string;
  title: string | null;
  startTime: Date;
  endTime: Date;
  capacity: number;
  pricePerSeat: number | null;
  levelMin: Parameters<typeof fits>[0];
  levelMax: Parameters<typeof fits>[0];
  taken: number;
  courtName: string;
  clubName: string;
  clubSlug: string;
  timezone: string;
};

/**
 * Ігри, які підходять цьому чату. Чат може бути привʼязаний до карток у
 * кількох клубах — тоді показуємо ігри всіх, підписуючи клуб.
 */
export async function matchesForChat(chatId: string, now: Date = new Date()): Promise<Match[]> {
  const customers = await prisma.customer.findMany({
    where: { telegramChatId: chatId, isBlocked: false },
    select: { clubId: true, skillLevel: true },
  });
  if (customers.length === 0) return [];

  /* Рівень у кожного клубу свій: у себе вдома гравця знають як C+, у
     сусідньому клубі його картка може бути порожня. Беремо той, що
     заповнений у цьому клубі, а не «якийсь із». */
  const levelOf = new Map(customers.map((c) => [c.clubId, c.skillLevel]));

  const rows = await prisma.booking.findMany({
    where: {
      clubId: { in: [...levelOf.keys()] },
      isOpenMatch: true,
      status: { in: ['PENDING', 'CONFIRMED'] },
      startTime: { gt: now, lt: new Date(now.getTime() + HORIZON_DAYS * 86_400_000) },
    },
    select: {
      id: true, clubId: true, title: true, startTime: true, endTime: true,
      capacity: true, pricePerSeat: true, levelMin: true, levelMax: true,
      court: { select: { name: true } },
      club: { select: { name: true, slug: true, timezone: true } },
      seats: { where: { status: { in: ['BOOKED', 'PENDING'] } }, select: { id: true } },
    },
    orderBy: { startTime: 'asc' },
  });

  return rows
    .filter((b) => b.capacity !== null)
    .map((b) => ({
      id: b.id,
      title: b.title,
      startTime: b.startTime,
      endTime: b.endTime,
      capacity: b.capacity!,
      pricePerSeat: b.pricePerSeat,
      levelMin: b.levelMin,
      levelMax: b.levelMax,
      taken: b.seats.length,
      courtName: b.court.name,
      clubName: b.club.name,
      clubSlug: b.club.slug,
      timezone: b.club.timezone,
      clubId: b.clubId,
    }))
    /* Зібрана гра в списку гірша за порожній список: людина тисне
       «Приєднатись» і впирається в «місць немає». */
    .filter((m) => !seatsLeft(m.capacity, m.taken).full)
    .filter((m) => fits(levelOf.get(m.clubId) ?? null, { levelMin: m.levelMin, levelMax: m.levelMax }))
    .slice(0, LIMIT);
}

/** Одна гра в чаті: коли, де, який рівень, скільки ще треба і почому. */
export function matchText(m: Match, now: Date = new Date()): string {
  const { free } = seatsLeft(m.capacity, m.taken);
  const price = m.pricePerSeat ? `${Math.round(m.pricePerSeat / 100)} грн з гравця` : 'оплата на місці';
  return [
    `<b>${dayLabel(m.startTime, m.timezone, now)}, ${timeRange(m.startTime, m.endTime, m.timezone)}</b>`,
    `${html(m.courtName)} · ${html(m.clubName)}`,
    `Рівень: ${html(bandLabel(m.levelMin, m.levelMax))}`,
    `Шукають ще ${free} · ${html(price)}`,
  ].join('\n');
}

function joinKeyboard(m: Match) {
  const date = DateTime.fromJSDate(m.startTime).setZone(m.timezone).toFormat('yyyy-MM-dd');
  const url = bookingDayUrl(m.clubSlug, date);
  if (!url) return undefined;
  return {
    inline_keyboard: [[
      url.startsWith('https://')
        ? { text: 'Приєднатись', web_app: { url } }
        : { text: 'Приєднатись', url },
    ]],
  };
}

/**
 * Відповідь на «знайти гру». Кожна гра — окремим повідомленням зі своєю
 * кнопкою: одним списком на пʼять ігор кнопка була б одна, і незрозуміло,
 * до якої саме гри вона веде.
 */
export async function sendMatches(chatId: string, now: Date = new Date()): Promise<number> {
  const matches = await matchesForChat(chatId, now);

  if (matches.length === 0) {
    await sendMessage(
      chatId,
      [
        '🎾 <b>Поки що відкритих ігор на ваш рівень немає</b>',
        '',
        'Щойно хтось збере гру, куди ви підходите за рівнем і звичним часом, я напишу сам — перевіряти не треба.',
        '',
        '<i>Якщо рівень у картці клубу ще не вказаний, скажіть про нього на ресепшені: без нього підбір не знає, кого кликати.</i>',
      ].join('\n'),
    );
    return 0;
  }

  await sendMessage(chatId, `🎾 <b>Відкриті ігри на ваш рівень: ${matches.length}</b>`);
  for (const m of matches) {
    await sendMessage(chatId, matchText(m, now), joinKeyboard(m)).catch((e) => {
      console.error('[open-match] гра не показана', m.id, e);
    });
  }
  return matches.length;
}
