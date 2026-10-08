import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { tournamentSportOf, mirrorsToPlayer, fedRatingOrDefault } from './sportRating';
import { resolveRatingSettings, eloDelta, calcVersion } from './federationRating';

export const ratingRulesSchema = z.object({
  win: z.number().int().min(0).max(10000), first: z.number().int().min(0).max(10000),
  second: z.number().int().min(0).max(10000), third: z.number().int().min(0).max(10000),
});
export const DEFAULT_RATING_RULES = { win: 10, first: 30, second: 20, third: 10 };
export function eloResult(a: number, b: number, winner: 'A' | 'B') {
  const delta = Math.round(32 * ((winner === 'A' ? 1 : 0) - 1 / (1 + 10 ** ((b - a) / 400))));
  return { a: a + delta, b: b - delta };
}
export class RatingError extends Error {}

/** Finalization is atomic. A shared lock serializes ELO updates across tournaments.
 * Only approved final results count; byes and walkovers never earn match points/ELO.
 * Once applied, results cannot be reopened through club endpoints. */
export async function finalizeTournament(tx: Prisma.TransactionClient, bookingId: string, actor: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(6100616)`;
  await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${bookingId}::uuid FOR UPDATE`;
  const b = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: {
    tournamentEntries: true, tournamentMatches: { orderBy: [{ round: 'asc' }, { slot: 'asc' }] },
    club: { select: { clubRatingRules: true } }, federation: { select: { ratingSettings: true } },
  } });
  if (b.ratingsAppliedAt) return { alreadyApplied: true };
  if (b.status === 'CANCELLED' || b.status === 'EXPIRED') throw new RatingError('TOURNAMENT_LOCKED');
  if (b.tournamentStatus !== 'RUNNING') throw new RatingError('NOT_RUNNING');
  const rows = b.tournamentMatches;
  const last = Math.max(0, ...rows.map(m => m.round));
  const finals = rows.filter(m => m.round === last && (m.slot === 0 || (b.thirdPlace && m.slot === 1)));
  if (!finals.length || finals.some(m => !['DONE', 'WALKOVER', 'RETIRED'].includes(m.status) || !m.winnerEntryId)) {
    throw new RatingError('FINAL_NOT_PLAYED');
  }
  // Prevent incomplete earlier rounds and mismatched/duplicate identities.
  if (rows.some(m => m.entryAId && m.entryBId && !['DONE', 'WALKOVER', 'RETIRED'].includes(m.status))) {
    throw new RatingError('MATCHES_NOT_FINISHED');
  }
  const entry = new Map(b.tournamentEntries.map(e => [e.id, e]));
  const linked = b.tournamentEntries.filter(e => e.playerId);
  const doubles = (b.tournamentTeamSize ?? 1) === 2;
  if (doubles && b.tournamentEntries.some(e => !e.partnerPlayerId)) throw new RatingError('PARTNER_REQUIRED');
  // Для пар у перевірку на дублі входять і партнери.
  const everyone = linked.flatMap(e => (doubles ? [e.playerId, e.partnerPlayerId] : [e.playerId]));
  if (new Set(everyone).size !== everyone.length) throw new RatingError('DUPLICATE_PLAYER');
  if (linked.length !== b.tournamentEntries.length) throw new RatingError('PLAYERS_REQUIRED');
  const membersOf = (e: { playerId: string | null; partnerPlayerId: string | null }) =>
    (doubles ? [e.playerId!, e.partnerPlayerId!] : [e.playerId!]);
  const fedSettings = resolveRatingSettings(b.federation?.ratingSettings);
  const federationScope = b.tournamentScope === 'FEDERATION';
  // Технічні перемоги рахуються лише якщо федерація це ввімкнула (типово ні).
  const played = rows.filter(m => m.entryAId && m.entryBId && m.winnerEntryId &&
    (m.status === 'DONE' || (federationScope && fedSettings.countWalkovers && m.status === 'WALKOVER') ||
      (m.status === 'RETIRED' && Array.isArray(m.sets) && m.sets.length > 0)));
  const now = new Date();
  const sport = tournamentSportOf(b);
  if (b.tournamentScope === 'FEDERATION') {
    if (!b.federationId) throw new RatingError('FEDERATION_REQUIRED');
    for (const m of played) {
      const idsA = membersOf(entry.get(m.entryAId!)!), idsB = membersOf(entry.get(m.entryBId!)!);
      // ELO читаємо з FederationPlayerRating своєї федерації (= свій вид спорту); немає рядка → startElo.
      const federationId = b.federationId;
      const load = (ids: string[]) => Promise.all(ids.map(async id => {
        const row = await tx.federationPlayerRating.findUnique({ where: { federationId_playerId: { federationId, playerId: id } } });
        const r = fedRatingOrDefault(row);
        return { id, ...r, elo: row ? r.elo : fedSettings.startElo };
      }));
      const [pa, pb] = await Promise.all([load(idsA), load(idsB)]);
      // Рейтинг команди = середній ELO пари. K — власний для кожного гравця (за його кількістю матчів);
      // у пари дельти відрізняються лише коли хтось із партнерів ще «новачок».
      const avg = (ps: typeof pa) => Math.round(ps.reduce((n, p) => n + p.elo, 0) / ps.length);
      const winner = m.winnerEntryId === m.entryAId ? 'A' as const : 'B' as const;
      const tA = avg(pa), tB = avg(pb);
      const deltas = [
        ...pa.map(p => [p, eloDelta(fedSettings, tA, tB, winner, p.matchCount, p.matchCount).a] as const),
        ...pb.map(p => [p, eloDelta(fedSettings, tA, tB, winner, p.matchCount, p.matchCount).b] as const),
      ];
      for (const [p, delta] of deltas) {
        const rating = p.elo + delta;
        await tx.ratingChange.create({ data: { playerId: p.id, matchId: m.id, matchRefId: m.id,
          ratingType: 'FEDERATION', sport, kind: 'MATCH', before: p.elo, after: rating,
          matchCountBefore: p.matchCount, matchCountAfter: p.matchCount + 1,
          lastMatchAtBefore: p.lastMatchAt, lastMatchAtAfter: m.finishedAt ?? now,
          matchVersion: m.version, calculationVersion: calcVersion(fedSettings), changedBy: actor,
          reason: `Official tournament ${b.id}`, effectiveAt: now,
          idempotencyKey: `federation:${b.id}:${m.id}:${p.id}` } });
        await tx.federationPlayerRating.upsert({ where: { federationId_playerId: { federationId, playerId: p.id } },
          create: { federationId, playerId: p.id, elo: rating, matchCount: 1, lastMatchAt: m.finishedAt ?? now },
          update: { elo: rating, matchCount: { increment: 1 }, lastMatchAt: m.finishedAt ?? now } });
        // Зворотна сумісність: дзеркало в Player лише для сквош-федерацій (публічні сторінки читали його).
        if (mirrorsToPlayer(sport)) await tx.player.update({ where: { id: p.id }, data: { eloFederation: rating,
          federationMatchCount: { increment: 1 }, lastFederationMatchAt: m.finishedAt ?? now } });
      }
    }
  } else if (b.tournamentRated !== false) {
    const parsed = ratingRulesSchema.safeParse(b.club.clubRatingRules);
    const rules = parsed.success ? parsed.data : DEFAULT_RATING_RULES;
    const final = finals.find(m => m.slot === 0)!;
    const second = final.winnerEntryId === final.entryAId ? final.entryBId : final.entryAId;
    const third = finals.find(m => m.slot === 1)?.winnerEntryId;
    for (const e of linked) {
      const games = played.filter(m => m.entryAId === e.id || m.entryBId === e.id);
      const wins = games.filter(m => m.winnerEntryId === e.id).length;
      const champion = final.winnerEntryId === e.id;
      const placement = champion ? rules.first : second === e.id ? rules.second : third === e.id ? rules.third : 0;
      const points = wins * rules.win + placement;
      // Обидва гравці пари отримують однакові очки.
      for (const pid of membersOf(e)) {
        const key = { clubId_playerId_sport: { clubId: b.clubId, playerId: pid, sport } };
        const r = await tx.clubPlayerRating.upsert({ where: key, create: { clubId: b.clubId, playerId: pid, sport }, update: {} });
        await tx.ratingChange.create({ data: { playerId: pid, clubId: b.clubId,
          ratingType: 'CLUB', sport, kind: 'MATCH', before: r.points, after: r.points + points,
          matchCountBefore: r.matchCount, matchCountAfter: r.matchCount + games.length,
          lastMatchAtBefore: r.lastMatchAt, lastMatchAtAfter: games.length ? now : r.lastMatchAt,
          calculationVersion: 'club-points-v1', changedBy: actor, reason: `Tournament ${b.id}; ${JSON.stringify(rules)}`,
          effectiveAt: now, idempotencyKey: `club:${b.id}:${pid}` } });
        await tx.clubPlayerRating.update({ where: key,
          data: { points: { increment: points }, wins: { increment: wins }, matchCount: { increment: games.length },
            tournamentWins: { increment: champion ? 1 : 0 }, ...(games.length ? { lastMatchAt: now } : {}) } });
      }
    }
  }
  await tx.booking.update({ where: { id: b.id }, data: { tournamentStatus: 'FINISHED', ratingsAppliedAt: now } });
  return { alreadyApplied: false };
}

