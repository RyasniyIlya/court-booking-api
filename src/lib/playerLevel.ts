/**
 * Внутрішній рівень гравця в клубі.
 *
 * Рахується з трьох речей: скільки разів приходив, скільки годин провів
 * на корті і скільки за це заплатив. Гроші в підсумок входять, але
 * назовні числом не їдуть — гравцю показується рівень, а не рахунок.
 *
 * ── Чому місце в клубі, а не абсолютні пороги ────────────────────────────
 * «50 годин = Легенда» звучить чесно рівно до другого клубу. Там година
 * коштує вдвічі дорожче, ходять двічі на тиждень замість чотирьох, і той
 * самий поріг або недосяжний, або береться за місяць. Рівень має щось
 * означати всередині СВОГО клубу, тому кожна з трьох величин міряється
 * не в годинах і не в гривнях, а в частці гравців клубу, яких людина
 * випереджає. Це робить шкалу однаковою для тенісного корту в Києві й
 * для залу на три столи в райцентрі.
 *
 * ── Чому саме частка, а не «скільки разів більше» ────────────────────────
 * Один власник абонемента на рік перетягує середнє на себе, і решта
 * клубу опиняється в нулі. Порядкове місце на це не реагує зовсім.
 *
 * ── Чому місце не показується ────────────────────────────────────────────
 * Рівень — привід прийти ще раз. «Ви 78-й із 84» — привід більше не
 * відкривати цю вкладку. Тому назовні йде назва рівня і прогрес до
 * наступного, а сам порядок лишається в цій функції.
 */

export type LevelInput = {
  visits: number;
  hours: number;
  /** копійки */
  spent: number;
};

export type LevelKey = 'ROOKIE' | 'AMATEUR' | 'REGULAR' | 'LEGEND';

export type PlayerLevel = {
  key: LevelKey;
  name: string;
  /** Наступний рівень або null, якщо вище нікуди */
  next: string | null;
  /** 0..100. Не показується числом, але тримає прогрес */
  score: number;
  /** 0..1 — наскільки пройдено поточний рівень */
  progress: number;
  /**
   * Скільки ще занять треба, щоб наступний рівень взагалі відкрився.
   * null — рівень тримається лише балами, ходити «на кількість» не треба.
   */
  needVisits: number | null;
  /** Скільки гравців клубу в заліку — щоб пояснити, з ким порівнюємо */
  players: number;
};

const LEVELS: { key: LevelKey; name: string; from: number; minVisits: number }[] = [
  { key: 'ROOKIE', name: 'Новачок', from: 0, minVisits: 0 },
  { key: 'AMATEUR', name: 'Аматор', from: 30, minVisits: 3 },
  { key: 'REGULAR', name: 'Завсідник', from: 60, minVisits: 8 },
  { key: 'LEGEND', name: 'Легенда клубу', from: 85, minVisits: 20 },
];

/**
 * Мінімум гравців, при якому місце в клубі взагалі щось означає.
 * У клубі з трьох людей «випереджає 100%» — це не рівень, це арифметика.
 * Поки клуб менший, вище Аматора не піднімаємось.
 */
const ENOUGH_PLAYERS = 8;

/** Ваги. Візити важать найбільше: рівень про звичку ходити, а не про чек. */
const W_VISITS = 0.4;
const W_HOURS = 0.35;
const W_SPENT = 0.25;

/**
 * Частка гравців зі СТРОГО меншим значенням, 0..1.
 *
 * Найслабший отримує 0, найсильніший — 1. Рівні між собою отримують
 * однакову частку: два гравці з двадцятьма заняттями не можуть стояти
 * на різних рівнях через порядок рядків у вибірці.
 */
function share(value: number, all: number[]): number {
  if (all.length < 2) return 1;
  const lower = all.reduce((n, v) => (v < value ? n + 1 : n), 0);
  return lower / (all.length - 1);
}

/**
 * Рівень гравця серед гравців свого клубу.
 *
 * `club` — усі, хто хоч раз приходив, ВКЛЮЧНО з самим гравцем. Свій рядок
 * має бути в списку: без нього людина порівнюється з клубом, у якому її
 * немає, і найактивніший гравець клубу отримує 100% замість свого місця.
 */
export function playerLevel(me: LevelInput, club: LevelInput[]): PlayerLevel {
  const players = club.length;

  const score = Math.round(
    100 * (
      W_VISITS * share(me.visits, club.map((p) => p.visits))
      + W_HOURS * share(me.hours, club.map((p) => p.hours))
      + W_SPENT * share(me.spent, club.map((p) => p.spent))
    ),
  );

  /* Балів може вистачати, а занять — ні. У клубі, де половина людей
     прийшла по разу, друге заняття вже виводить у верхню третину, і без
     цього обмеження «Завсідник» діставався б за один тиждень. */
  let idx = 0;
  for (let i = LEVELS.length - 1; i > 0; i -= 1) {
    const lv = LEVELS[i];
    const bigEnough = lv.key === 'AMATEUR' || players >= ENOUGH_PLAYERS;
    if (score >= lv.from && me.visits >= lv.minVisits && bigEnough) { idx = i; break; }
  }

  const cur = LEVELS[idx];
  const next = LEVELS[idx + 1] ?? null;

  /* Прогрес — по тій із двох умов, яка ще не виконана й тримає сильніше.
     Показувати смужку майже повною, коли до рівня не вистачає десяти
     занять, — це обіцянка, якої ми не дотримаємо. */
  let progress = 1;
  let needVisits: number | null = null;
  if (next) {
    const byScore = (score - cur.from) / (next.from - cur.from);
    const byVisits = next.minVisits > 0 ? me.visits / next.minVisits : 1;
    progress = Math.max(0, Math.min(1, Math.min(byScore, byVisits)));
    if (me.visits < next.minVisits) needVisits = next.minVisits - me.visits;
  }

  return {
    key: cur.key,
    name: cur.name,
    next: next?.name ?? null,
    score,
    progress: Math.round(progress * 100) / 100,
    needVisits,
    players,
  };
}
