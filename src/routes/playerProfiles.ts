import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db';
import { requireAuth, requireRole, param } from './admin/shared';
import { playerFields, playerFieldsFor, profileSchema, membershipSchema, withFederationElo } from './federation';
import { ratingRulesSchema, notExpiredTournament } from '../lib/tournamentRating';
import { linkCustomerPlayer } from '../lib/players';
import { parseSportQuery } from '../lib/sportRating';
import { resolveRatingSettings, levelOf } from '../lib/federationRating';

/** Федеративні рейтинги гравців (усі федерації/спорти) з рівнем за налаштуваннями кожної федерації. */
async function federationRatingsOf(playerIds: string[]) {
  const out = new Map<string, { federation: { id: string; name: string; code: string; sport: string }; sport: string; elo: number;
    level: { code: string; label: string }; matchCount: number; lastMatchAt: Date | null }[]>();
  if (!playerIds.length) return out;
  const rows = await prisma.federationPlayerRating.findMany({ where: { playerId: { in: playerIds } },
    select: { playerId: true, elo: true, matchCount: true, lastMatchAt: true,
      federation: { select: { id: true, name: true, code: true, sport: true, ratingSettings: true } } } });
  for (const r of rows) {
    const { ratingSettings, ...federation } = r.federation;
    const list = out.get(r.playerId) ?? [];
    list.push({ federation, sport: federation.sport, elo: r.elo, level: levelOf(resolveRatingSettings(ratingSettings), r.elo),
      matchCount: r.matchCount, lastMatchAt: r.lastMatchAt });
    out.set(r.playerId, list);
  }
  return out;
}
/** Вид змагання для профілю: федеративне / клубне / без рейтингу. */
export const competitionKind = (b: { tournamentScope: string; tournamentRated?: boolean | null }) =>
  b.tournamentScope === 'FEDERATION' ? 'FEDERATION' as const : b.tournamentRated === false ? 'UNRATED' as const : 'CLUB' as const;

