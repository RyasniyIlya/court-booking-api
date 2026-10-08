import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Prisma, Sport } from '@prisma/client';
import { prisma, isSlotTakenError } from '../lib/db';
import { requireFederationAuth, signFederationToken } from '../lib/federationAuth';
import { requirePlatformAuth } from '../lib/platformAuth';
import { comparePassword, hashPassword } from '../lib/passwordHash';
import { makeLimiter } from '../lib/rateLimits';
import { readPlayerWorkbook, validateImportRows, playerImportTemplate, importPlayerSchema } from '../lib/playerImport';
import { normalizePhone } from '../lib/phone';
import { buildBracket, sweepWalkovers, type SetScore } from '../lib/tournamentBracket';
import { finalizeTournament, RatingError, notExpiredTournament, tournamentResults } from '../lib/tournamentRating';
import { tournamentTitle } from '../lib/tournamentPay';
import { notifyOnWrite } from '../lib/tournamentLive';
import { param } from './admin/shared';
import { SPORTS, defaultTeamSize, sportError } from '../lib/sport';
import { buildTournamentSettings } from '../lib/sportRules';
import { fedRatingOrDefault, DEFAULT_SPORT } from '../lib/sportRating';
import { ratingSettingsSchema, resolveRatingSettings, levelOf, DEFAULT_RATING_SETTINGS } from '../lib/federationRating';

export const federationRouter = Router();
export const federationProvisionRouter = Router();
const uuid = z.string().uuid();
const loginLimiter = makeLimiter({ windowMs: 10 * 60_000, limit: 20 });
const writeLimiter = makeLimiter({ windowMs: 60_000, limit: 30 });
federationProvisionRouter.get('/federations', requirePlatformAuth, async (_req, res) => {
  res.json(await prisma.federation.findMany({ select: { id: true, name: true, code: true, sport: true,
    accounts: { select: { id: true, name: true, email: true, active: true } },
    partnerships: { select: { clubId: true, status: true, club: { select: { name: true } } } } }, orderBy: { name: 'asc' } }));
});
/** Вид спорту федерації (федерація = один спорт). */
export async function federationSportOf(federationId: string): Promise<Sport> {
  return (await prisma.federation.findUnique({ where: { id: federationId }, select: { sport: true } }))?.sport ?? DEFAULT_SPORT;
}
/** Афілійовані гравці: власні + учасники підтверджених клубів у ТОМУ Ж спорті федерації. */
const affiliation = (id: string, sport: Sport): Prisma.PlayerWhereInput => ({ OR: [
  { federationId: id }, { clubRatings: { some: { active: true, sport, club: { federationPartnerships: { some: { federationId: id, status: 'CONFIRMED' } } } } } },
] });
/** Поля гравця; clubRatings (з полем sport) за потреби звужуємо до одного спорту. eloFederation тут — дзеркало (сквош), для федерацій перекривається. */
export const playerFieldsFor = (sport?: Sport) => ({ id: true, name: true, avatarUrl: true, bio: true, gender: true,
  ageCategory: true, skillLevel: true, eloFederation: true, federationMatchCount: true,
  publicProfile: true, clubRatings: { ...(sport ? { where: { sport } } : {}), include: { club: { select: { id: true, name: true, slug: true } } } },
} as const);
export const playerFields = playerFieldsFor();
/** Підставляє ELO/кількість матчів ЦІЄЇ федерації (FederationPlayerRating; немає рядка → 1200/0) і сортує за ELO. */
export async function withFederationElo<T extends { id: string }>(federationId: string, players: T[]) {
  const [rows, fed] = await Promise.all([
    prisma.federationPlayerRating.findMany({ where: { federationId, playerId: { in: players.map(p => p.id) } } }),
    prisma.federation.findUnique({ where: { id: federationId }, select: { ratingSettings: true } }),
  ]);
  const settings = resolveRatingSettings(fed?.ratingSettings);
  const byId = new Map(rows.map(r => [r.playerId, r]));
  return players.map(p => { const row = byId.get(p.id), r = fedRatingOrDefault(row);
    // Немає рядка → стартовий ELO федерації.
    const elo = row ? r.elo : settings.startElo;
    return { ...p, eloFederation: elo, federationMatchCount: r.matchCount, level: levelOf(settings, elo) }; })
    .sort((a, b) => b.eloFederation - a.eloFederation || a.id.localeCompare(b.id));
}
const field = z.string().trim().max(80).nullable().optional();
export const profileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(), gender: z.enum(['MALE', 'FEMALE', 'OTHER']).nullable().optional(),
  avatarUrl: z.string().url().max(1000).refine(s => s.startsWith('https://')).nullable().optional(),
  bio: z.string().trim().max(500).nullable().optional(), skillLevel: field, ageCategory: field,
  publicProfile: z.boolean().optional(),
});
export const membershipSchema = z.object({ group: field, category: field, title: field, status: field,
  achievements: z.array(z.string().trim().min(1).max(120)).max(20).optional(), active: z.boolean().optional() });

