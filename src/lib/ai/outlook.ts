import { DateTime } from 'luxon';

import { prisma } from '../db';

/**
 * Броні наперед проти звичайного — окремим модулем, щоб і ownerAssistant,
 * і ownerContext (знімок клубу) брали його без циклічного імпорту.
 */

const uah = (kop: number) => Math.round(kop / 100);

/* Явна таблиця, а не локаль luxon: на Render набір локалей залежить від
   збірки, і замість «чт» легко отримати «Thu» без жодної помилки (та сама
   обережність, що в digest.ts і ownerContext.ts). */
const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд'];

export type OwnerClub = { id: string; name: string; timezone: string; address: string | null };

/**
 * Броні наперед проти звичайного для цього дня тижня.
 *
 * Сама цифра «на суботу 14 броней» нічого не каже. Порівняння з середнім
 * за 8 тижнів каже, чи це аншлаг, чи діра, — і саме з такої різниці
 * складаються припущення й поради («у четвер на 40% порожніше, ніж
 * зазвичай, — час для акції»).
 */
export async function bookingOutlook(club: OwnerClub, days: number, now = DateTime.now().setZone(club.timezone)) {
  const today = now.startOf('day');
  const historyFrom = today.minus({ days: 56 });
  const to = today.plus({ days });

  const rows = await prisma.booking.findMany({
    where: {
      clubId: club.id,
      status: { in: ['CONFIRMED', 'PENDING'] },
      startTime: { gte: historyFrom.toUTC().toJSDate(), lt: to.toUTC().toJSDate() },
    },
    select: { startTime: true, priceTotal: true, status: true },
  });

  const perDay = new Map<string, { count: number; revenue: number }>();
  for (const r of rows) {
    const key = DateTime.fromJSDate(r.startTime).setZone(club.timezone).toFormat('yyyy-MM-dd');
    const cur = perDay.get(key) ?? { count: 0, revenue: 0 };
    cur.count += 1;
    cur.revenue += r.priceTotal;
    perDay.set(key, cur);
  }

  /* Норма по дню тижня: середнє за 8 останніх настань цього дня тижня,
     строго до сьогодні. Ділимо на 8, а не на кількість днів із бронями —
     порожній день теж дані, інакше норма завжди завищена.

     Раніше рахували `today.minus({weeks: w}).set({weekday: wd})`: для дня
     тижня, що йде в ISO-тижні раніше за сьогоднішній, восьме таке настання
     випадало ДО historyFrom і мовчки бралось за 0 (бо рядок не потрапляв у
     вибірку), хоча сума все одно ділилась на 8 — норма для понеділка й
     вівторка систематично занижувалась майже на 12%. */
  const norm = new Map<number, number>();
  for (let wd = 1; wd <= 7; wd++) {
    const daysSinceLast = ((today.weekday - wd + 7) % 7) || 7;
    let sum = 0;
    for (let n = 0; n < 8; n++) {
      const d = today.minus({ days: daysSinceLast + 7 * n });
      sum += perDay.get(d.toFormat('yyyy-MM-dd'))?.count ?? 0;
    }
    norm.set(wd, sum / 8);
  }

  const out = [];
  for (let i = 0; i < days; i++) {
    const d = today.plus({ days: i });
    const key = d.toFormat('yyyy-MM-dd');
    const cur = perDay.get(key) ?? { count: 0, revenue: 0 };
    const usual = norm.get(d.weekday) ?? 0;
    out.push({
      date: key,
      weekday: WEEKDAYS[d.weekday - 1],
      booked: cur.count,
      revenue_booked_uah: uah(cur.revenue),
      usual_for_weekday: Math.round(usual * 10) / 10,
    });
  }
  return out;
}
