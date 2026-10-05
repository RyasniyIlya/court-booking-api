import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { recordChanges, type Change } from '../../lib/changeLog';
import { isTournament } from '../../lib/tournamentPay';
import {
  applyPatches, buildBracket, isFinished, planPropagation, resolveMatchUpdate, sweepWalkovers,
  type BracketMatch, type MatchStatus, type SetScore,
} from '../../lib/tournamentBracket';
import { requireAuth, param } from './shared';

/**
 * Керування турніром: учасники, сітка, рахунок, зняття, завершення.
 *
 * Персонал (OWNER/ADMIN) може все; тренер бачить лише свій турнір
 * (trainerId) і вводить рахунок — ні склад, ні корти, ні час йому не
 * належать. Кожен матч має version: двоє на ресепшені не затруть один
 * одному рахунок мовчки, а побачать 409 і свіжий матч.
 */
export const tournamentsRouter = Router();

const TOURNAMENT = 'TOURNAMENT';
const MATCH_STATUSES = ['PENDING', 'SCHEDULED', 'LIVE', 'DONE', 'WALKOVER', 'RETIRED'] as const;

type Row = {
  id: string; round: number; slot: number;
  entryAId: string | null; entryBId: string | null;
  sets: unknown; winnerEntryId: string | null; status: MatchStatus;
  courtId: string | null; scheduledAt: Date | null; startedAt: Date | null; finishedAt: Date | null;
  note: string | null; version: number; updatedBy: string | null;
};

const matchDto = (m: Row) => ({
  id: m.id, round: m.round, slot: m.slot,
  entryAId: m.entryAId, entryBId: m.entryBId,
  sets: (m.sets as SetScore[]) ?? [],
  winnerEntryId: m.winnerEntryId, status: m.status,
  courtId: m.courtId, scheduledAt: m.scheduledAt, startedAt: m.startedAt, finishedAt: m.finishedAt,
  note: m.note, version: m.version,
});

const asBracket = (m: Row): BracketMatch => ({
  id: m.id, round: m.round, slot: m.slot, entryAId: m.entryAId, entryBId: m.entryBId,
  sets: (m.sets as SetScore[]) ?? [], winnerEntryId: m.winnerEntryId, status: m.status,
});

type Booking = {
  id: string; title: string | null; capacity: number | null; trainerId: string | null;
  tournamentStatus: 'DRAFT' | 'RUNNING' | 'FINISHED' | null; tournamentFormat: string | null;
  thirdPlace: boolean; startTime: Date; courtId: string;
};

const isStaff = (req: Request) => req.auth!.role === 'OWNER' || req.auth!.role === 'ADMIN';

/** Турнір клубу з токена + доступ: персонал або тренер цього турніру. */
async function loadBooking(
  req: Request, res: Response, opts: { staffOnly?: boolean; bookingId?: string } = {},
) {
  const booking = await prisma.booking.findFirst({
    where: { id: opts.bookingId ?? param(req, 'bookingId'), clubId: req.auth!.clubId },
    select: {
      id: true, title: true, capacity: true, trainerId: true, tournamentStatus: true,
      tournamentFormat: true, thirdPlace: true, startTime: true, courtId: true,
    },
  }) as Booking | null;
  if (!booking || !isTournament(booking)) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return null;
  }
  if (!isStaff(req)) {
    const own = req.auth!.role === 'TRAINER' && req.auth!.trainerId && booking.trainerId === req.auth!.trainerId;
    if (opts.staffOnly || !own) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return null;
    }
  }
  return booking;
}

type Db = typeof prisma;

async function payload(db: Db, booking: Booking) {
  const [entries, matches] = await Promise.all([
    db.tournamentEntry.findMany({ where: { bookingId: booking.id }, orderBy: { seed: 'asc' } }),
    db.tournamentMatch.findMany({ where: { bookingId: booking.id }, orderBy: [{ round: 'asc' }, { slot: 'asc' }] }),
  ]);
  return {
    tournament: {
      id: booking.id, title: booking.title, startTime: booking.startTime, courtId: booking.courtId,
      status: booking.tournamentStatus, format: booking.tournamentFormat, thirdPlace: booking.thirdPlace,
    },
    entries: entries.map((e) => ({
      id: e.id, name: e.name, seed: e.seed, seatId: e.seatId, customerId: e.customerId, withdrawnAt: e.withdrawnAt,
    })),
    matches: (matches as unknown as Row[]).map(matchDto),
  };
}

