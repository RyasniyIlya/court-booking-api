// Налаштування ELO федерації: схема, типові значення, K-фактор (з "новачковим" K), рівні гри.
import { z } from 'zod';
import { DEFAULT_ELO } from './sportRating';

export const DEFAULT_LEVELS = [
  { code: 'E', label: 'Початківець', minElo: 0 },
  { code: 'D', label: 'Аматор', minElo: 1100 },
  { code: 'C', label: 'Середній', minElo: 1250 },
  { code: 'B', label: 'Просунутий', minElo: 1400 },
  { code: 'A', label: 'Сильний', minElo: 1550 },
  { code: 'Pro', label: 'Професіонал', minElo: 1700 },
];

const levelSchema = z.object({
  code: z.string().trim().min(1).max(8),
  label: z.string().trim().min(1).max(40),
  minElo: z.number().int().min(0).max(4000),
});

export const ratingSettingsSchema = z.object({
  startElo: z.number().int().min(800).max(2000),
  kFactor: z.number().int().min(8).max(64),
  provisionalK: z.number().int().min(8).max(80),
  provisionalMatches: z.number().int().min(0).max(30),
  countWalkovers: z.boolean(),
  levels: z.array(levelSchema).min(2).max(10),
}).superRefine((v, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: 'custom', path: ['levels'], message });
  if (v.levels[0].minElo !== 0) bad('FIRST_LEVEL_MUST_START_AT_0');
  for (let i = 1; i < v.levels.length; i++) if (v.levels[i].minElo <= v.levels[i - 1].minElo) { bad('LEVELS_NOT_INCREASING'); break; }
  if (new Set(v.levels.map(l => l.code.toLowerCase())).size !== v.levels.length) bad('LEVEL_CODES_NOT_UNIQUE');
});

export type RatingLevel = z.infer<typeof levelSchema>;
export type FederationRatingSettings = z.infer<typeof ratingSettingsSchema>;

export const DEFAULT_RATING_SETTINGS: FederationRatingSettings = {
  startElo: DEFAULT_ELO, kFactor: 32, provisionalK: 40, provisionalMatches: 10, countWalkovers: false,
  levels: DEFAULT_LEVELS,
};

/** Сире значення з БД (null / зіпсований JSON) → валідні налаштування; невалідне = типові. */
export function resolveRatingSettings(raw: unknown): FederationRatingSettings {
  if (raw == null) return DEFAULT_RATING_SETTINGS;
  const p = ratingSettingsSchema.safeParse(raw);
  return p.success ? p.data : DEFAULT_RATING_SETTINGS;
}

/** K гравця: перші provisionalMatches матчів — provisionalK (0 = вимкнено), далі kFactor. */
export const kFor = (s: FederationRatingSettings, matchCount: number) =>
  s.provisionalMatches > 0 && matchCount < s.provisionalMatches ? s.provisionalK : s.kFactor;

/**
 * Зміна ELO для A і B. K береться для кожного окремо (за кількістю його матчів).
 * Для рівних K — симетрично (b = -a), як у старій формулі `32 * (S - E)`.
 * Парні: викликайте з середнім ELO команд; гравцю з команди A беріть `.a`, з B — `.b`
 * (matchCount передавайте його власний, в обидва аргументи).
 */
export function eloDelta(s: FederationRatingSettings, a: number, b: number, winner: 'A' | 'B', matchCountA: number, matchCountB: number) {
  const expectedA = 1 / (1 + 10 ** ((b - a) / 400));
  const scoreA = winner === 'A' ? 1 : 0;
  const ka = kFor(s, matchCountA), kb = kFor(s, matchCountB);
  const da = Math.round(ka * (scoreA - expectedA));
  const db = ka === kb ? -da : Math.round(kb * ((1 - scoreA) - (1 - expectedA)));
  return { a: da, b: db };
}

export function levelOf(s: FederationRatingSettings, elo: number): { code: string; label: string } {
  let cur = s.levels[0];
  for (const l of s.levels) if (elo >= l.minElo) cur = l;
  return { code: cur.code, label: cur.label };
}

/** Рядок версії розрахунку для RatingChange.calculationVersion. */
export const calcVersion = (s: FederationRatingSettings) => `elo-v2;k=${s.kFactor};pk=${s.provisionalK};pn=${s.provisionalMatches}`;
