import { DateTime } from 'luxon';

/**
 * Підсумок гравця для його ж кабінету у віджеті.
 *
 * Це не аналітика клубу — це те, що людина бачить про себе: скільки разів
 * прийшла, на якому корті грає найчастіше, з ким тренується і скільки
 * тижнів поспіль не пропускає. Клуб цих чисел не потребує, гравцю ж вони
 * дають привід повернутись — а серія тижнів ще й привід не зривати її.
 *
 * Рахується з двох джерел, як і решта статистики про відвідування: бронь
 * корту й місце в груповому занятті для гравця однаково «я приходив».
 */

export type PlayerVisit = {
  /** Початок заняття, UTC */
  start: Date;
  courtName: string | null;
  trainerName: string | null;
};

export type PlayerStats = {
  visits: number;
  favouriteCourt: { name: string; times: number } | null;
  favouriteTrainer: { name: string; times: number } | null;
  /** Скільки тижнів поспіль гравець приходив хоча б раз */
  streakWeeks: number;
  firstVisit: string | null;
  lastVisit: string | null;
};

/** Найчастіше значення й скільки разів воно траплялось. */
function topOf(values: (string | null)[]): { name: string; times: number } | null {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: { name: string; times: number } | null = null;
  for (const [name, times] of counts) {
    /* При рівності виграє той, хто трапився раніше за алфавітом — аби
       «улюблений корт» не стрибав між двома рівними від запиту до запиту.
       Довільний, зате стабільний порядок краще за випадковий. */
    if (!best || times > best.times || (times === best.times && name < best.name)) {
      best = { name, times };
    }
  }
  return best;
}

/**
 * Скільки тижнів поспіль гравець приходив.
 *
 * Тиждень береться в таймзоні КЛУБУ: гравець із Варшави, що грає в Києві,
 * не має втрачати серію через годину різниці.
 *
 * Поточний тиждень, у якому ще не було візиту, серію НЕ обриває — інакше
 * кожного понеділка вранці людина бачила б нуль замість своїх пʼяти
 * тижнів і сприймала б це як покарання за те, що тиждень щойно почався.
 * Обрив рахується від минулого тижня.
 */
export function streakWeeks(visits: PlayerVisit[], tz: string, now = new Date()): number {
  if (visits.length === 0) return 0;

  const weekKey = (d: Date) => DateTime.fromJSDate(d).setZone(tz).startOf('week').toISODate()!;
  const seen = new Set(visits.map((v) => weekKey(v.start)));

  const thisWeek = DateTime.fromJSDate(now).setZone(tz).startOf('week');

  // З якого тижня рахувати: з поточного, якщо в ньому вже були
  let cursor = seen.has(thisWeek.toISODate()!) ? thisWeek : thisWeek.minus({ weeks: 1 });

  let n = 0;
  while (seen.has(cursor.toISODate()!)) {
    n += 1;
    cursor = cursor.minus({ weeks: 1 });
  }
  return n;
}

export function playerStats(visits: PlayerVisit[], tz: string, now = new Date()): PlayerStats {
  const past = visits
    .filter((v) => v.start.getTime() <= now.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  return {
    visits: past.length,
    favouriteCourt: topOf(past.map((v) => v.courtName)),
    favouriteTrainer: topOf(past.map((v) => v.trainerName)),
    streakWeeks: streakWeeks(past, tz, now),
    firstVisit: past[0]?.start.toISOString() ?? null,
    lastVisit: past.at(-1)?.start.toISOString() ?? null,
  };
}
