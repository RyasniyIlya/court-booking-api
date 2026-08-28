import { DateTime } from 'luxon';

import { prisma } from './db';

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
  for (const [name, count] of perCourt) {
    if (!topCourt || count > topCourt.bookings) topCourt = { name, bookings: count };
  }

  /* «Нові» — ті, чия картка створена сьогодні, а не ті, хто сьогодні вперше
     прийшов. Це різні числа, і саме перше відповідає на питання «скільки
     людей у нас додалось»: картка заводиться при першій броні. */
  const newCustomers = await prisma.customer.count({
    where: { clubId, createdAt: { gte: from, lte: to } },
  });

  return { from, to, bookings: bookings.length, revenue, newCustomers, topCourt };
}

/** 45000 -> «450 грн» */
export const hrn = (kop: number) => `${(kop / 100).toLocaleString('uk-UA')} грн`;

/** Текст зведення для Telegram. HTML — той самий parse_mode, що і в решті. */
export function digestText(clubName: string, d: DayDigest, timezone: string): string {
  const day = DateTime.fromJSDate(d.from).setZone(timezone).toFormat('dd.MM');

  if (d.bookings === 0) {
    return `<b>${clubName}</b> · ${day}\n\nСьогодні підтверджених броней ще немає.`;
  }

  return [
    `<b>${clubName}</b> · ${day}`,
    '',
    `Броней: <b>${d.bookings}</b>`,
    `Виручка: <b>${hrn(d.revenue)}</b>`,
    `Нових клієнтів: <b>${d.newCustomers}</b>`,
    d.topCourt
      ? `Найзавантаженіший: <b>${d.topCourt.name}</b> — ${d.topCourt.bookings}`
      : '',
  ].filter(Boolean).join('\n');
}
