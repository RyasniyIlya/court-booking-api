import { z } from 'zod';

import { prisma } from '../../db';
import { isTournament, TOURNAMENT_PREFIX } from '../../tournamentPay';
import { RatingError } from '../../tournamentRating';
import { startTournamentBracket } from '../../tournamentStart';
import { ActionFailedError, ActionInvalidError, registerExecutor } from '../actions';
import { clubTimezone, fmtRange, parsePayload, resolveActor, uuid } from './common';

/**
 * Виконавець scope `tournaments`: зібрати сітку турніру.
 *
 * Той самий startTournamentBracket, що стоїть за кнопкою «Старт» у кабінеті:
 * статус DRAFT, ≥ 2 учасників, у рейтинговому турнірі всі привʼязані до гравців,
 * пари повні. `seeding`: keep — порядок складу як є, shuffle — жеребкування.
 * Після старту склад не змінюється, тому це дія «з підтвердженням» за замовчуванням.
 */

export const bracketSchema = z.object({
  tournamentId: uuid,
  seeding: z.enum(['keep', 'shuffle']).default('keep'),
  thirdPlace: z.boolean().default(false),
}).strict();

/** Код помилки старту → текст; ті самі коди повертає кнопка в кабінеті. */
const START_ERRORS: Record<string, string> = {
  ALREADY_STARTED: 'Сітку вже зібрано.',
  NO_ENTRIES: 'У турнірі ще немає складу учасників.',
  TOO_FEW_ENTRIES: 'Для сітки потрібно щонайменше двоє учасників.',
  PLAYERS_REQUIRED: 'Не всі учасники привʼязані до гравців клубу.',
  PARTNER_REQUIRED: 'У парному турнірі не в усіх є партнер.',
  FEDERATION_MANAGES_ENTRIES: 'Федераційними турнірами керує федерація.',
};

async function loadTournament(clubId: string, id: string) {
  const b = await prisma.booking.findFirst({
    where: { id, clubId },
    select: {
      id: true, title: true, capacity: true, status: true, startTime: true, endTime: true, thirdPlace: true,
      tournamentScope: true, tournamentStatus: true, tournamentTeamSize: true,
      _count: { select: { tournamentEntries: true } },
    },
  });
  return b && isTournament(b) ? b : null;
}
type Loaded = NonNullable<Awaited<ReturnType<typeof loadTournament>>>;

const cleanTitle = (t: string | null) => (t ?? 'Турнір').replace(TOURNAMENT_PREFIX, '').trim();

function problemOf(b: Loaded | null): string | null {
  if (!b) return 'Турнір не знайдено.';
  if (b.status === 'CANCELLED' || b.status === 'EXPIRED') return 'Турнір скасовано.';
  if (b.tournamentScope === 'FEDERATION') return START_ERRORS.FEDERATION_MANAGES_ENTRIES;
  if (b.tournamentStatus === 'RUNNING' || b.tournamentStatus === 'FINISHED') return START_ERRORS.ALREADY_STARTED;
  if (b._count.tournamentEntries < 2) return START_ERRORS.TOO_FEW_ENTRIES;
  return null;
}

registerExecutor('tournament.buildBracket', {
  scope: 'tournaments',
  async prepare(clubId, raw) {
    const p = parsePayload(bracketSchema, raw, 'Сітка турніру');
    const b = await loadTournament(clubId, p.tournamentId);
    const problem = problemOf(b);
    if (problem) throw new ActionInvalidError(problem);
    const tz = await clubTimezone(clubId);
    const n = b!._count.tournamentEntries;
    const extras = [p.seeding === 'shuffle' ? 'жеребкування' : 'за порядком складу', p.thirdPlace && n >= 4 ? 'з матчем за 3 місце' : null];
    return {
      payload: p,
      summary: `Сітка турніру «${cleanTitle(b!.title)}» (${fmtRange(b!.startTime, b!.endTime, tz)}): ${n} учасн., ${extras.filter(Boolean).join(', ')}`,
    };
  },
  async execute(clubId, raw, ctx) {
    const p = parsePayload(bracketSchema, raw, 'Сітка турніру');
    const actor = await resolveActor(clubId, ctx);
    const b = await loadTournament(clubId, p.tournamentId);
    const problem = problemOf(b);
    if (problem) throw new ActionFailedError(problem);
    try {
      const out = await startTournamentBracket(
        b!, { thirdPlace: p.thirdPlace, shuffle: p.seeding === 'shuffle' },
        { clubId, userId: actor.userId },
        async (tx) => tx.tournamentMatch.count({ where: { bookingId: b!.id } }),
      );
      if (!out.ok) throw new ActionFailedError(START_ERRORS[out.error] ?? `Не вдалося зібрати сітку (${out.error}).`);
      return { tournamentId: b!.id, matches: out.value };
    } catch (e) {
      /* Блокування рейтингового турніру: хтось зачепив його між перевіркою й запуском. */
      if (e instanceof RatingError) throw new ActionFailedError('Турнір зараз заблоковано або вже змінився. Перевірте його в кабінеті.');
      throw e;
    }
  },
});
