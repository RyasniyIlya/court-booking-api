import type { Request, RequestHandler } from 'express';
import { prisma } from './db';
import { isTournament } from './tournamentPay';

/* Живе табло турніру (SSE). Pub/sub — у пам'яті процесу: працює в межах одного
   інстанса API. Якщо інстансів кілька, подія дійде лише глядачам того, де
   відбувся запис; решта клієнтів лишається на поллінгу (веб це вміє сам). */

/** Публічний DTO табло: лише назви, час, корт, статус і сітка — без телефонів і службових id. */
export async function publicTournamentDto(id: string): Promise<Record<string, unknown> | null> {
  const booking = await prisma.booking.findUnique({
    where: { id },
    select: {
      id: true, title: true, capacity: true, startTime: true, status: true,
      tournamentStatus: true, thirdPlace: true, tournamentSport: true, tournamentTeamSize: true, tournamentSetsToWin: true, tournamentSettings: true,
      court: { select: { name: true } },
      club: { select: { name: true, brandColor: true } },
      tournamentEntries: { select: { id: true, name: true, seed: true }, orderBy: { seed: 'asc' } },
      tournamentMatches: {
        select: {
          round: true, slot: true, entryAId: true, entryBId: true, winnerEntryId: true,
          sets: true, status: true, scheduledAt: true, court: { select: { name: true } },
        },
        orderBy: [{ round: 'asc' }, { slot: 'asc' }],
      },
    },
  });
  if (!booking || !isTournament(booking) || booking.status === 'CANCELLED') return null;
  const nameOf = new Map(booking.tournamentEntries.map((e) => [e.id, e.name]));
  return {
    id: booking.id,
    title: booking.title,
    startTime: booking.startTime,
    court: booking.court,
    club: booking.club,
    status: booking.tournamentStatus,
    thirdPlace: booking.thirdPlace,
    sport: booking.tournamentSport,
    teamSize: booking.tournamentTeamSize,
    setsToWin: booking.tournamentSetsToWin,
    settings: booking.tournamentSettings ?? null,
    entries: booking.tournamentEntries.map((e) => ({ name: e.name, seed: e.seed })),
    matches: booking.tournamentMatches.map((m) => ({
      round: m.round,
      slot: m.slot,
      a: m.entryAId ? nameOf.get(m.entryAId) ?? null : null,
      b: m.entryBId ? nameOf.get(m.entryBId) ?? null : null,
      sets: m.sets,
      winner: m.winnerEntryId
        ? (m.winnerEntryId === m.entryAId ? 'A' : m.winnerEntryId === m.entryBId ? 'B' : null)
        : null,
      status: m.status,
      court: m.court?.name ?? null,
      scheduledAt: m.scheduledAt,
    })),
  };
}

type Listener = (json: string) => void;
const subs = new Map<string, Set<Listener>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
export const DEBOUNCE_MS = 50;

export function subscribe(id: string, fn: Listener): () => void {
  let set = subs.get(id);
  if (!set) subs.set(id, (set = new Set()));
  set.add(fn);
  return () => {
    const s = subs.get(id);
    if (!s) return;
    s.delete(fn);
    if (!s.size) subs.delete(id);
  };
}
export const subscriberCount = (id?: string) =>
  id ? subs.get(id)?.size ?? 0 : [...subs.values()].reduce((n, s) => n + s.size, 0);

/** Зміна турніру: збиваємо серію подій у одну, DTO будуємо раз і шлемо всім глядачам. Не кидає. */
export function notifyTournament(id: string): void {
  if (!subs.has(id) || timers.has(id)) return;
  timers.set(id, setTimeout(async () => {
    timers.delete(id);
    try {
      const set = subs.get(id);
      if (!set?.size) return;
      const dto = await publicTournamentDto(id);
      if (!dto) return;
      const json = JSON.stringify(dto);
      for (const fn of [...set]) { try { fn(json); } catch { /* мертвий клієнт прибере close */ } }
    } catch (e) { console.error('[tournamentLive] notify failed', e); }
  }, DEBOUNCE_MS));
}

/** Після будь-якого успішного запису під /tournaments/:id/... штовхаємо живе табло. */
export function notifyOnWrite(notify: (id: string) => void = notifyTournament): RequestHandler {
  return (req: Request, res, next) => {
    if (req.method !== 'GET' && req.method !== 'OPTIONS') {
      /* Шлях читаємо зараз: на 'finish' Express уже повертає повний URL без префікса монтування. */
      const first = req.path.split('/')[1];
      res.on('finish', () => {
        if (res.statusCode >= 400) return;
        const id = (res.locals.tournamentId as string | undefined) ?? first;
        if (id && /^[0-9a-f-]{36}$/i.test(id)) notify(id);
      });
    }
    next();
  };
}