// Provisioning is operator-only; there is no public federation self-registration.
federationProvisionRouter.post('/federations', requirePlatformAuth, async (req, res) => {
  const p = z.object({ name: z.string().trim().min(1).max(120), code: z.string().regex(/^[a-z0-9-]{2,40}$/),
    email: z.email().transform(s => s.toLowerCase()), accountName: z.string().trim().min(1).max(80),
    password: z.string().min(12).max(128), clubIds: z.array(uuid).max(100).default([]),
    sport: z.enum(SPORTS).default('SQUASH') }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  if (await prisma.federation.findUnique({ where: { code: p.data.code } }) ||
      await prisma.federationAccount.findUnique({ where: { email: p.data.email } })) return res.status(409).json({ error: 'ALREADY_EXISTS' });
  if (await prisma.club.count({ where: { id: { in: [...new Set(p.data.clubIds)] } } }) !== new Set(p.data.clubIds).size) {
    return res.status(400).json({ error: 'BAD_CLUB' });
  }
  const hash = await hashPassword(p.data.password);
  try {
    const f = await prisma.federation.create({ data: { name: p.data.name, code: p.data.code, sport: p.data.sport,
      accounts: { create: { name: p.data.accountName, email: p.data.email, passwordHash: hash } },
      partnerships: { create: [...new Set(p.data.clubIds)].map(clubId => ({ clubId, status: 'CONFIRMED', confirmedAt: new Date(), confirmedBy: req.platformAuth!.email })) },
    }, select: { id: true, name: true, code: true, sport: true } });
    return res.status(201).json(f);
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'ALREADY_EXISTS' });
    throw e;
  }
});
federationProvisionRouter.put('/federations/:id/clubs/:clubId', requirePlatformAuth, async (req, res) => {
  const p = z.object({ status: z.enum(['CONFIRMED', 'REVOKED']) }).safeParse(req.body);
  const federationId = param(req, 'id'), clubId = param(req, 'clubId');
  if (!p.success || !uuid.safeParse(federationId).success || !uuid.safeParse(clubId).success) return res.status(400).json({ error: 'BAD_REQUEST' });
  if (!await prisma.federation.findUnique({ where: { id: federationId } }) || !await prisma.club.findUnique({ where: { id: clubId } })) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(await prisma.clubFederation.upsert({ where: { clubId_federationId: { clubId, federationId } },
    create: { clubId, federationId, status: p.data.status, confirmedAt: new Date(), confirmedBy: req.platformAuth!.email },
    update: { status: p.data.status, confirmedAt: new Date(), confirmedBy: req.platformAuth!.email } }));
});

