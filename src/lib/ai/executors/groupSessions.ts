import { z } from 'zod';

import { prisma } from '../../db';
import { createAdminBooking, createBookingSchema, patchAdminBooking } from '../../adminBookings';
import { isTournament } from '../../tournamentPay';
import { ActionFailedError, ActionInvalidError, registerExecutor } from '../actions';
import {
  clubTimezone, fmtRange, isoOffset, parsePayload, resolveActor, slotProblem, uah, unwrapOutcome, uuid,
} from './common';

/**
 * Виконавці scope `groupSessions`: створити й скасувати групове заняття.
 *
 * Створення — та сама createAdminBooking, що й для людини (групове заняття —
 * бронь корту з capacity): корт займається один раз, тренер не може бути на
 * двох заняттях, тариф клубу має дозволяти групи (PLAN_REQUIRED). Ціна місця —
 * у копійках, як і скрізь у системі; у summary вона показана в гривнях.
 */

export const groupCreateSchema = z.object({
  courtId: uuid,
  start: isoOffset,
  end: isoOffset,
  title: z.string().trim().min(2).max(80),
  capacity: z.number().int().min(2).max(200),
  /** копійки за місце */
  pricePerSeat: z.number().int().min(0).max(100_000_000),
  trainerId: uuid.optional(),
}).strict();

export const groupCancelSchema = z.object({
  bookingId: uuid,
  reason: z.string().trim().min(1).max(200),
}).strict();

const ACTIVE = ['PENDING', 'CONFIRMED'] as const;

async function loadCourt(clubId: string, courtId: string) {
  return prisma.court.findFirst({ where: { id: courtId, clubId, isActive: true }, select: { id: true, name: true } });
}

async function loadTrainer(clubId: string, trainerId: string) {
  return prisma.trainer.findFirst({ where: { id: trainerId, clubId, isActive: true }, select: { id: true, name: true } });
}

async function loadGroup(clubId: string, bookingId: string) {
  return prisma.booking.findFirst({
    where: { id: bookingId, clubId },
    include: {
      court: { select: { name: true } },
      seats: { where: { status: { in: ['BOOKED', 'PENDING'] } }, select: { id: true } },
    },
  });
}
type LoadedGroup = Awaited<ReturnType<typeof loadGroup>>;

/**
 * Скасувати можна лише заняття без записаних: скасування групи у кабінеті не
 * повідомляє учасників і не повертає їм гроші, тож ІІ не лишає людей з оплаченим
 * місцем без заняття — це робить людина, яка може їм зателефонувати.
 */
function cancelProblem(b: LoadedGroup): string | null {
  if (!b) return 'Заняття не знайдено.';
  if (b.capacity === null || isTournament(b)) return 'Це не групове заняття (приватна бронь чи турнір).';
  if (!(ACTIVE as readonly string[]).includes(b.status)) return 'Заняття вже скасоване або завершене.';
  if (b.startTime.getTime() < Date.now()) return 'Заняття вже минуло.';
  if (b.seats.length > 0) {
    return `На заняття записано ${b.seats.length} учасн.: ІІ не скасовує такі заняття. Скасуйте його в кабінеті, щоб повідомити людей і повернути гроші.`;
  }
  return null;
}

registerExecutor('groupSession.create', {
  scope: 'groupSessions',
  async prepare(clubId, raw) {
    const p = parsePayload(groupCreateSchema, raw, 'Групове заняття');
    const court = await loadCourt(clubId, p.courtId);
    if (!court) throw new ActionInvalidError('Корт не знайдено в цьому клубі.');
    const trainer = p.trainerId ? await loadTrainer(clubId, p.trainerId) : null;
    if (p.trainerId && !trainer) throw new ActionInvalidError('Тренера не знайдено або він неактивний.');
    const start = new Date(p.start);
    const end = new Date(p.end);
    const tz = await clubTimezone(clubId);
    const problem = await slotProblem(clubId, court.id, start, end, tz);
    if (problem) throw new ActionInvalidError(problem);
    return {
      payload: p,
      summary: `Групове заняття «${p.title}»: ${court.name}, ${fmtRange(start, end, tz)}${trainer ? `, тренер ${trainer.name}` : ''}, ${p.capacity} місць по ${uah(p.pricePerSeat)}`,
    };
  },
  async execute(clubId, raw, ctx) {
    const p = parsePayload(groupCreateSchema, raw, 'Групове заняття');
    const actor = await resolveActor(clubId, ctx);
    const court = await loadCourt(clubId, p.courtId);
    if (!court) throw new ActionFailedError('Корт не знайдено або вимкнено.');
    const problem = await slotProblem(clubId, court.id, new Date(p.start), new Date(p.end), await clubTimezone(clubId));
    if (problem) throw new ActionFailedError(problem);

    const input = createBookingSchema.parse({
      courtId: court.id,
      start: p.start,
      end: p.end,
      capacity: p.capacity,
      title: p.title,
      pricePerSeat: p.pricePerSeat,
      trainerId: p.trainerId,
    });
    const body = unwrapOutcome(await createAdminBooking(input, actor)) as { id: string };
    return { bookingId: body.id };
  },
});

registerExecutor('groupSession.cancel', {
  scope: 'groupSessions',
  async prepare(clubId, raw) {
    const p = parsePayload(groupCancelSchema, raw, 'Скасування заняття');
    const b = await loadGroup(clubId, p.bookingId);
    const problem = cancelProblem(b);
    if (problem) throw new ActionInvalidError(problem);
    const tz = await clubTimezone(clubId);
    return { payload: p, summary: `Скасувати заняття «${b!.title}»: ${b!.court.name}, ${fmtRange(b!.startTime, b!.endTime, tz)} — причина: ${p.reason}` };
  },
  async execute(clubId, raw, ctx) {
    const p = parsePayload(groupCancelSchema, raw, 'Скасування заняття');
    const actor = await resolveActor(clubId, ctx);
    const b = await loadGroup(clubId, p.bookingId);
    const problem = cancelProblem(b);
    if (problem) throw new ActionFailedError(problem);
    const comment = [b!.comment, `Скасовано: ${p.reason}`].filter(Boolean).join(' · ').slice(0, 300);
    unwrapOutcome(await patchAdminBooking(b!.id, { status: 'CANCELLED', comment }, actor));
    return { bookingId: b!.id };
  },
});