/** Турнір, що не стартував до свого завершення (чернетка/реєстрація), більше не показуємо в кабінетах. */
export const notExpiredTournament = () => ({ OR: [{ tournamentStatus: { in: ['RUNNING', 'FINISHED'] as ('RUNNING' | 'FINISHED')[] } }, { endTime: { gte: new Date() } }] });

// ── Підсумки завершеного турніру ──────────────────────────────────────
type ResEntry = { id: string; playerId: string | null; name: string; partnerPlayerId?: string | null };
type ResMatch = { round: number; slot: number; entryAId: string | null; entryBId: string | null; winnerEntryId: string | null; status: string; sets: unknown };
type ResChange = { playerId: string; before: number; after: number; idempotencyKey: string | null };
export type StandingRow = { entryId: string; playerId: string | null; name: string; place: number | null; played: number; wins: number; losses: number;
  setsWon: number; setsLost: number; gamesWon: number; gamesLost: number; ratingType: 'FEDERATION' | 'CLUB' | 'NONE'; before: number | null; after: number | null; delta: number | null;
  /** Партнер пари (2×2): його рейтинг до/після/дельта; для одиночних відсутній. */
  partner?: { playerId: string; before: number | null; after: number | null; delta: number | null } };
export type TournamentResults = { podium: { place: number; entryId: string; playerId: string | null; name: string }[]; standings: StandingRow[] };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** Чиста частина: changes мають бути впорядковані за часом (від старих до нових). */
export function computeTournamentResults(
  b: { thirdPlace: boolean; tournamentScope?: string | null; tournamentRated?: boolean | null }, entries: ResEntry[], matches: ResMatch[], changes: ResChange[],
): TournamentResults {
  const ratingType = b.tournamentScope === 'FEDERATION' ? 'FEDERATION' as const : b.tournamentRated === false ? 'NONE' as const : 'CLUB' as const;
  const last = Math.max(0, ...matches.map(m => m.round));
  const at = (slot: number) => matches.find(m => m.round === last && m.slot === slot);
  const loser = (m?: ResMatch) => (m?.winnerEntryId ? (m.winnerEntryId === m.entryAId ? m.entryBId : m.entryAId) : null);
  const place = new Map<string, number>();
  const fin = at(0), third = b.thirdPlace ? at(1) : undefined;
  const put = (id: string | null | undefined, p: number) => { if (id) place.set(id, p); };
  put(fin?.winnerEntryId, 1); put(loser(fin), 2); put(third?.winnerEntryId, 3); put(loser(third), 4);
  const played = matches.filter(m => m.entryAId && m.entryBId && m.winnerEntryId &&
    (m.status === 'DONE' || (m.status === 'RETIRED' && Array.isArray(m.sets) && m.sets.length > 0)));
  const byPlayer = new Map<string, ResChange[]>();
  for (const c of changes) byPlayer.set(c.playerId, [...(byPlayer.get(c.playerId) ?? []), c]);
  const standings: StandingRow[] = entries.map(e => {
    const row: StandingRow = { entryId: e.id, playerId: e.playerId, name: e.name, place: place.get(e.id) ?? null, played: 0, wins: 0, losses: 0,
      setsWon: 0, setsLost: 0, gamesWon: 0, gamesLost: 0, ratingType, before: null, after: null, delta: null };
    for (const m of played) {
      const isA = m.entryAId === e.id;
      if (!isA && m.entryBId !== e.id) continue;
      row.played++; if (m.winnerEntryId === e.id) row.wins++; else row.losses++;
      for (const s of Array.isArray(m.sets) ? m.sets as { a?: unknown; b?: unknown }[] : []) {
        const mine = num(isA ? s?.a : s?.b), theirs = num(isA ? s?.b : s?.a);
        row.gamesWon += mine; row.gamesLost += theirs;
        if (mine > theirs) row.setsWon++; else if (theirs > mine) row.setsLost++;
      }
    }
    const rc = e.playerId ? byPlayer.get(e.playerId) : undefined;
    if (rc?.length) { row.before = rc[0].before; row.after = rc[rc.length - 1].after; row.delta = row.after - row.before; }
    if (e.partnerPlayerId) {
      const pc = byPlayer.get(e.partnerPlayerId);
      const p = { playerId: e.partnerPlayerId, before: null as number | null, after: null as number | null, delta: null as number | null };
      if (pc?.length) { p.before = pc[0].before; p.after = pc[pc.length - 1].after; p.delta = p.after - p.before; }
      row.partner = p;
    }
    return row;
  });
  standings.sort((x, y) => (x.place ?? 99) - (y.place ?? 99) || (y.delta ?? 0) - (x.delta ?? 0) || y.wins - x.wins || x.name.localeCompare(y.name));
  const podium = standings.filter(s => s.place && s.place <= 3).map(s => ({ place: s.place!, entryId: s.entryId, playerId: s.playerId, name: s.name }));
  return { podium, standings };
}

