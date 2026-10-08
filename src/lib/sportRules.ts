// Правила видів спорту (єдине джерело істини): формат, сети, рахунок. Дзеркало для форм — GET /api/public/sport-rules.
import { z } from 'zod';

export type SportKey = 'PADEL' | 'TENNIS' | 'SQUASH';
export const RULE_SPORTS: readonly SportKey[] = ['PADEL', 'TENNIS', 'SQUASH'];

export type Scoring =
  | { kind: 'points'; pointsToWin: readonly number[]; defaultPointsToWin: number; winBy: number }
  | { kind: 'games'; gamesToWin: number; winBy: number; tieBreakAt: number; tieBreakTo: number; goldenPointOption: boolean };

export type SportRules = {
  sport: SportKey;
  teamSizes: readonly number[];
  defaultTeamSize: number;
  setsToWin: readonly number[];
  defaultSetsToWin: number;
  scoring: Scoring;
};

export const SPORT_RULES: Record<SportKey, SportRules> = {
  SQUASH: {
    sport: 'SQUASH', teamSizes: [1], defaultTeamSize: 1, setsToWin: [1, 2, 3], defaultSetsToWin: 3,
    scoring: { kind: 'points', pointsToWin: [11, 15], defaultPointsToWin: 11, winBy: 2 },
  },
  TENNIS: {
    sport: 'TENNIS', teamSizes: [1, 2], defaultTeamSize: 1, setsToWin: [2, 3], defaultSetsToWin: 2,
    scoring: { kind: 'games', gamesToWin: 6, winBy: 2, tieBreakAt: 6, tieBreakTo: 7, goldenPointOption: false },
  },
  PADEL: {
    sport: 'PADEL', teamSizes: [1, 2], defaultTeamSize: 2, setsToWin: [1, 2], defaultSetsToWin: 2,
    scoring: { kind: 'games', gamesToWin: 6, winBy: 2, tieBreakAt: 6, tieBreakTo: 7, goldenPointOption: true },
  },
};

/** Правила за видом спорту; без спорту (legacy) — null. */
export function rulesOf(sport: SportKey | null | undefined): SportRules | null {
  return sport ? SPORT_RULES[sport] ?? null : null;
}

export const tournamentSettingsSchema = z.object({
  teamSize: z.number().int(),
  setsToWin: z.number().int(),
  pointsToWin: z.number().int().optional(),
  goldenPoint: z.boolean().optional(),
}).strict();
export type TournamentSettings = z.infer<typeof tournamentSettingsSchema>;

export function defaultSettings(sport: SportKey): TournamentSettings {
  const r = SPORT_RULES[sport];
  const s: TournamentSettings = { teamSize: r.defaultTeamSize, setsToWin: r.defaultSetsToWin };
  if (r.scoring.kind === 'points') s.pointsToWin = r.scoring.defaultPointsToWin;
  else if (r.scoring.goldenPointOption) s.goldenPoint = false;
  return s;
}

/** Список кодів помилок (порожній = налаштування коректні). */
export function validateSettings(sport: SportKey, settings: unknown): string[] {
  const p = tournamentSettingsSchema.safeParse(settings);
  if (!p.success) return ['BAD_SETTINGS'];
  const s = p.data, r = SPORT_RULES[sport], errs: string[] = [];
  if (!r.teamSizes.includes(s.teamSize)) errs.push('BAD_TEAM_SIZE');
  if (!r.setsToWin.includes(s.setsToWin)) errs.push('BAD_SETS_TO_WIN');
  if (r.scoring.kind === 'points') {
    if (s.pointsToWin !== undefined && !r.scoring.pointsToWin.includes(s.pointsToWin)) errs.push('BAD_POINTS_TO_WIN');
    if (s.goldenPoint !== undefined) errs.push('BAD_GOLDEN_POINT');
  } else {
    if (s.pointsToWin !== undefined) errs.push('BAD_POINTS_TO_WIN');
    if (s.goldenPoint !== undefined && !r.scoring.goldenPointOption) errs.push('BAD_GOLDEN_POINT');
  }
  return errs;
}

/** Доповнити неповні налаштування типовими (pointsToWin тощо) — після validateSettings. */
export function normalizeSettings(sport: SportKey, settings: TournamentSettings): TournamentSettings {
  const d = defaultSettings(sport);
  return { ...d, ...settings };
}

type Sets = { a: number; b: number }[];

