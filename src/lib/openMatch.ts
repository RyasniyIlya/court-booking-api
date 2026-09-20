/**
 * Відкрита гра: кому її показати і кого покликати.
 *
 * ── Що це таке ──────────────────────────────────────────────────────────
 *
 * Гравець хоче грати, але йому не вистачає партнерів. Він ставить годину,
 * каже свій рівень і скільки людей треба — і година стає видимою іншим.
 * У базі це звичайне групове заняття з прапорцем `isOpenMatch`: місця,
 * ціна за людину, оплата кожним своїм телефоном і автозакриття при
 * заповненні вже працюють у групах. Нове рівно одне — підбір.
 *
 * ── Чому підбір, а не «вільні місця» ────────────────────────────────────
 *
 * Список «є 2 вільних місця» розсилати нема кому: або пишеш усім і
 * перетворюєш сповіщення на спам, після якого їх вимикають, або не пишеш
 * нікому і гра стоїть порожня. Тому запрошення йде не всім, а тим, кого
 * ця конкретна година справді стосується: свій рівень, свій звичний час,
 * свій день тижня, приходить коли записався.
 *
 * ── Чому ваги видно ─────────────────────────────────────────────────────
 *
 * Кожен кандидат несе причини, за якими його покликали («рівень рівно
 * ваш», «зазвичай грає о 19:00»). Адміністратор має бачити, чому система
 * обрала цих вісьмох, інакше він їй не повірить і напише всім сам.
 *
 * Тут лише чисті функції: ні бази, ні HTTP. Вибірка кандидатів живе в
 * openMatchInvite.ts, і саме тому це можна перевірити тестами без БД.
 */

import type { SkillLevel } from '@prisma/client';

/**
 * Рівні від слабкого до сильного — порядок тримає всю арифметику підбору.
 * Кортеж, а не масив: із нього ж збирається zod-схема на вході.
 */
export const SKILL_LEVELS = ['D', 'C', 'C_PLUS', 'B', 'B_PLUS'] as const satisfies readonly SkillLevel[];

export const LEVELS: SkillLevel[] = [...SKILL_LEVELS];

/** Назва гри, коли клуб не дав свою: у відкритої гри немає «заняття». */
export const OPEN_MATCH_TITLE = 'Відкрита гра';

/** Падельна шкала: гравці читають «3.0–3.5», а не «C_PLUS». */
export const LEVEL_SCALE: Record<SkillLevel, string> = {
  D: '2.0–2.5',
  C: '2.5–3.0',
  C_PLUS: '3.0–3.5',
  B: '3.5–4.0',
  B_PLUS: '4.0–4.5',
};

/** Підпис рівня для віджета й для сповіщення. */
export const levelLabel = (level: SkillLevel) => `${level.replace('_PLUS', '+')} · ${LEVEL_SCALE[level]}`;

/**
 * Ваги сигналів. Рівень важить найбільше: не той рівень — і гра не
 * відбудеться, навіть якщо людина вільна. Останній візит важить найменше —
 * він уточнює порядок, а не вирішує.
 */
export const WEIGHTS = { level: 40, hour: 25, weekday: 15, reliability: 15, recent: 5 };

/** На скільки сходинок шкали підбір виходить за межі заявленого рівня. */
export const LEVEL_SPREAD = 1;

/** Скільком гравцям іде запрошення за один раз. */
export const INVITE_LIMIT = 8;

/** Давно не був — це після стількох днів. */
const STALE_DAYS = 30;

export type Candidate = {
  id: string;
  name: string;
  level: SkillLevel | null;
  /** Години доби, у які людина зазвичай грає (з її минулих броней). */
  hours: number[];
  /** Дні тижня, у які людина зазвичай грає. Неділя = 0. */
  weekdays: number[];
  /** Скільки разів не прийшов, маючи бронь. */
  noShows: number;
  /** Скільки візитів у заліку — щоб no-show не топив новачка з однією бронню. */
  visits: number;
  /** Скільки днів тому був востаннє. null — ще жодного разу. */
  lastVisitDays: number | null;
};

export type Ranked = {
  id: string;
  name: string;
  level: SkillLevel | null;
  /** 0..100 — наскільки гра йому підходить. */
  score: number;
  /** Причини людською мовою: чому покликали саме його. */
  reasons: string[];
};

export type MatchContext = {
  /** Рівень, на який збирається гра. null — будь-який. */
  levelMin: SkillLevel | null;
  levelMax: SkillLevel | null;
  /** Година початку за часом клубу. */
  hour: number;
  /** День тижня гри, неділя = 0. */
  weekday: number;
  /** Кого не кликати: вже в грі, це він її й створив, або заблокований. */
  exclude?: string[];
};

const index = (level: SkillLevel) => LEVELS.indexOf(level);

/**
 * Межі підбору: гра на C+ цікава і C, і B — сусідні рівні грають між собою
 * без образ. Через два рівні вже ні: там одному нудно, іншому нема що ловити.
 */
