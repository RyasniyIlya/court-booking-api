import type { Prisma } from '@prisma/client';

import { prisma } from './db';
import { recordChanges } from './changeLog';
import { buildBracket } from './tournamentBracket';
import { RatingError } from './tournamentRating';

/**
 * Старт турніру: зібрати сітку з поточних учасників і перевести його в RUNNING.
 *
 * Жило всередині POST /api/admin/tournaments/:id/start. Винесено, щоб ІІ-менеджер
 * (`tournament.buildBracket`) запускав сітку тими самими перевірками, що й кнопка
 * в кабінеті: статус DRAFT, федерація керує складом сама, у рейтинговому турнірі
 * всі учасники привʼязані до гравців, пари повні, учасників ≥ 2.
 */

/** Рядок турніру, потрібний для старту; роут передає свій, ширший. */
export type StartableBooking = {
  id: string;
  tournamentScope?: 'CLUB' | 'INTERCLUB' | 'FEDERATION' | null;
  tournamentStatus: 'DRAFT' | 'RUNNING' | 'FINISHED' | null;
  tournamentTeamSize?: number;
  thirdPlace: boolean;
};

/**
 * Рейтингові турніри (з tournamentScope) блокуються рядком: рахунок і склад
 * не можуть змінитись під ногами, поки ми рахуємо сітку.
 */
export async function lockTournament(
  tx: Prisma.TransactionClient,
  booking: { id: string; tournamentScope?: string | null },
  status?: string,
) {
  if (!booking.tournamentScope) return;
  await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${booking.id}::uuid FOR UPDATE`;
  const fresh = await tx.booking.findUniqueOrThrow({ where: { id: booking.id } });
  if (fresh.ratingsAppliedAt) throw new RatingError('RATINGS_LOCKED');
  if (status && fresh.tournamentStatus !== status) throw new RatingError('TOURNAMENT_LOCKED');
  if (fresh.status === 'CANCELLED' || fresh.status === 'EXPIRED') throw new RatingError('TOURNAMENT_LOCKED');
}

export type StartResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** Fisher–Yates: рівномірне перемішування без зсуву. */
function shuffled<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * `after` викликається всередині транзакції зі свіжим станом турніру: роут
 * збирає з нього повну відповідь, виконавець ІІ — коротке резюме.
 *
 * `shuffle` — жеребкування: сіви перерозподіляються випадково (раніше це
 * робилось тільки при збереженні складу). Без нього порядок складу лишається.
 */
export async function startTournamentBracket<T>(
  booking: StartableBooking,
  opts: { thirdPlace?: boolean; shuffle?: boolean },
  actor: { clubId: string; userId: string },
  after: (tx: Prisma.TransactionClient, state: { tournamentStatus: 'RUNNING'; thirdPlace: boolean }) => Promise<T>,
): Promise<StartResult<T>> {
  if (booking.tournamentScope === 'FEDERATION') return { ok: false, status: 403, error: 'FEDERATION_MANAGES_ENTRIES' };
  if (booking.tournamentStatus !== 'DRAFT') {
    return { ok: false, status: 409, error: booking.tournamentStatus ? 'ALREADY_STARTED' : 'NO_ENTRIES' };
  }

  const entries = await prisma.tournamentEntry.findMany({ where: { bookingId: booking.id }, orderBy: { seed: 'asc' }, select: { id: true } });
  if (booking.tournamentScope) {
    const unlinked = await prisma.tournamentEntry.count({ where: { bookingId: booking.id, playerId: null } });
    if (unlinked) return { ok: false, status: 409, error: 'PLAYERS_REQUIRED' };
    if ((booking.tournamentTeamSize ?? 1) === 2 && await prisma.tournamentEntry.count({ where: { bookingId: booking.id, partnerPlayerId: null } })) {
      return { ok: false, status: 409, error: 'PARTNER_REQUIRED' };
    }
  }
  if (entries.length < 2) return { ok: false, status: 400, error: 'TOO_FEW_ENTRIES' };

  const thirdPlace = !!opts.thirdPlace && entries.length >= 4;
  const order = opts.shuffle ? shuffled(entries) : entries;
  const matches = buildBracket(order.map((e) => e.id), thirdPlace);
  const now = new Date();
  const who = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { email: true, role: true } });

  const value = await prisma.$transaction(async (tx) => {
    await lockTournament(tx, booking, 'DRAFT');
    if (opts.shuffle) {
      /* (bookingId, seed) унікальні: спершу відʼємні сіви, потім остаточні — інакше
         два рядки на мить мали б однаковий номер. */
      for (const [i, e] of order.entries()) await tx.tournamentEntry.update({ where: { id: e.id }, data: { seed: -(i + 1) } });
      for (const [i, e] of order.entries()) await tx.tournamentEntry.update({ where: { id: e.id }, data: { seed: i + 1 } });
    }
    await tx.tournamentMatch.createMany({
      data: matches.map((m) => ({
        id: m.id, bookingId: booking.id, clubId: actor.clubId, round: m.round, slot: m.slot,
        entryAId: m.entryAId, entryBId: m.entryBId, sets: m.sets as never,
        winnerEntryId: m.winnerEntryId, status: m.status,
        finishedAt: m.status === 'DONE' ? now : null, updatedBy: who.email,
      })),
    });
    await tx.booking.update({
      where: { id: booking.id },
      data: { tournamentStatus: 'RUNNING', thirdPlace },
    });
    await recordChanges(
      tx as unknown as Parameters<typeof recordChanges>[0],
      { clubId: actor.clubId, entity: 'TOURNAMENT', entityId: booking.id },
      { userId: actor.userId, email: who.email, role: who.role },
      [
        { field: 'status', before: 'DRAFT', after: 'RUNNING' },
        { field: 'thirdPlace', before: booking.thirdPlace, after: thirdPlace },
        ...(opts.shuffle ? [{ field: 'seeding', before: null, after: 'shuffle' }] : []),
      ],
    );
    return after(tx, { tournamentStatus: 'RUNNING', thirdPlace });
  });
  return { ok: true, value };
}