async function actorOf(req: Request) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: req.auth!.userId }, select: { email: true, role: true },
  });
  return { userId: req.auth!.userId, email: user.email, role: user.role ?? req.auth!.role };
}

const log = async (
  db: Pick<Db, 'changeLog'>, req: Request, bookingId: string, changes: Change[], reason?: string,
) => {
  const all = reason ? [...changes, { field: 'reason', before: null, after: reason }] : changes;
  await recordChanges(db, { clubId: req.auth!.clubId, entity: TOURNAMENT, entityId: bookingId }, await actorOf(req), all);
};

// ── GET ───────────────────────────────────────────────────────────────
tournamentsRouter.get('/tournaments/:bookingId', requireAuth, async (req, res) => {
  const booking = await loadBooking(req, res);
  if (!booking) return;
  res.set('Cache-Control', 'no-store');
  res.json(await payload(prisma, booking));
});

// ── Учасники ──────────────────────────────────────────────────────────
const entriesSchema = z.object({
  entries: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    seatId: z.string().uuid().nullish(),
    customerId: z.string().uuid().nullish(),
  })).max(64),
  shuffle: z.boolean().optional(),
});

tournamentsRouter.put('/tournaments/:bookingId/entries', requireAuth, async (req, res) => {
  const body = Array.isArray(req.body) ? { entries: req.body } : req.body;
  const parsed = entriesSchema.safeParse(body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const booking = await loadBooking(req, res, { staffOnly: true });
  if (!booking) return;
  if (booking.tournamentStatus === 'RUNNING' || booking.tournamentStatus === 'FINISHED') {
    return res.status(409).json({ error: booking.tournamentStatus === 'FINISHED' ? 'TOURNAMENT_FINISHED' : 'TOURNAMENT_LOCKED' });
  }

  const list = [...parsed.data.entries];
  if (parsed.data.shuffle) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }

  const seatIds = list.map((e) => e.seatId).filter((x): x is string => !!x);
  if (seatIds.length) {
    const seats = await prisma.bookingSeat.findMany({ where: { id: { in: seatIds }, bookingId: booking.id }, select: { id: true } });
    if (seats.length !== new Set(seatIds).size) return res.status(400).json({ error: 'BAD_SEAT' });
  }

  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.tournamentEntry.findMany({ where: { bookingId: booking.id }, orderBy: { seed: 'asc' }, select: { name: true } });
    await tx.tournamentEntry.deleteMany({ where: { bookingId: booking.id } });
    if (list.length) {
      await tx.tournamentEntry.createMany({
        data: list.map((e, i) => ({
          bookingId: booking.id, clubId: req.auth!.clubId, name: e.name, seed: i + 1,
          seatId: e.seatId ?? null, customerId: e.customerId ?? null,
        })),
      });
    }
    await tx.booking.update({
      where: { id: booking.id },
      data: { tournamentStatus: 'DRAFT', tournamentFormat: booking.tournamentFormat ?? 'SINGLE_ELIM' },
    });
    await log(tx as unknown as Db, req, booking.id, [{
      field: 'entries', before: before.map((e) => e.name), after: list.map((e) => e.name),
    }]);
    return payload(tx as unknown as Db, { ...booking, tournamentStatus: 'DRAFT' });
  });
  res.json(result);
});