federationRouter.post('/login', loginLimiter, async (req, res) => {
  const p = z.object({ email: z.email().transform(s => s.toLowerCase()), password: z.string().min(1).max(128) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const a = await prisma.federationAccount.findUnique({ where: { email: p.data.email } });
  if (!a?.active) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  if (a.lockedUntil && a.lockedUntil > new Date()) return res.status(429).json({ error: 'ACCOUNT_LOCKED' });
  if (!await comparePassword(p.data.password, a.passwordHash)) {
    const fails = a.loginFails + 1;
    await prisma.federationAccount.update({ where: { id: a.id }, data: { loginFails: fails, lockedUntil: fails >= 5 ? new Date(Date.now() + 15 * 60_000) : null } });
    return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }
  await prisma.federationAccount.update({ where: { id: a.id }, data: { loginFails: 0, lockedUntil: null } });
  res.json({ token: signFederationToken(a), name: a.name });
});
federationRouter.use(requireFederationAuth);
federationRouter.get('/me', async (req, res) => {
  const { ratingSettings, ...f } = await prisma.federation.findUniqueOrThrow({ where: { id: req.federationAuth!.federationId },
    select: { id: true, name: true, code: true, logoUrl: true, sport: true, ratingSettings: true } });
  res.json({ ...f, ratingSettings: resolveRatingSettings(ratingSettings) });
});
// Налаштування ELO федерації. Діють лише на майбутні підрахунки; вже нараховане не перераховується.
federationRouter.get('/rating-settings', async (req, res) => {
  const f = await prisma.federation.findUniqueOrThrow({ where: { id: req.federationAuth!.federationId }, select: { ratingSettings: true } });
  res.json(resolveRatingSettings(f.ratingSettings));
});
federationRouter.get('/rating-settings/defaults', (_req, res) => { res.json(DEFAULT_RATING_SETTINGS); });
federationRouter.put('/rating-settings', writeLimiter, async (req, res) => {
  const p = ratingSettingsSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'BAD_REQUEST', details: p.error.flatten() });
  const federationId = req.federationAuth!.federationId;
  const before = resolveRatingSettings((await prisma.federation.findUniqueOrThrow({ where: { id: federationId }, select: { ratingSettings: true } })).ratingSettings);
  const changed = JSON.stringify(before) !== JSON.stringify(p.data);
  await prisma.$transaction([
    prisma.federation.update({ where: { id: federationId }, data: { ratingSettings: p.data } }),
    ...(changed ? [prisma.federationSettingsLog.create({ data: { federationId, field: 'ratingSettings', before, after: p.data, actorEmail: req.federationAuth!.email } })] : []),
  ]);
  res.json(p.data);
});
federationRouter.get('/clubs', async (req, res) => {
  const links = await prisma.clubFederation.findMany({ where: { federationId: req.federationAuth!.federationId, status: 'CONFIRMED' },
    include: { club: { select: { id: true, name: true, slug: true, address: true, clubRatingRules: true, sports: true,
      courts: { select: { id: true, name: true } } } } } });
  res.json(links.map(l => l.club));
});
federationRouter.get('/players', async (req, res) => {
  const f = req.federationAuth!.federationId, sport = await federationSportOf(f);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  // Список і рейтинг — лише свого виду спорту: ELO з FederationPlayerRating цієї федерації.
  const players = await prisma.player.findMany({ where: { AND: [affiliation(f, sport), q ? { name: { contains: q, mode: 'insensitive' } } : {}] },
    select: { ...playerFieldsFor(sport), phone: true }, orderBy: { id: 'asc' }, take: 1000 });
  res.json(await withFederationElo(f, players));
});
federationRouter.patch('/players/:id', async (req, res) => {
  const p = profileSchema.safeParse(req.body), id = param(req, 'id');
  if (!p.success || !uuid.safeParse(id).success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const sport = await federationSportOf(req.federationAuth!.federationId);
  if (!await prisma.player.findFirst({ where: { id, ...affiliation(req.federationAuth!.federationId, sport) }, select: { id: true } })) return res.status(404).json({ error: 'NOT_FOUND' });
  const upd = await prisma.player.update({ where: { id }, data: p.data, select: playerFieldsFor(sport) });
  res.json((await withFederationElo(req.federationAuth!.federationId, [upd]))[0]);
});

async function confirmedClub(federationId: string, clubId: string) {
  return prisma.clubFederation.findFirst({ where: { federationId, clubId, status: 'CONFIRMED' } });
}
federationRouter.get('/import/template', async (_req, res) => {
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('kort-players-template.xlsx').send(Buffer.from(await playerImportTemplate()));
});
// index.ts installs an authenticated raw parser before its general JSON parser.
federationRouter.post('/import/preview', writeLimiter, async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'XLSX_REQUIRED' });
    const result = await readPlayerWorkbook(req.body);
    res.json(result);
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
type ImportRow = ReturnType<typeof validateImportRows>['valid'][number];
// Shared by XLSX import and manual add. Runs inside a transaction under the advisory lock.
async function upsertFederationPlayers(tx: Prisma.TransactionClient, federationId: string, clubId: string | null, rows: ImportRow[], sport: Sport) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(6100617)`;
  let created = 0, linked = 0;
  const ids: string[] = [];
  // Batch-load existing rows once instead of 3 lookups per imported row (done under the advisory lock).
  const phones = rows.map(r => r.phone);
  const playersByPhone = new Map((await tx.player.findMany({ where: { phone: { in: phones } } })).map(pl => [pl.phone, pl]));
  const memberIds = clubId ? new Set((await tx.clubPlayerRating.findMany({ where: { clubId, sport, player: { phone: { in: phones } } },
    select: { playerId: true } })).map(m => m.playerId)) : new Set<string>();
  const customersByPhone = clubId ? new Map((await tx.customer.findMany({ where: { clubId, phone: { in: phones } } })).map(c => [c.phone, c])) : new Map();
  for (const r of rows) {
    let player = playersByPhone.get(r.phone) ?? null;
    if (!player) {
      player = await tx.player.create({ data: { name: r.name, phone: r.phone, federationId,
        gender: r.gender, birthDate: r.birthDate ? new Date(`${r.birthDate}T00:00:00Z`) : null,
        skillLevel: r.skillLevel, ageCategory: r.ageCategory } });
      created++;
    } else if (!clubId) {
      // Federation-only mode: never steal a player of another federation; stamp an unaffiliated one.
      if (player.federationId && player.federationId !== federationId) throw new Error('PLAYER_LINK_CONFLICT');
      if (!player.federationId) { player = await tx.player.update({ where: { id: player.id }, data: { federationId } }); linked++; }
    }
    ids.push(player.id);
    if (!clubId) continue;
    // Re-import never overwrites an existing identity, score or club achievements.
    if (!memberIds.has(player.id)) {
      await tx.clubPlayerRating.create({ data: { clubId, playerId: player.id, sport, group: r.group, category: r.category } });
      linked++;
    }
    const phone = normalizePhone(r.phone)!;
    const customer = customersByPhone.get(r.phone);
    if (customer?.playerId && customer.playerId !== player.id) throw new Error('PLAYER_LINK_CONFLICT');
    if (customer) await tx.customer.update({ where: { id: customer.id }, data: { playerId: player.id } });
    else await tx.customer.create({ data: { clubId, name: player.name, phone: r.phone, phoneTail: phone.tail, playerId: player.id } });
  }
  return { created, linked, processed: rows.length, ids };
}
federationRouter.post('/import', writeLimiter, async (req, res) => {
  const p = z.object({ clubId: uuid.nullish(), rows: z.array(importPlayerSchema).min(1).max(1000) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const federationId = req.federationAuth!.federationId, clubId = p.data.clubId ?? null;
  if (clubId && !await confirmedClub(federationId, clubId)) return res.status(403).json({ error: 'CLUB_NOT_IN_FEDERATION' });
  const result = validateImportRows(p.data.rows);
  if (result.errors.length) return res.status(400).json({ error: 'IMPORT_ERRORS', errors: result.errors });
  const sport = await federationSportOf(federationId);
  const { created, linked, processed } = await prisma.$transaction(tx => upsertFederationPlayers(tx, federationId, clubId, result.valid, sport), { timeout: 60_000 });
  res.json({ created, linked, processed });
});
const addPlayerSchema = z.object({ name: z.string().trim().min(1).max(80), phone: z.string().min(1).max(40),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(), ageCategory: z.string().trim().max(80).optional(),
  skillLevel: z.string().trim().max(80).optional(), clubId: uuid.nullish() });
federationRouter.post('/players', writeLimiter, async (req, res) => {
  const p = addPlayerSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const federationId = req.federationAuth!.federationId, clubId = p.data.clubId ?? null;
  if (clubId && !await confirmedClub(federationId, clubId)) return res.status(403).json({ error: 'CLUB_NOT_IN_FEDERATION' });
  const { clubId: _c, ...row } = p.data;
  const result = validateImportRows([row]);
  if (result.errors.length) return res.status(400).json({ error: result.errors[0].error === 'INVALID_PHONE' ? 'INVALID_PHONE' : 'BAD_REQUEST' });
  const sport = await federationSportOf(federationId);
  const out = await prisma.$transaction(tx => upsertFederationPlayers(tx, federationId, clubId, result.valid, sport), { timeout: 30_000 });
  const added = await prisma.player.findUniqueOrThrow({ where: { id: out.ids[0] }, select: { ...playerFieldsFor(sport), phone: true } });
  res.status(out.created ? 201 : 200).json((await withFederationElo(federationId, [added]))[0]);
});

const tournamentFields = { id: true, title: true, clubId: true, courtId: true, startTime: true, endTime: true,
  capacity: true, tournamentScope: true, tournamentRated: true, tournamentStatus: true, ratingsAppliedAt: true,
  tournamentGender: true, tournamentCategory: true, tournamentAgeCategory: true, tournamentDescription: true,
  federationCode: true, tournamentSport: true, tournamentTeamSize: true, tournamentSetsToWin: true, tournamentSettings: true, club: { select: { name: true, slug: true } }, court: { select: { name: true } },
  _count: { select: { tournamentEntries: true } },
} as const;
federationRouter.get('/tournaments', async (req, res) => {
  res.json(await prisma.booking.findMany({ where: { federationId: req.federationAuth!.federationId, tournamentScope: 'FEDERATION', status: { not: 'CANCELLED' }, AND: [notExpiredTournament()] },
    select: tournamentFields, orderBy: { startTime: 'asc' }, take: 500 }));
});
const tournamentSchema = z.object({ title: z.string().trim().min(1).max(70), clubId: uuid, courtId: uuid,
  start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }),
  capacity: z.number().int().min(2).max(64), code: z.string().trim().min(1).max(40).optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).nullable().optional(), category: field, ageCategory: field,
  description: z.string().trim().max(2000).optional(),
  sport: z.enum(SPORTS).nullish(), teamSize: z.union([z.literal(1), z.literal(2)]).optional(),
  setsToWin: z.number().int().min(1).max(3).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
}).refine(p => new Date(p.end) > new Date(p.start) && new Date(p.end).getTime() - new Date(p.start).getTime() <= 7 * 86400000, 'Invalid time range');
// Живе табло: після успішного запису штовхаємо глядачів.
federationRouter.use('/tournaments', notifyOnWrite());
federationRouter.post('/tournaments', async (req, res) => {
  const p = tournamentSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'BAD_REQUEST', details: p.error.flatten() });
  const d = p.data, federationId = req.federationAuth!.federationId;
  if (!await confirmedClub(federationId, d.clubId)) return res.status(403).json({ error: 'CLUB_NOT_IN_FEDERATION' });
  if (!await prisma.court.findFirst({ where: { id: d.courtId, clubId: d.clubId } })) return res.status(400).json({ error: 'BAD_COURT' });
  if (await prisma.booking.findFirst({ where: { courtId: d.courtId, status: { in: ['PENDING', 'CONFIRMED'] },
    startTime: { lt: new Date(d.end) }, endTime: { gt: new Date(d.start) } }, select: { id: true } })) return res.status(409).json({ error: 'SLOT_TAKEN' });
  // Спорт турніру = спорт федерації; поле зі запиту лише перевіряється.
  const fedSport = await federationSportOf(federationId);
  if (d.sport && d.sport !== fedSport) return res.status(400).json({ error: 'SPORT_MISMATCH' });
  const teamSize0 = d.teamSize ?? defaultTeamSize(fedSport);
  const hostClub = await prisma.club.findUnique({ where: { id: d.clubId }, select: { sports: true, defaultSetsToWin: true } });
  const clubSports = hostClub?.sports ?? [];
  const sErr = sportError(fedSport, teamSize0, clubSports);
  if (sErr) return res.status(400).json({ error: sErr });
  const built = buildTournamentSettings(fedSport, { settings: d.settings, teamSize: d.teamSize, setsToWin: d.setsToWin ?? hostClub?.defaultSetsToWin ?? 3 });
  if (!built.ok) return res.status(400).json({ error: built.error });
  const teamSize = built.teamSize;
  const setsToWin = built.setsToWin;
  try {
    res.status(201).json(await prisma.booking.create({ data: { clubId: d.clubId, courtId: d.courtId,
      title: tournamentTitle(d.title), capacity: d.capacity, startTime: new Date(d.start), endTime: new Date(d.end),
      tournamentScope: 'FEDERATION', federationId, federationCode: d.code, tournamentStatus: 'DRAFT', tournamentFormat: 'SINGLE_ELIM',
      tournamentGender: d.gender, tournamentCategory: d.category, tournamentAgeCategory: d.ageCategory,
      tournamentDescription: d.description, tournamentSport: fedSport, tournamentTeamSize: teamSize, tournamentSetsToWin: setsToWin, ...(built.settings ? { tournamentSettings: built.settings } : {}), status: 'CONFIRMED', source: 'ADMIN', priceTotal: 0, pricePerSeat: 0,
      createdBy: req.federationAuth!.email, confirmedBy: req.federationAuth!.email, confirmedAt: new Date(),
    }, select: tournamentFields }));
  } catch (e) {
    if (isSlotTakenError(e)) return res.status(409).json({ error: 'SLOT_TAKEN' });
    if ((e as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'CODE_EXISTS' });
    throw e;
  }
});
federationRouter.patch('/tournaments/:id/settings', async (req, res) => {
  const p = z.object({ settings: z.record(z.string(), z.unknown()) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const b = await ownTournament(req.federationAuth!.federationId, param(req, 'id'));
  if (!b) return res.status(404).json({ error: 'NOT_FOUND' });
  if (b.tournamentStatus !== 'DRAFT') return res.status(409).json({ error: 'NOT_DRAFT' });
  const built = buildTournamentSettings(b.tournamentSport, { settings: p.data.settings });
  if (!built.ok || !built.settings) return res.status(400).json({ error: built.ok ? 'SPORT_REQUIRED' : built.error });
  const upd = await prisma.booking.updateMany({ where: { id: b.id, federationId: req.federationAuth!.federationId, tournamentStatus: 'DRAFT' },
    data: { tournamentSettings: built.settings, tournamentTeamSize: built.teamSize, tournamentSetsToWin: built.setsToWin } });
  if (!upd.count) return res.status(409).json({ error: 'NOT_DRAFT' });
  res.json({ settings: built.settings, teamSize: built.teamSize, setsToWin: built.setsToWin });
});
async function ownTournament(federationId: string, id: string) {
  if (!uuid.safeParse(id).success) return null;
  return prisma.booking.findFirst({ where: { id, federationId, tournamentScope: 'FEDERATION', status: { not: 'CANCELLED' } },
    include: { tournamentEntries: { orderBy: { seed: 'asc' } }, tournamentMatches: { orderBy: [{ round: 'asc' }, { slot: 'asc' }] } } });
}
federationRouter.get('/tournaments/:id', async (req, res) => {
  const b = await ownTournament(req.federationAuth!.federationId, param(req, 'id'));
  if (!b) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ tournament: b, entries: b.tournamentEntries, matches: b.tournamentMatches, results: await tournamentResults(prisma, b) });
});
const teamSchema = z.object({ playerId: uuid, partnerPlayerId: uuid });
federationRouter.put('/tournaments/:id/entries', async (req, res) => {
  const p = z.object({ playerIds: z.array(uuid).min(2).max(64).optional(), teams: z.array(teamSchema).min(2).max(64).optional(),
    seedByRating: z.boolean().default(true) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const b = await ownTournament(req.federationAuth!.federationId, param(req, 'id'));
  if (!b) return res.status(404).json({ error: 'NOT_FOUND' });
  const doubles = b.tournamentTeamSize === 2;
  // Одиночний турнір — playerIds, парний — teams; змішувати не можна.
  if (doubles ? !p.data.teams || !!p.data.playerIds : !p.data.playerIds || !!p.data.teams) return res.status(400).json({ error: doubles ? 'TEAMS_REQUIRED' : 'BAD_REQUEST' });
  const teams = doubles ? p.data.teams! : p.data.playerIds!.map(playerId => ({ playerId, partnerPlayerId: null as string | null }));
  const allIds = teams.flatMap(t => (t.partnerPlayerId ? [t.playerId, t.partnerPlayerId] : [t.playerId]));
  if (new Set(allIds).size !== allIds.length) return res.status(400).json({ error: doubles ? 'DUPLICATE_PLAYER' : 'BAD_REQUEST' });
  if (b.tournamentStatus !== 'DRAFT' || teams.length > b.capacity!) return res.status(409).json({ error: 'TOURNAMENT_LOCKED_OR_FULL' });
  const fedSport = await federationSportOf(req.federationAuth!.federationId);
  const players = await prisma.player.findMany({ where: { AND: [{ id: { in: allIds } }, affiliation(req.federationAuth!.federationId, fedSport)] } });
  if (players.length !== allIds.length) return res.status(400).json({ error: 'BAD_PLAYER' });
  const categoryOk = b.tournamentCategory ? new Set((await prisma.clubPlayerRating.findMany({ where: { playerId: { in: players.map(pl => pl.id) }, active: true, sport: fedSport, category: b.tournamentCategory,
    club: { federationPartnerships: { some: { federationId: req.federationAuth!.federationId, status: 'CONFIRMED' } } } }, select: { playerId: true } })).map(m => m.playerId)) : null;
  for (const player of players) {
    if (b.tournamentGender && player.gender !== b.tournamentGender) return res.status(400).json({ error: 'GENDER_MISMATCH' });
    if (b.tournamentAgeCategory && player.ageCategory !== b.tournamentAgeCategory) return res.status(400).json({ error: 'AGE_CATEGORY_MISMATCH' });
    if (categoryOk && !categoryOk.has(player.id)) return res.status(400).json({ error: 'CATEGORY_MISMATCH' });
  }
  const rated = await withFederationElo(req.federationAuth!.federationId, players);
  const byId = new Map(rated.map(pl => [pl.id, pl]));
  // Рейтинг учасника: гравця або середній ELO пари; назва пари — «A / B».
  const rows = teams.map(t => {
    const a = byId.get(t.playerId)!, c = t.partnerPlayerId ? byId.get(t.partnerPlayerId)! : null;
    return { playerId: a.id, partnerPlayerId: c?.id ?? null, name: c ? `${a.name} / ${c.name}`.slice(0, 80) : a.name,
      elo: c ? (a.eloFederation + c.eloFederation) / 2 : a.eloFederation };
  });
  const sorted = p.data.seedByRating ? rows.sort((a, c) => c.elo - a.elo || a.playerId.localeCompare(c.playerId)) : rows;
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${b.id}::uuid FOR UPDATE`;
    const fresh = await tx.booking.findUniqueOrThrow({ where: { id: b.id } });
    if (fresh.tournamentStatus !== 'DRAFT') throw new RatingError('TOURNAMENT_LOCKED');
    await tx.tournamentEntry.deleteMany({ where: { bookingId: b.id } });
    await tx.tournamentEntry.createMany({ data: sorted.map((r, i) => ({ bookingId: b.id, clubId: b.clubId, playerId: r.playerId,
      partnerPlayerId: r.partnerPlayerId, name: r.name, seed: i + 1 })) });
  });
  res.json({ ok: true });
});
federationRouter.post('/tournaments/:id/start', async (req, res) => {
  const b = await ownTournament(req.federationAuth!.federationId, param(req, 'id'));
  if (!b) return res.status(404).json({ error: 'NOT_FOUND' });
  try {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${b.id}::uuid FOR UPDATE`;
      const fresh = await tx.booking.findUniqueOrThrow({ where: { id: b.id }, include: { tournamentEntries: { orderBy: { seed: 'asc' } } } });
      if (fresh.tournamentStatus !== 'DRAFT') throw new RatingError('TOURNAMENT_LOCKED');
      if (fresh.tournamentEntries.length < 2 || fresh.tournamentEntries.some(e => !e.playerId)) throw new RatingError('PLAYERS_REQUIRED');
      if (fresh.tournamentTeamSize === 2 && fresh.tournamentEntries.some(e => !e.partnerPlayerId)) throw new RatingError('PARTNER_REQUIRED');
      const third = req.body?.thirdPlace === true && fresh.tournamentEntries.length >= 4;
      const matches = buildBracket(fresh.tournamentEntries.map(e => e.id), third);
      await tx.tournamentMatch.createMany({ data: matches.map(m => ({ ...m, sets: m.sets, bookingId: b.id, clubId: b.clubId })) });
      await tx.booking.update({ where: { id: b.id }, data: { tournamentStatus: 'RUNNING', thirdPlace: third } });
    });
    res.json({ ok: true });
  } catch (e) { if (e instanceof RatingError) return res.status(409).json({ error: e.message }); throw e; }
});
federationRouter.post('/tournaments/:id/finish', async (req, res) => {
  const b = await ownTournament(req.federationAuth!.federationId, param(req, 'id'));
  if (!b) return res.status(404).json({ error: 'NOT_FOUND' });
  try { res.json(await prisma.$transaction(tx => finalizeTournament(tx, b.id, req.federationAuth!.email), { timeout: 30_000 })); }
  catch (e) { if (e instanceof RatingError) return res.status(409).json({ error: e.message }); throw e; }
});
federationRouter.post('/tournaments/:id/withdraw/:entryId', async (req, res) => {
  const b = await ownTournament(req.federationAuth!.federationId, param(req, 'id'));
  if (!b) return res.status(404).json({ error: 'NOT_FOUND' });
  const entryId = param(req, 'entryId');
  if (!uuid.safeParse(entryId).success) return res.status(400).json({ error: 'BAD_REQUEST' });
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${b.id}::uuid FOR UPDATE`;
    const fresh = await tx.booking.findUniqueOrThrow({ where: { id: b.id } });
    if (fresh.tournamentStatus !== 'RUNNING' || fresh.ratingsAppliedAt) throw new RatingError('TOURNAMENT_LOCKED');
    const entries = await tx.tournamentEntry.findMany({ where: { bookingId: b.id } });
    const e = entries.find(e => e.id === entryId);
    if (!e || e.withdrawnAt) throw new RatingError('BAD_PLAYER');
    await tx.tournamentEntry.update({ where: { id: e.id }, data: { withdrawnAt: new Date() } });
    const out = new Set(entries.filter(e => e.withdrawnAt || e.id === entryId).map(e => e.id));
    const rows = await tx.tournamentMatch.findMany({ where: { bookingId: b.id } });
    const changes = sweepWalkovers(rows.map(m => ({ ...m, sets: m.sets as SetScore[] })), out, fresh.thirdPlace);
    for (const m of changes) await tx.tournamentMatch.update({ where: { id: m.id }, data: { entryAId: m.entryAId, entryBId: m.entryBId,
      winnerEntryId: m.winnerEntryId, status: m.status, finishedAt: ['DONE', 'WALKOVER', 'RETIRED'].includes(m.status) ? new Date() : null,
      updatedBy: req.federationAuth!.email, version: { increment: 1 } } });
  });
  res.json({ ok: true });
});
federationRouter.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof RatingError || (err instanceof Error && err.message === 'PLAYER_LINK_CONFLICT')) return res.status(409).json({ error: (err as Error).message });
  next(err);
});
// Deliberately no federation endpoint for entering scores: host OWNER/ADMIN only.

export const federationRawParser = [requireFederationAuth, express.raw({ type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', limit: '2mb' })];
