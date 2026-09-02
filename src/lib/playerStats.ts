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
 *
 * ── Лічильники для досягнень ─────────────────────────────────────────────
 * Друга половина полів існує заради вкладки «Досягнення» у віджеті:
 * скільки занять було з тренером, скільки в групі, скільки до дев'ятої
 * ранку. Рахуються тут, а не на фронті, з тієї самої причини, що й серія
 * тижнів: «ранок» і «вихідний» визначаються в таймзоні КЛУБУ, а браузер
 * гравця може стояти в іншій. Фронт із тими самими даними отримав би
 * «суботнє» заняття в п'ятницю.
 */

export type PlayerVisit = {
  /** Початок заняття, UTC */
  start: Date;
  /** Кінець заняття, UTC. null — рахуємо годину: історія до появи поля */
  end?: Date | null;
  courtName: string | null;
  trainerName: string | null;
  /** 'group' — місце в чужому груповому занятті, 'court' — власна бронь */
  kind?: 'court' | 'group';
  /** Скільки коштувало саме це заняття, копійки */
  price?: number;
};

export type PlayerStats = {
  visits: number;
  favouriteCourt: { name: string; times: number } | null;
  favouriteTrainer: { name: string; times: number } | null;
  /** Скільки тижнів поспіль гравець приходив хоча б раз */
  streakWeeks: number;
  /** Найдовша серія за всю історію — її вже не втратити, і це навмисно */
  bestStreakWeeks: number;
  firstVisit: string | null;
  lastVisit: string | null;

  /** Годин на корті всього, з одним знаком після коми */
  hours: number;
  /** Занять із тренером */
  withTrainer: number;
  /** Групових занять (місце в чужій броні) */
  groupVisits: number;
  /** Різних кортів, на яких грав */
  courts: number;
  /** Різних тренерів, з якими займався */
  trainers: number;
  /** Занять, що починались до 9:00 за часом клубу */
  earlyVisits: number;
  /** Занять, що починались о 21:00 і пізніше */
  lateVisits: number;
  /** Занять у суботу або неділю */
  weekendVisits: number;

  /**
   * Скільки гравець залишив у клубі, копійки.
   *
   * У відповідь гравцю НЕ їде: у профіль винесено рівень, а не бухгалтерія
   * («скільки ти нам заніс» тішить далеко не кожного). Число потрібне
   * рівню — див. playerLevel.ts — і лишається на сервері.
   */
  spent: number;
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

/** Скільки різних непорожніх значень трапилось */
function uniqueOf(values: (string | null)[]): number {
  return new Set(values.filter((v): v is string => Boolean(v))).size;
}

/**
 * Тривалість заняття в годинах.
 *
 * Без endTime — рівно година. Такого в базі бути не повинно (поле
 * обов'язкове), але підсумок гравця не та річ, заради якої варто впасти
 * на одному кривому рядку історії.
 */
function hoursOf(v: PlayerVisit): number {
  if (!v.end) return 1;
  const ms = v.end.getTime() - v.start.getTime();
  return ms > 0 ? ms / 3_600_000 : 0;
}

/** Тижні (у таймзоні клубу), у які гравець хоч раз приходив */
function weekKeys(visits: PlayerVisit[], tz: string): Set<string> {
  return new Set(
    visits.map((v) => DateTime.fromJSDate(v.start).setZone(tz).startOf('week').toISODate()!),
  );
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

  const seen = weekKeys(visits, tz);
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

/**
 * Найдовша серія тижнів за всю історію.
 *
 * Поточна серія обривається пропущеним тижнем і починається з нуля — а
 * досягнення «місяць поспіль», одного разу зароблене, забирати назад не
 * можна. Тому рекорд рахується окремо й тільки росте.
 */
export function bestStreakWeeks(visits: PlayerVisit[], tz: string): number {
  if (visits.length === 0) return 0;

  const weeks = [...weekKeys(visits, tz)]
    .map((iso) => DateTime.fromISO(iso, { zone: tz }))
    .sort((a, b) => a.toMillis() - b.toMillis());

  let best = 1;
  let run = 1;
  for (let i = 1; i < weeks.length; i += 1) {
    const gap = weeks[i].diff(weeks[i - 1], 'weeks').weeks;
    run = Math.round(gap) === 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

export function playerStats(visits: PlayerVisit[], tz: string, now = new Date()): PlayerStats {
  const past = visits
    .filter((v) => v.start.getTime() <= now.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const local = past.map((v) => DateTime.fromJSDate(v.start).setZone(tz));

  return {
    visits: past.length,
    favouriteCourt: topOf(past.map((v) => v.courtName)),
    favouriteTrainer: topOf(past.map((v) => v.trainerName)),
    streakWeeks: streakWeeks(past, tz, now),
    bestStreakWeeks: bestStreakWeeks(past, tz),
    firstVisit: past[0]?.start.toISOString() ?? null,
    lastVisit: past.at(-1)?.start.toISOString() ?? null,

    /* Округлення до десятої: «12,5 години» читається, «12.4999999» — ні. */
    hours: Math.round(past.reduce((sum, v) => sum + hoursOf(v), 0) * 10) / 10,
    withTrainer: past.filter((v) => Boolean(v.trainerName)).length,
    groupVisits: past.filter((v) => v.kind === 'group').length,
    courts: uniqueOf(past.map((v) => v.courtName)),
    trainers: uniqueOf(past.map((v) => v.trainerName)),
    earlyVisits: local.filter((d) => d.hour < 9).length,
    lateVisits: local.filter((d) => d.hour >= 21).length,
    weekendVisits: local.filter((d) => d.weekday >= 6).length,
    spent: past.reduce((sum, v) => sum + (v.price ?? 0), 0),
  };
}