// ── Старт ─────────────────────────────────────────────────────────────
tournamentsRouter.post('/tournaments/:bookingId/start', requireAuth, async (req, res) => {
  const parsed = z.object({ thirdPlace: z.boolean().optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const booking = await loadBooking(req, res, { staffOnly: true });
  if (!booking) return;
  if (booking.tournamentStatus !== 'DRAFT') {
    return res.status(409).json({ error: booking.tournamentStatus ? 'ALREADY_STARTED' : 'NO_ENTRIES' });
  }

  const entries = await prisma.tournamentEntry.findMany({ where: { bookingId: booking.id }, orderBy: { seed: 'asc' }, select: { id: true } });
  if (entries.length < 2) return res.status(400).json({ error: 'TOO_FEW_ENTRIES' });

  const thirdPlace = !!parsed.data.thirdPlace && entries.length >= 4;
  const matches = buildBracket(entries.map((e) => e.id), thirdPlace);
  const now = new Date();
  const by = (await actorOf(req)).email;

  const result = await prisma.$transaction(async (tx) => {
    await tx.tournamentMatch.createMany({
      data: matches.map((m) => ({
        id: m.id, bookingId: booking.id, clubId: req.auth!.clubId, round: m.round, slot: m.slot,
        entryAId: m.entryAId, entryBId: m.entryBId, sets: m.sets as never,
        winnerEntryId: m.winnerEntryId, status: m.status,
        finishedAt: m.status === 'DONE' ? now : null, updatedBy: by,
      })),
    });
    await tx.booking.update({
      where: { id: booking.id },
      data: { tournamentStatus: 'RUNNING', thirdPlace },
    });
    await log(tx as unknown as Db, req, booking.id, [
      { field: 'status', before: 'DRAFT', after: 'RUNNING' },
      { field: 'thirdPlace', before: booking.thirdPlace, after: thirdPlace },
    ]);
    return payload(tx as unknown as Db, { ...booking, tournamentStatus: 'RUNNING', thirdPlace });
  });
  res.json(result);
});

// ── Матч ──────────────────────────────────────────────────────────────
const patchSchema = z.object({
  version: z.number().int().min(0),
  sets: z.array(z.object({ a: z.number().int().min(0).max(99), b: z.number().int().min(0).max(99) })).max(5).optional(),
  winner: z.enum(['A', 'B']).nullable().optional(),
  status: z.enum(MATCH_STATUSES).optional(),
  courtId: z.string().uuid().nullable().optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  reason: z.string().trim().min(1).max(300).optional(),
  force: z.boolean().optional(),
});

tournamentsRouter.patch('/tournaments/matches/:id', requireAuth, async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  const id = z.string().uuid().safeParse(param(req, 'id'));
  if (!parsed.success || !id.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const body = parsed.data;

  const found = await prisma.tournamentMatch.findFirst({
    where: { id: id.data, clubId: req.auth!.clubId },
  }) as (Row & { bookingId: string }) | null;
  if (!found) return res.status(404).json({ error: 'NOT_FOUND' });

  const booking = await loadBooking(req, res, { bookingId: found.bookingId });
  if (!booking) return;
  if (!isStaff(req) && (body.courtId !== undefined || body.scheduledAt !== undefined || body.note !== undefined)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  if (booking.tournamentStatus === 'FINISHED') return res.status(409).json({ error: 'TOURNAMENT_FINISHED' });
  if (booking.tournamentStatus !== 'RUNNING') return res.status(409).json({ error: 'NOT_RUNNING' });

  if (body.courtId) {
    const court = await prisma.court.findFirst({ where: { id: body.courtId, clubId: req.auth!.clubId }, select: { id: true } });
    if (!court) return res.status(400).json({ error: 'BAD_COURT' });
  }

  const actor = await actorOf(req);

  const outcome = await prisma.$transaction(async (tx) => {
    const rows = await tx.tournamentMatch.findMany({ where: { bookingId: booking.id } }) as unknown as Row[];
    const entries = await tx.tournamentEntry.findMany({ where: { bookingId: booking.id }, select: { id: true, name: true } });
    const nameOf = (eid: string | null) => entries.find((e) => e.id === eid)?.name ?? null;
    const cur = rows.find((r) => r.id === found.id);
    if (!cur) return { status: 404 as const, body: { error: 'NOT_FOUND' } };
    if (cur.version !== body.version) {
      return { status: 409 as const, body: { error: 'VERSION_CONFLICT', match: matchDto(cur) } };
    }

    const resolved = resolveMatchUpdate(asBracket(cur), {
      sets: body.sets, winner: body.winner, status: body.status,
    });
    if (!resolved.ok) return { status: 400 as const, body: { error: resolved.error } };

    const winnerChanged = resolved.winnerEntryId !== cur.winnerEntryId;
    if (winnerChanged && cur.winnerEntryId && !body.reason) {
      return { status: 400 as const, body: { error: 'REASON_REQUIRED' } };
    }

    const loserId = resolved.winnerEntryId
      ? (resolved.winnerEntryId === cur.entryAId ? cur.entryBId : cur.entryAId)
      : null;
    const plan = winnerChanged
      ? planPropagation(rows.map(asBracket), cur.id, resolved.winnerEntryId, loserId, booking.thirdPlace)
      : { patches: [], played: [] as string[] };

    if (plan.played.length && !body.force) {
      return {
        status: 409 as const,
        body: { error: 'DOWNSTREAM_PLAYED', matches: rows.filter((r) => plan.played.includes(r.id)).map(matchDto) },
      };
    }

    const now = new Date();
    const data: Record<string, unknown> = {
      sets: resolved.sets as never,
      status: resolved.status,
      winnerEntryId: resolved.winnerEntryId,
      updatedBy: actor.email,
      version: { increment: 1 },
      startedAt: resolved.status === 'LIVE' && !cur.startedAt ? now : cur.startedAt,
      finishedAt: isFinished({ status: resolved.status }) ? (cur.finishedAt ?? now) : null,
    };
    if (body.courtId !== undefined) data.courtId = body.courtId;
    if (body.scheduledAt !== undefined) data.scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null;
    if (body.note !== undefined) data.note = body.note || null;

    // Оптимістична блокування: оновлюємо лише якщо version досі той самий.
    const upd = await tx.tournamentMatch.updateMany({
      where: { id: cur.id, version: body.version },
      data: data as never,
    });
    if (upd.count === 0) {
      const latest = await tx.tournamentMatch.findFirst({ where: { id: cur.id } }) as unknown as Row | null;
      return { status: 409 as const, body: { error: 'VERSION_CONFLICT', match: latest ? matchDto(latest) : null } };
    }

    const changes: Change[] = [];
    const snap = (m: { sets: unknown; status: string; winnerEntryId: string | null }) => ({
      sets: m.sets, status: m.status, winner: nameOf(m.winnerEntryId),
    });
    const label = (m: { round: number; slot: number }) => `match:${m.round}-${m.slot}`;
    const before = snap(cur);
    const after = snap({ sets: resolved.sets, status: resolved.status, winnerEntryId: resolved.winnerEntryId });
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ field: label(cur), before, after });

    for (const { id: tid, patch } of plan.patches) {
      const target = rows.find((r) => r.id === tid)!;
      const tdata: Record<string, unknown> = { updatedBy: actor.email, version: { increment: 1 } };
      if ('entryAId' in patch) tdata.entryAId = patch.entryAId ?? null;
      if ('entryBId' in patch) tdata.entryBId = patch.entryBId ?? null;
      if (patch.reset) Object.assign(tdata, { sets: [], winnerEntryId: null, status: 'PENDING', startedAt: null, finishedAt: null });
      await tx.tournamentMatch.update({ where: { id: tid }, data: tdata as never });
      if (patch.reset) {
        changes.push({ field: label(target), before: snap(target), after: { sets: [], status: 'PENDING', winner: null } });
      }
    }
    /* Прохід міг поставити проти знятого учасника — одразу WO, у цій самій транзакції. */
    const rowsNow = await tx.tournamentMatch.findMany({ where: { bookingId: booking.id } }) as unknown as Row[];
    const entriesNow = await tx.tournamentEntry.findMany({ where: { bookingId: booking.id } });
    const out = new Set(entriesNow.filter((e) => e.withdrawnAt).map((e) => e.id));
    if (out.size) {
      for (const m of sweepWalkovers(rowsNow.map(asBracket), out, booking.thirdPlace)) {
        const o = rowsNow.find((r) => r.id === m.id)!;
        await tx.tournamentMatch.update({
          where: { id: m.id },
          data: {
            entryAId: m.entryAId, entryBId: m.entryBId, winnerEntryId: m.winnerEntryId, status: m.status,
            finishedAt: isFinished(m) ? (o.finishedAt ?? now) : o.finishedAt,
            updatedBy: actor.email, version: { increment: 1 },
          } as never,
        });
        if (m.status !== o.status) {
          changes.push({
            field: label(m), before: { status: o.status },
            after: { status: m.status, winner: nameOf(m.winnerEntryId), auto: 'withdrawn' },
          });
        }
      }
    }
    if (changes.length || body.reason) await log(tx as unknown as Db, req, booking.id, changes, body.reason);

    const reloaded = await payload(tx as unknown as Db, booking);
    return { status: 200 as const, body: { ...reloaded, match: reloaded.matches.find((m) => m.id === cur.id) } };
  });

  res.status(outcome.status).json(outcome.body);
});

// ── Зняття учасника ───────────────────────────────────────────────────
tournamentsRouter.post('/tournaments/:bookingId/withdraw/:entryId', requireAuth, async (req, res) => {
  const entryId = z.string().uuid().safeParse(param(req, 'entryId'));
  if (!entryId.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const reason = z.string().trim().max(300).optional().safeParse(req.body?.reason);
  const booking = await loadBooking(req, res, { staffOnly: true });
  if (!booking) return;
  if (booking.tournamentStatus === 'FINISHED') return res.status(409).json({ error: 'TOURNAMENT_FINISHED' });
  if (booking.tournamentStatus !== 'RUNNING') return res.status(409).json({ error: 'NOT_RUNNING' });

  const result = await prisma.$transaction(async (tx) => {
    const entries = await tx.tournamentEntry.findMany({ where: { bookingId: booking.id } });
    const entry = entries.find((e) => e.id === entryId.data);
    if (!entry) return { status: 404 as const, body: { error: 'NOT_FOUND' } };
    if (entry.withdrawnAt) return { status: 409 as const, body: { error: 'ALREADY_WITHDRAWN' } };

    await tx.tournamentEntry.update({ where: { id: entry.id }, data: { withdrawnAt: new Date() } });
    const withdrawn = new Set(entries.filter((e) => e.withdrawnAt || e.id === entry.id).map((e) => e.id));
    const rows = await tx.tournamentMatch.findMany({ where: { bookingId: booking.id } }) as unknown as Row[];
    const changed = sweepWalkovers(rows.map(asBracket), withdrawn, booking.thirdPlace);
    const actor = await actorOf(req);
    const now = new Date();
    const changes: Change[] = [{ field: 'withdraw', before: null, after: entry.name }];
    for (const m of changed) {
      const o = rows.find((r) => r.id === m.id)!;
      await tx.tournamentMatch.update({
        where: { id: m.id },
        data: {
          entryAId: m.entryAId, entryBId: m.entryBId, winnerEntryId: m.winnerEntryId, status: m.status,
          finishedAt: isFinished(m) ? (o.finishedAt ?? now) : o.finishedAt,
          updatedBy: actor.email, version: { increment: 1 },
        } as never,
      });
      if (m.status !== o.status) {
        changes.push({
          field: `match:${m.round}-${m.slot}`,
          before: { status: o.status },
          after: { status: m.status, winner: entries.find((e) => e.id === m.winnerEntryId)?.name ?? null },
        });
      }
    }
    await log(tx as unknown as Db, req, booking.id, changes, reason.success ? reason.data || undefined : undefined);
    return { status: 200 as const, body: await payload(tx as unknown as Db, booking) };
  });
  res.status(result.status).json(result.body);
});

// ── Завершення / відновлення ──────────────────────────────────────────
tournamentsRouter.post('/tournaments/:bookingId/finish', requireAuth, async (req, res) => {
  const booking = await loadBooking(req, res, { staffOnly: true });
  if (!booking) return;
  if (booking.tournamentStatus === 'FINISHED') return res.status(409).json({ error: 'TOURNAMENT_FINISHED' });
  if (booking.tournamentStatus !== 'RUNNING') return res.status(409).json({ error: 'NOT_RUNNING' });
  const rows = await prisma.tournamentMatch.findMany({ where: { bookingId: booking.id } }) as unknown as Row[];
  const last = Math.max(0, ...rows.map((m) => m.round));
  const must = rows.filter((m) => m.round === last && (m.slot === 0 || (booking.thirdPlace && m.slot === 1)));
  if (must.length === 0 || must.some((m) => !isFinished(m))) {
    return res.status(409).json({ error: 'FINAL_NOT_PLAYED' });
  }
  const out = await prisma.$transaction(async (tx) => {
    await tx.booking.update({ where: { id: booking.id }, data: { tournamentStatus: 'FINISHED' } });
    await log(tx as unknown as Db, req, booking.id, [{ field: 'status', before: 'RUNNING', after: 'FINISHED' }]);
    return payload(tx as unknown as Db, { ...booking, tournamentStatus: 'FINISHED' });
  });
  res.json(out);
});

tournamentsRouter.post('/tournaments/:bookingId/reopen', requireAuth, async (req, res) => {
  if (req.auth!.role !== 'OWNER') return res.status(403).json({ error: 'FORBIDDEN' });
  const booking = await loadBooking(req, res, { staffOnly: true });
  if (!booking) return;
  if (booking.tournamentStatus !== 'FINISHED') return res.status(409).json({ error: 'NOT_FINISHED' });
  const out = await prisma.$transaction(async (tx) => {
    await tx.booking.update({ where: { id: booking.id }, data: { tournamentStatus: 'RUNNING' } });
    await log(tx as unknown as Db, req, booking.id, [{ field: 'status', before: 'FINISHED', after: 'RUNNING' }]);
    return payload(tx as unknown as Db, { ...booking, tournamentStatus: 'RUNNING' });
  });
  res.json(out);
});

// ── Скидання сітки ────────────────────────────────────────────────────
tournamentsRouter.delete('/tournaments/:bookingId/bracket', requireAuth, async (req, res) => {
  const reason = z.string().trim().min(1).max(300).optional().safeParse(req.body?.reason ?? req.query.reason);
  const booking = await loadBooking(req, res, { staffOnly: true });
  if (!booking) return;
  if (booking.tournamentStatus === 'FINISHED') return res.status(409).json({ error: 'TOURNAMENT_FINISHED' });
  if (booking.tournamentStatus !== 'RUNNING') return res.status(409).json({ error: 'NOT_RUNNING' });

  const out = await prisma.$transaction(async (tx) => {
    const rows = await tx.tournamentMatch.findMany({ where: { bookingId: booking.id } }) as unknown as Row[];
    // Bye (одного учасника немає) — не зіграний матч, його скидання нічого не губить.
    const played = rows.filter((m) => isFinished(m) && m.entryAId && m.entryBId);
    if (played.length) {
      if (req.auth!.role !== 'OWNER') return { status: 403 as const, body: { error: 'FORBIDDEN' } };
      if (!reason.success || !reason.data) return { status: 400 as const, body: { error: 'REASON_REQUIRED' } };
    }
    await tx.tournamentMatch.deleteMany({ where: { bookingId: booking.id } });
    await tx.tournamentEntry.updateMany({ where: { bookingId: booking.id }, data: { withdrawnAt: null } });
    await tx.booking.update({ where: { id: booking.id }, data: { tournamentStatus: 'DRAFT' } });
    await log(tx as unknown as Db, req, booking.id,
      [{ field: 'bracket', before: { matches: rows.length, played: played.length }, after: null }],
      reason.success ? reason.data : undefined);
    return { status: 200 as const, body: await payload(tx as unknown as Db, { ...booking, tournamentStatus: 'DRAFT' }) };
  });
  res.status(out.status).json(out.body);
});