export const playerProfilesRouter = Router();
export const publicFederationRouter = Router();
const uuid = z.string().uuid();
playerProfilesRouter.use(requireAuth, requireRole('OWNER', 'ADMIN'));
playerProfilesRouter.get('/players/context', async (req, res) => {
  res.json(await prisma.club.findUniqueOrThrow({ where: { id: req.auth!.clubId }, select: { id: true, name: true, slug: true, clubRatingRules: true, sports: true, defaultSetsToWin: true,
    courts: { where: { isActive: true }, select: { id: true, name: true } } } }));
});
playerProfilesRouter.get('/players', async (req, res) => {
  // Усі учасники клубу (рядок у будь-якому спорті); clubRatings — лише вибраного ?sport= (за замовчуванням SQUASH).
  const sport = parseSportQuery(req.query.sport);
  if (!sport) return res.status(400).json({ error: 'BAD_SPORT' });
  const players = await prisma.player.findMany({ where: { clubRatings: { some: { clubId: req.auth!.clubId } } },
    select: { ...playerFieldsFor(sport), phone: true }, orderBy: { name: 'asc' }, take: 1000 });
  const fedRatings = await federationRatingsOf(players.map(p => p.id));
  res.json(players.map(p => ({ ...p, federationRatings: fedRatings.get(p.id) ?? [] })));
});
playerProfilesRouter.get('/players/customers', async (req, res) => {
  res.json(await prisma.customer.findMany({ where: { clubId: req.auth!.clubId, playerId: null },
    select: { id: true, name: true, phone: true }, orderBy: { name: 'asc' }, take: 1000 }));
});
playerProfilesRouter.get('/players/tournaments', async (req, res) => {
  /* Клуб бачить свої турніри та офіційні турніри федерацій, де він підтверджений учасник. */
  const clubId = req.auth!.clubId;
  // Клуб бачить турніри федерацій лише тих видів спорту, що є в клубі (порожній список спортів клубу = усі).
  const [links, hostClub] = await Promise.all([
    prisma.clubFederation.findMany({ where: { clubId, status: 'CONFIRMED' }, select: { federationId: true, federation: { select: { sport: true } } } }),
    prisma.club.findUnique({ where: { id: clubId }, select: { sports: true } }),
  ]);
  const clubSports = hostClub?.sports ?? [];
  const federationIds = links.filter(l => !clubSports.length || clubSports.includes(l.federation.sport)).map(l => l.federationId);
  res.json(await prisma.booking.findMany({ where: { capacity: { not: null }, title: { startsWith: '🏆 ' }, status: { not: 'CANCELLED' },
    AND: [notExpiredTournament()], OR: [{ clubId }, ...(federationIds.length ? [{ tournamentScope: 'FEDERATION' as const, federationId: { in: federationIds } }] : [])] },
    select: { id: true, title: true, startTime: true, capacity: true, tournamentScope: true, tournamentRated: true, tournamentStatus: true, ratingsAppliedAt: true, clubId: true, tournamentSport: true, tournamentTeamSize: true, club: { select: { name: true } },
      court: { select: { name: true } }, _count: { select: { tournamentEntries: true } } }, orderBy: { startTime: 'desc' }, take: 300 }));
});
playerProfilesRouter.post('/players/link/:customerId', async (req, res) => {
  if (!uuid.safeParse(param(req, 'customerId')).success) return res.status(400).json({ error: 'BAD_REQUEST' });
  if (!await prisma.customer.findFirst({ where: { id: param(req, 'customerId'), clubId: req.auth!.clubId }, select: { id: true } })) return res.status(404).json({ error: 'NOT_FOUND' });
  try { res.json(await prisma.$transaction(tx => linkCustomerPlayer(tx, param(req, 'customerId'), req.auth!.clubId))); }
  catch (e) { if ((e as Error).message.startsWith('PLAYER_')) return res.status(409).json({ error: (e as Error).message }); throw e; }
});
playerProfilesRouter.patch('/players/:id', async (req, res) => {
  const p = profileSchema.safeParse(req.body), id = param(req, 'id');
  if (!p.success || !uuid.safeParse(id).success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const member = await prisma.clubPlayerRating.findFirst({ where: { clubId: req.auth!.clubId, playerId: id }, select: { playerId: true } });
  if (!member) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(await prisma.player.update({ where: { id }, data: p.data, select: playerFields }));
});
playerProfilesRouter.patch('/players/:id/membership', async (req, res) => {
  const p = membershipSchema.safeParse(req.body), id = param(req, 'id');
  if (!p.success || !uuid.safeParse(id).success) return res.status(400).json({ error: 'BAD_REQUEST' });
  // Рядок членства — за видом спорту (?sport=, за замовчуванням SQUASH); без вказаного sport змінюємо всі рядки гравця в клубі.
  const sportRaw = req.query.sport;
  const sport = sportRaw === undefined ? null : parseSportQuery(sportRaw);
  if (sportRaw !== undefined && !sport) return res.status(400).json({ error: 'BAD_SPORT' });
  const where = { clubId: req.auth!.clubId, playerId: id, ...(sport ? { sport } : {}) };
  if (!await prisma.clubPlayerRating.findFirst({ where, select: { playerId: true } })) return res.status(404).json({ error: 'NOT_FOUND' });
  await prisma.clubPlayerRating.updateMany({ where, data: p.data });
  res.json(await prisma.clubPlayerRating.findFirst({ where, orderBy: { sport: 'asc' } }));
});
playerProfilesRouter.get('/players/rating-rules', async (req, res) => {
  const club = await prisma.club.findUniqueOrThrow({ where: { id: req.auth!.clubId }, select: { clubRatingRules: true } });
  res.json(club.clubRatingRules);
});
playerProfilesRouter.put('/players/rating-rules', requireRole('OWNER'), async (req, res) => {
  const p = ratingRulesSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  await prisma.club.update({ where: { id: req.auth!.clubId }, data: { clubRatingRules: p.data } });
  res.json(p.data);
});
publicFederationRouter.get('/players/:id', async (req, res) => {
  const id = param(req, 'id');
  if (!uuid.safeParse(id).success) return res.status(404).json({ error: 'NOT_FOUND' });
  const p = await prisma.player.findFirst({ where: { id, publicProfile: true }, select: playerFields });
  if (!p) return res.status(404).json({ error: 'NOT_FOUND' });
  const entries = await prisma.tournamentEntry.findMany({ where: { playerId: id, booking: { status: { not: 'CANCELLED' }, tournamentStatus: { in: ['RUNNING', 'FINISHED'] } } },
    select: { id: true, name: true, booking: { select: { id: true, title: true, tournamentScope: true, tournamentRated: true, startTime: true, tournamentStatus: true, thirdPlace: true,
      club: { select: { name: true } }, federation: { select: { name: true } },
      tournamentMatches: { select: { round: true, slot: true, entryAId: true, entryBId: true, winnerEntryId: true }, orderBy: [{ round: 'desc' }, { slot: 'asc' }], take: 2 } } } }, take: 200, orderBy: { createdAt: 'desc' } });
  const ids = entries.map(e => e.id);
  const matches = await prisma.tournamentMatch.findMany({ where: { OR: [{ entryAId: { in: ids } }, { entryBId: { in: ids } }] },
    select: { id: true, round: true, slot: true, status: true, sets: true, winnerEntryId: true, finishedAt: true,
      entryAId: true, entryBId: true, entryA: { select: { name: true } }, entryB: { select: { name: true } },
      booking: { select: { id: true, title: true, tournamentScope: true, tournamentStatus: true, startTime: true, club: { select: { name: true } } } } },
    orderBy: [{ finishedAt: 'desc' }, { id: 'asc' }], take: 200 });
  const mine = new Set(ids);
  // ELO федерації окремо за федераціями (кожна — свій вид спорту).
  const federationRatings = (await federationRatingsOf([id])).get(id) ?? [];
  // Зміна рейтингу в кожному турнірі: ключі federation:<booking>:<match>:<player> / club:<booking>:<player>.
  const changes = await prisma.ratingChange.findMany({ where: { playerId: id, kind: 'MATCH',
    OR: [{ idempotencyKey: { startsWith: 'federation:' } }, { idempotencyKey: { startsWith: 'club:' } }] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 2000,
    select: { ratingType: true, before: true, after: true, idempotencyKey: true } });
  const changeOf = new Map<string, { type: 'FEDERATION' | 'CLUB'; before: number; after: number; delta: number }>();
  for (const c of changes) {
    const bid = c.idempotencyKey.split(':')[1];
    const prev = changeOf.get(bid);
    const before = prev?.before ?? c.before;
    changeOf.set(bid, { type: c.ratingType === 'FEDERATION' ? 'FEDERATION' : 'CLUB', before, after: c.after, delta: c.after - before });
  }
  const competitions = entries.map(e => {
    const b = e.booking, kind = competitionKind(b);
    const fin = b.tournamentStatus === 'FINISHED' ? b.tournamentMatches.filter(m => m.round === b.tournamentMatches[0]?.round) : [];
    const loser = (m?: { winnerEntryId: string | null; entryAId: string | null; entryBId: string | null }) =>
      m?.winnerEntryId ? (m.winnerEntryId === m.entryAId ? m.entryBId : m.entryAId) : null;
    const f0 = fin.find(m => m.slot === 0), f1 = b.thirdPlace ? fin.find(m => m.slot === 1) : undefined;
    const place = f0?.winnerEntryId === e.id ? 1 : loser(f0) === e.id ? 2 : f1?.winnerEntryId === e.id ? 3 : loser(f1) === e.id ? 4 : null;
    return { bookingId: b.id, title: b.title, startTime: b.startTime, status: b.tournamentStatus, kind, rated: kind !== 'UNRATED',
      club: b.club, federation: b.federation, entryName: e.name, place,
      ratingChange: kind === 'UNRATED' ? null : changeOf.get(b.id) ?? null };
  });
  res.json({ ...p, federationRatings, competitions, clubRatings: p.clubRatings.map(r => ({ club: r.club, sport: r.sport, points: r.points, wins: r.wins,
    matchCount: r.matchCount, tournamentWins: r.tournamentWins, group: r.group, category: r.category,
    title: r.title, status: r.status, achievements: r.achievements, active: r.active })),
    tournaments: entries.map(e => {
      const { tournamentMatches, thirdPlace: _tp, ...tournament } = e.booking;
      return { ...tournament, won: tournament.tournamentStatus === 'FINISHED' && tournamentMatches[0]?.winnerEntryId === e.id };
    }),
    matches: matches.map(m => ({ id: m.id, round: m.round, slot: m.slot, status: m.status, sets: m.sets,
      won: !!m.winnerEntryId && mine.has(m.winnerEntryId), opponent: mine.has(m.entryAId ?? '') ? m.entryB?.name : m.entryA?.name,
      finishedAt: m.finishedAt, tournament: m.booking })),
  });
});
publicFederationRouter.get('/federations/:code', async (req, res) => {
  const f = await prisma.federation.findUnique({ where: { code: param(req, 'code') }, select: { id: true, name: true, code: true, logoUrl: true } });
  if (!f) return res.status(404).json({ error: 'NOT_FOUND' });
  const fedSport = (await prisma.federation.findUnique({ where: { id: f.id }, select: { sport: true } }))?.sport ?? 'SQUASH';
  const [tournaments, rawPlayers] = await Promise.all([prisma.booking.findMany({ where: { federationId: f.id, tournamentScope: 'FEDERATION', status: { not: 'CANCELLED' } },
    select: { id: true, title: true, startTime: true, endTime: true, capacity: true, tournamentStatus: true,
      tournamentGender: true, tournamentCategory: true, tournamentAgeCategory: true, tournamentDescription: true, tournamentSport: true, tournamentTeamSize: true,
      club: { select: { name: true, address: true, slug: true } }, _count: { select: { tournamentEntries: true } } }, orderBy: { startTime: 'asc' }, take: 500 }),
  prisma.player.findMany({ where: { publicProfile: true, OR: [{ federationId: f.id },
    { clubRatings: { some: { active: true, sport: fedSport, club: { federationPartnerships: { some: { federationId: f.id, status: 'CONFIRMED' } } } } } }] },
    select: { id: true, name: true, avatarUrl: true, gender: true, ageCategory: true },
    orderBy: { id: 'asc' }, take: 1000 })]);
  // Рейтинг федерації — лише свого виду спорту (FederationPlayerRating цієї федерації).
  const players = await withFederationElo(f.id, rawPlayers);
  res.set('Cache-Control', 'public, max-age=10').json({ federation: { ...f, sport: fedSport }, tournaments, players });
});
publicFederationRouter.get('/tournaments/:id/overview', async (req, res) => {
  const id = param(req, 'id');
  if (!uuid.safeParse(id).success) return res.status(404).json({ error: 'NOT_FOUND' });
  const b = await prisma.booking.findFirst({ where: { id, capacity: { not: null }, title: { startsWith: '🏆 ' }, status: { not: 'CANCELLED' } },
    select: { id: true, title: true, startTime: true, endTime: true, capacity: true, tournamentScope: true, tournamentStatus: true,
      tournamentGender: true, tournamentCategory: true, tournamentAgeCategory: true, tournamentDescription: true, tournamentSport: true, tournamentTeamSize: true,
      club: { select: { name: true, slug: true, address: true } }, court: { select: { name: true } },
      federationId: true, federation: { select: { name: true, code: true } }, tournamentEntries: { orderBy: { seed: 'asc' }, select: { name: true, seed: true,
        player: { select: { id: true, publicProfile: true, avatarUrl: true, eloFederation: true } } } } } });
  if (!b) return res.status(404).json({ error: 'NOT_FOUND' });
  // ELO учасника — федерації турніру (її вид спорту); без федерації лишається дзеркальне значення.
  const fedRows = b.federationId ? await prisma.federationPlayerRating.findMany({ where: { federationId: b.federationId,
    playerId: { in: b.tournamentEntries.flatMap(e => (e.player ? [e.player.id] : [])) } }, select: { playerId: true, elo: true } }) : [];
  const eloOf = new Map(fedRows.map(r => [r.playerId, r.elo]));
  const { federationId: _fid, ...pub } = b;
  res.json({ ...pub, tournamentEntries: b.tournamentEntries.map(e => ({ name: e.name, seed: e.seed,
    player: e.player?.publicProfile ? { ...e.player, ...(b.federationId ? { eloFederation: eloOf.get(e.player.id) ?? 1200 } : {}) } : null })) });
});