/** Сет завершено за правилами (фінальний, допустимий рахунок). */
export function isSetComplete(sport: SportKey, settings: TournamentSettings, a: number, b: number): boolean {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return false;
  const sc = SPORT_RULES[sport].scoring, hi = Math.max(a, b), lo = Math.min(a, b);
  if (sc.kind === 'points') {
    const ptw = settings.pointsToWin ?? sc.defaultPointsToWin;
    if (hi < ptw || hi - lo < sc.winBy) return false;
    return hi === ptw ? true : hi - lo === sc.winBy;
  }
  if (hi === sc.gamesToWin) return lo <= sc.gamesToWin - sc.winBy;
  return hi === sc.tieBreakTo && (lo === sc.tieBreakTo - 1 || lo === sc.tieBreakTo - sc.winBy);
}

/** Рахунок можливий (завершений або проміжний); відсікає 12:5 в очках, 8:6 в геймах тощо. */
export function isSetPossible(sport: SportKey, settings: TournamentSettings, a: number, b: number): boolean {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return false;
  if (isSetComplete(sport, settings, a, b)) return true;
  const sc = SPORT_RULES[sport].scoring, hi = Math.max(a, b), lo = Math.min(a, b);
  if (sc.kind === 'points') {
    const ptw = settings.pointsToWin ?? sc.defaultPointsToWin;
    return hi < ptw || hi - lo < sc.winBy;
  }
  return hi <= sc.gamesToWin;
}

/** Переможець матчу ('A'/'B') лише коли сторона виграла setsToWin завершених сетів. */
export function matchWinner(sport: SportKey, settings: TournamentSettings, sets: Sets): 'A' | 'B' | null {
  let wa = 0, wb = 0;
  for (const s of sets) {
    if (!isSetComplete(sport, settings, s.a, s.b)) continue;
    if (s.a > s.b) wa++; else wb++;
    if (wa >= settings.setsToWin) return 'A';
    if (wb >= settings.setsToWin) return 'B';
  }
  return null;
}

/** Конфіг для публічних форм. */
export function publicSportRules() {
  return { sports: RULE_SPORTS.map((s) => ({ ...SPORT_RULES[s], defaults: defaultSettings(s) })) };
}

/** Правила сету для resolveMatchUpdate; null — legacy (немає спорту або налаштувань). */
export function scoringFromSettings(sport: SportKey | null | undefined, settings: unknown) {
  if (!sport || settings == null || validateSettings(sport, settings).length) return null;
  const s = normalizeSettings(sport, settings as TournamentSettings);
  return {
    setsToWin: s.setsToWin,
    isSetComplete: (a: number, b: number) => isSetComplete(sport, s, a, b),
    isSetPossible: (a: number, b: number) => isSetPossible(sport, s, a, b),
  };
}

export type SettingsBuild =
  | { ok: true; settings: TournamentSettings | null; teamSize: number; setsToWin: number | null }
  | { ok: false; error: string };

/**
 * Налаштування нового турніру. Є `settings` — валідуємо й нормалізуємо; немає, а спорт є —
 * типові з урахуванням явних teamSize/setsToWin (якщо дозволені правилами); немає спорту — legacy (null).
 */
export function buildTournamentSettings(
  sport: SportKey | null | undefined,
  input: { settings?: unknown; teamSize?: number; setsToWin?: number | null },
): SettingsBuild {
  if (input.settings != null) {
    if (!sport) return { ok: false, error: 'SPORT_REQUIRED' };
    const errs = validateSettings(sport, input.settings);
    if (errs.length) return { ok: false, error: errs[0] };
    const s = normalizeSettings(sport, input.settings as TournamentSettings);
    if (input.teamSize !== undefined && input.teamSize !== s.teamSize) return { ok: false, error: 'BAD_TEAM_SIZE' };
    return { ok: true, settings: s, teamSize: s.teamSize, setsToWin: s.setsToWin };
  }
  if (!sport) return { ok: true, settings: null, teamSize: input.teamSize ?? 1, setsToWin: input.setsToWin ?? null };
  const r = SPORT_RULES[sport], d = defaultSettings(sport);
  const s: TournamentSettings = {
    ...d,
    teamSize: input.teamSize ?? d.teamSize,
    setsToWin: input.setsToWin != null && r.setsToWin.includes(input.setsToWin) ? input.setsToWin : d.setsToWin,
  };
  const errs = validateSettings(sport, s);
  if (errs.length) return { ok: false, error: errs[0] };
  return { ok: true, settings: s, teamSize: s.teamSize, setsToWin: s.setsToWin };
}
