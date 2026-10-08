// Правила видів спорту: сквош — лише 1×1, теніс/падел — 1×1 або 2×2. Дзеркало: web src/lib/sportApi.js.
import { z } from 'zod';
import { rulesOf } from './sportRules';
export const sportsSchema = z.array(z.enum(['PADEL', 'TENNIS', 'SQUASH'])).max(3);
export const SPORTS = ['PADEL', 'TENNIS', 'SQUASH'] as const;
export type SportKey = (typeof SPORTS)[number];
export const SPORT_LABEL: Record<SportKey, string> = { PADEL: 'Падел', TENNIS: 'Теніс', SQUASH: 'Сквош' };
export const TEAM_SIZE_LABEL: Record<number, string> = { 1: 'Одиночний (1×1)', 2: 'Парний (2×2)' };

export function allowedTeamSizes(sport: SportKey | null | undefined): number[] {
  return [...(rulesOf(sport)?.teamSizes ?? [1, 2])];
}
export function defaultTeamSize(sport: SportKey | null | undefined): number {
  return rulesOf(sport)?.defaultTeamSize ?? 1;
}
/** Код помилки валідації (BAD_TEAM_SIZE / SPORT_NOT_IN_CLUB) або null, якщо все гаразд. */
export function sportError(sport: SportKey | null | undefined, teamSize: number, clubSports: readonly string[] | null | undefined) {
  if (!allowedTeamSizes(sport).includes(teamSize)) return 'BAD_TEAM_SIZE' as const;
  if (sport && clubSports?.length && !clubSports.includes(sport)) return 'SPORT_NOT_IN_CLUB' as const;
  return null;
}
