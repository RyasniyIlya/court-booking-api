// Ізоляція рейтингів за видом спорту: спільні хелпери API (і чиста логіка маппінгу міграції 20261007230000).
import type { Sport } from '@prisma/client';
import { SPORTS } from './sport';

/** Старі турніри без tournamentSport — сквош (усі наявні турніри були сквош). */
export const DEFAULT_SPORT: Sport = 'SQUASH';
export const tournamentSportOf = (b: { tournamentSport?: Sport | null }): Sport => b.tournamentSport ?? DEFAULT_SPORT;

/** `?sport=` для списків: відсутній → SQUASH; невалідний → null (400). */
export function parseSportQuery(v: unknown): Sport | null {
  if (v === undefined || v === '') return DEFAULT_SPORT;
  return typeof v === 'string' && (SPORTS as readonly string[]).includes(v) ? (v as Sport) : null;
}

/** Дзеркало в Player.eloFederation/... пишемо лише для сквош-федерацій (зворотна сумісність). */
export const mirrorsToPlayer = (sport: Sport) => sport === DEFAULT_SPORT;

export const DEFAULT_ELO = 1200;
export type FedRatingRow = { elo: number; matchCount: number; lastMatchAt: Date | null };
export const fedRatingOrDefault = (row?: Partial<FedRatingRow> | null): FedRatingRow =>
  ({ elo: row?.elo ?? DEFAULT_ELO, matchCount: row?.matchCount ?? 0, lastMatchAt: row?.lastMatchAt ?? null });

/** Спорт нового рядка членства клубу: перший спорт клубу, інакше SQUASH. */
export const defaultClubSport = (clubSports: readonly Sport[] | null | undefined): Sport => clubSports?.[0] ?? DEFAULT_SPORT;

/** Чисте відтворення маппінгу міграції 5.1 (для тесту й перевірки): Player → FederationPlayerRating. */
export type LegacyPlayer = { id: string; federationId: string | null; eloFederation: number; federationMatchCount: number; lastFederationMatchAt: Date | null };
export type LegacyFedChange = { playerId: string; federationId: string | null; effectiveAt: Date };
export function mapLegacyFederationRatings(players: LegacyPlayer[], changes: LegacyFedChange[]) {
  const out = new Map<string, { federationId: string; playerId: string } & FedRatingRow>();
  const put = (federationId: string, p: LegacyPlayer) => {
    const k = `${federationId}:${p.id}`;
    if (!out.has(k)) out.set(k, { federationId, playerId: p.id, elo: p.eloFederation, matchCount: p.federationMatchCount, lastMatchAt: p.lastFederationMatchAt });
  };
  for (const p of players) if (p.federationId) put(p.federationId, p);
  const byId = new Map(players.map(p => [p.id, p]));
  for (const c of [...changes].sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime())) {
    const p = byId.get(c.playerId);
    if (p && c.federationId) put(c.federationId, p);
  }
  return [...out.values()];
}