/** Підсумки з БД (db — prisma або tx); null, якщо турнір не FINISHED. */
export async function tournamentResults(
  db: Pick<Prisma.TransactionClient, 'tournamentEntry' | 'tournamentMatch' | 'ratingChange'>,
  booking: { id: string; thirdPlace: boolean; tournamentStatus: string | null; tournamentScope?: string | null; tournamentRated?: boolean | null },
) {
  if (booking.tournamentStatus !== 'FINISHED') return null;
  const fed = booking.tournamentScope === 'FEDERATION';
  const [entries, matches] = await Promise.all([
    db.tournamentEntry.findMany({ where: { bookingId: booking.id }, orderBy: { seed: 'asc' } }),
    db.tournamentMatch.findMany({ where: { bookingId: booking.id } }),
  ]);
  const playerIds = entries.flatMap(e => [e.playerId, e.partnerPlayerId]).filter((x): x is string => !!x);
  const unrated = !fed && booking.tournamentRated === false;
  const changes = unrated ? [] : await db.ratingChange.findMany({
    where: fed ? { idempotencyKey: { startsWith: `federation:${booking.id}:` } } : { idempotencyKey: { in: playerIds.map(p => `club:${booking.id}:${p}`) } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { playerId: true, before: true, after: true, idempotencyKey: true },
  });
  return computeTournamentResults(booking, entries, matches, changes);
}