export function band(ctx: Pick<MatchContext, 'levelMin' | 'levelMax'>): { from: number; to: number } | null {
  if (!ctx.levelMin && !ctx.levelMax) return null;
  const min = index(ctx.levelMin ?? ctx.levelMax!);
  const max = index(ctx.levelMax ?? ctx.levelMin!);
  return { from: Math.max(0, min - LEVEL_SPREAD), to: Math.min(LEVELS.length - 1, max + LEVEL_SPREAD) };
}

/** Підпис діапазону для віджета: «C–C+ · 2.5–3.5» або «будь-який рівень». */
export function bandLabel(levelMin: SkillLevel | null, levelMax: SkillLevel | null): string {
  if (!levelMin && !levelMax) return 'будь-який рівень';
  const min = levelMin ?? levelMax!;
  const max = levelMax ?? levelMin!;
  const from = LEVEL_SCALE[min].split('–')[0];
  const to = LEVEL_SCALE[max].split('–')[1];
  const names = min === max ? min.replace('_PLUS', '+') : `${min.replace('_PLUS', '+')}–${max.replace('_PLUS', '+')}`;
  return `${names} · ${from}–${to}`;
}

/**
 * Чи підходить гравцю ця гра.
 *
 * Гравець без рівня проходить завжди: порожній рівень означає «ще не
 * спитали», і ховати від людини всі ігри клубу через незаповнене поле —
 * найшвидший спосіб зробити фічу невидимою.
 */
export function fits(level: SkillLevel | null, ctx: Pick<MatchContext, 'levelMin' | 'levelMax'>): boolean {
  const range = band(ctx);
  if (!range || !level) return true;
  const i = index(level);
  return i >= range.from && i <= range.to;
}

/**
 * Надійність гравця, 0..1. Рахується вагою пропусків, а не їх кількістю:
 * один no-show на сорок візитів і один на два — це різні люди.
 *
 * Поки візитів мало, показник тримається посередині: судити за двома
 * бронями нема підстав ні в той бік, ні в інший.
 */
export function reliability(c: Pick<Candidate, 'noShows' | 'visits'>): number {
  if (c.visits < 3) return 0.6;
  return Math.max(0, 1 - c.noShows / c.visits);
}

/** Оцінка одного кандидата й причини, за якими його покликали. */
function rank(c: Candidate, ctx: MatchContext): Ranked {
  const reasons: string[] = [];
  let score = 0;

  /* Рівень. Точне влучання — повна вага, сусідній рівень — половина:
     грати можна, але гра вже не рівна. */
  const range = band(ctx);
  if (!range || !c.level) {
    score += WEIGHTS.level * 0.5;
    if (!c.level) reasons.push('рівень не вказаний');
  } else {
    const i = index(c.level);
    const exact = i >= index(ctx.levelMin ?? ctx.levelMax!) && i <= index(ctx.levelMax ?? ctx.levelMin!);
    score += exact ? WEIGHTS.level : WEIGHTS.level * 0.5;
    reasons.push(exact ? `рівень ${levelLabel(c.level)} — рівно ваш` : `рівень ${levelLabel(c.level)}, поруч`);
  }

  if (c.hours.includes(ctx.hour)) {
    score += WEIGHTS.hour;
    reasons.push(`зазвичай грає о ${String(ctx.hour).padStart(2, '0')}:00`);
  }

  if (c.weekdays.includes(ctx.weekday)) {
    score += WEIGHTS.weekday;
    reasons.push('це його день тижня');
  }

  const rel = reliability(c);
  score += WEIGHTS.reliability * rel;
  if (c.visits >= 3 && c.noShows > 0) reasons.push(`пропустив ${c.noShows} із ${c.visits}`);

  /* Свіжість. Хто був цього тижня — відгукнеться швидше за того, хто зник
     місяць тому. Зниклих ми все одно кличемо: гра — привід повернутись. */
  if (c.lastVisitDays !== null && c.lastVisitDays <= 7) {
    score += WEIGHTS.recent;
    reasons.push(c.lastVisitDays <= 1 ? 'був у клубі вчора' : 'був цього тижня');
  } else if (c.lastVisitDays !== null && c.lastVisitDays > STALE_DAYS) {
    reasons.push(`не грав ${c.lastVisitDays} днів`);
  }

  return { id: c.id, name: c.name, level: c.level, score: Math.round(score), reasons };
}

/**
 * Кого кликати в гру, від найдоречнішого. Ті, кому гра не підходить за
 * рівнем, у список не потрапляють узагалі: покликати людину на чужий
 * рівень гірше, ніж не покликати нікого.
 */
export function rankCandidates(candidates: Candidate[], ctx: MatchContext, limit = INVITE_LIMIT): Ranked[] {
  const skip = new Set(ctx.exclude ?? []);
  return candidates
    .filter((c) => !skip.has(c.id) && fits(c.level, ctx))
    .map((c) => rank(c, ctx))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Скільки місць лишилось і чи гра вже зібралась. */
export function seatsLeft(capacity: number, taken: number): { free: number; full: boolean } {
  const free = Math.max(0, capacity - taken);
  return { free, full: free === 0 };
}
