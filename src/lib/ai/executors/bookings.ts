import { z } from 'zod';

import { prisma } from '../../db';
import { createAdminBooking, createBookingSchema, patchAdminBooking } from '../../adminBookings';
import { totals } from '../../settlements';
import { ActionFailedError, ActionInvalidError, registerExecutor } from '../actions';
import {
  clubTimezone, fmtRange, isoOffset, parsePayload, resolveActor, shortName, slotProblem, uah, unwrapOutcome, uuid,
} from './common';

/**
 * Виконавці scope `bookings`: створити, скасувати, перенести приватну бронь.
 *
 * Сама робота — у lib/adminBookings.ts (createAdminBooking/patchAdminBooking),
 * тих самих функціях, що стоять за POST/PATCH /api/admin/bookings: конфлікт
 * слота, тренер, ціна з акціями й знижкою клієнта, статус за оплатою. Тут лише
 * розбір payload, опис для власника й перевірки, потрібні саме моделі.
 *
 * Джерело броні — ADMIN (бронь завів персонал): окремого значення в enum нема,
 * а міграція заради позначки не потрібна — автор видно в createdBy («… (ІІ-менеджер)»).
 */

export const bookingCreateSchema = z.object({
  courtId: uuid,
  start: isoOffset,
  end: isoOffset,
  customerId: uuid.optional(),
  customerName: z.string().trim().min(1).max(80).optional(),
  customerPhone: z.string().trim().max(30).optional(),
  note: z.string().trim().max(300).optional(),
}).strict().refine((d) => d.customerId || d.customerName, { message: 'customer', path: ['customerId'] });

export const bookingCancelSchema = z.object({
  bookingId: uuid,
  reason: z.string().trim().min(1).max(200),
}).strict();

export const bookingRescheduleSchema = z.object({
  bookingId: uuid,
  courtId: uuid.optional(),
  start: isoOffset,
  end: isoOffset,
}).strict();

const ACTIVE = ['PENDING', 'CONFIRMED'] as const;

async function loadCourt(clubId: string, courtId: string) {
  return prisma.court.findFirst({ where: { id: courtId, clubId, isActive: true }, select: { id: true, name: true } });
}

async function loadCustomer(clubId: string, customerId: string) {
  return prisma.customer.findFirst({ where: { id: customerId, clubId }, select: { id: true, name: true, phone: true } });
}

/** Бронь клубу зі звʼязками, потрібними для скасування й перенесення. */
async function loadBooking(clubId: string, bookingId: string) {
  return prisma.booking.findFirst({
    where: { id: bookingId, clubId },
    include: { court: { select: { name: true } }, payment: true, ledgerEntries: { where: { seatId: null } } },
  });
}
type LoadedBooking = Awaited<ReturnType<typeof loadBooking>>;

const whoLabel = (b: { customerName: string | null }) => (b.customerName ? shortName(b.customerName) : 'без імені');

/**
 * Чому ІІ не скасовує оплачені броні: гроші лишаються в клубі (повернення —
 * окреме рішення власника, див. routes/admin/refunds.ts), і мовчки лишити клієнта
 * без заняття та без грошей — гірше, ніж попросити людину зробити це в кабінеті.
 */
function cancelProblem(b: LoadedBooking): string | null {
  if (!b) return 'Бронь не знайдено.';
  if (b.capacity !== null) return 'Це групове заняття чи турнір, а не приватна бронь.';
  if (!(ACTIVE as readonly string[]).includes(b.status)) return 'Бронь уже скасована або завершена.';
  if (b.startTime.getTime() < Date.now()) return 'Бронь уже минула.';
  const paid = totals(b.ledgerEntries, b.payment?.status === 'PAID' ? b.payment.amount : 0).net;
  if (b.payment?.status === 'PENDING') return 'За цю бронь триває онлайн-оплата. ІІ не скасовує такі броні: дочекайтеся результату оплати або скасуйте її в кабінеті.';
  if (paid > 0) return `Бронь оплачена (${uah(paid)}). ІІ не скасовує оплачені броні: скасуйте її в кабінеті й вирішіть, чи повертати гроші.`;
  return null;
}

function rescheduleProblem(b: LoadedBooking): string | null {
  if (!b) return 'Бронь не знайдено.';
  if (b.capacity !== null) return 'Це групове заняття чи турнір, а не приватна бронь.';
  if (!(ACTIVE as readonly string[]).includes(b.status)) return 'Бронь скасована або завершена, переносити нічого.';
  return null;
}

registerExecutor('booking.create', {
  scope: 'bookings',
  async prepare(clubId, raw) {
    const p = parsePayload(bookingCreateSchema, raw, 'Бронь');
    const court = await loadCourt(clubId, p.courtId);
    if (!court) throw new ActionInvalidError('Корт не знайдено в цьому клубі.');
    const customer = p.customerId ? await loadCustomer(clubId, p.customerId) : null;
    if (p.customerId && !customer) throw new ActionInvalidError('Клієнта не знайдено в цьому клубі.');
    const start = new Date(p.start);
    const end = new Date(p.end);
    const tz = await clubTimezone(clubId);
    const problem = await slotProblem(clubId, court.id, start, end, tz);
    if (problem) throw new ActionInvalidError(problem);
    return {
      payload: p,
      summary: `Бронь: ${court.name}, ${fmtRange(start, end, tz)}, ${shortName(customer?.name ?? p.customerName!)}`,
    };
  },
  async execute(clubId, raw, ctx) {
    /* Повторно: між пропозицією й «Підтвердити» могли додати блокування чи зайняти слот. */
    const p = parsePayload(bookingCreateSchema, raw, 'Бронь');
    const actor = await resolveActor(clubId, ctx);
    const court = await loadCourt(clubId, p.courtId);
    if (!court) throw new ActionFailedError('Корт не знайдено або вимкнено.');
    const customer = p.customerId ? await loadCustomer(clubId, p.customerId) : null;
    if (p.customerId && !customer) throw new ActionFailedError('Клієнта не знайдено.');
    const problem = await slotProblem(clubId, court.id, new Date(p.start), new Date(p.end), await clubTimezone(clubId));
    if (problem) throw new ActionFailedError(problem);

    const parsed = createBookingSchema.safeParse({
      courtId: court.id,
      start: p.start,
      end: p.end,
      customerName: customer?.name ?? p.customerName,
      customerPhone: customer?.phone ?? p.customerPhone,
      comment: p.note,
    });
    if (!parsed.success) throw new ActionFailedError('Некоректні дані броні: перевірте клієнта, час і корт.');
    const input = parsed.data;
    const body = unwrapOutcome(await createAdminBooking(input, actor)) as { id: string; priceTotal: number; status: string };
    return { bookingId: body.id, status: body.status, price: uah(body.priceTotal) };
  },
});

registerExecutor('booking.cancel', {
  scope: 'bookings',
  async prepare(clubId, raw) {
    const p = parsePayload(bookingCancelSchema, raw, 'Скасування');
    const b = await loadBooking(clubId, p.bookingId);
    const problem = cancelProblem(b);
    if (problem) throw new ActionInvalidError(problem);
    const tz = await clubTimezone(clubId);
    return { payload: p, summary: `Скасувати бронь: ${b!.court.name}, ${fmtRange(b!.startTime, b!.endTime, tz)}, ${whoLabel(b!)} — причина: ${p.reason}` };
  },
  async execute(clubId, raw, ctx) {
    const p = parsePayload(bookingCancelSchema, raw, 'Скасування');
    const actor = await resolveActor(clubId, ctx);
    const b = await loadBooking(clubId, p.bookingId);
    const problem = cancelProblem(b);
    if (problem) throw new ActionFailedError(problem);
    /* Причина йде в коментар броні поряд зі старим, а не замість нього. */
    const comment = [b!.comment, `Скасовано: ${p.reason}`].filter(Boolean).join(' · ').slice(0, 300);
    unwrapOutcome(await patchAdminBooking(b!.id, { status: 'CANCELLED', comment }, actor));
    return { bookingId: b!.id };
  },
});

registerExecutor('booking.reschedule', {
  scope: 'bookings',
  async prepare(clubId, raw) {
    const p = parsePayload(bookingRescheduleSchema, raw, 'Перенесення');
    const b = await loadBooking(clubId, p.bookingId);
    const problem = rescheduleProblem(b);
    if (problem) throw new ActionInvalidError(problem);
    const court = await loadCourt(clubId, p.courtId ?? b!.courtId);
    if (!court) throw new ActionInvalidError('Корт не знайдено в цьому клубі.');
    const tz = await clubTimezone(clubId);
    const start = new Date(p.start);
    const end = new Date(p.end);
    const slot = await slotProblem(clubId, court.id, start, end, tz);
    if (slot) throw new ActionInvalidError(slot);
    return {
      payload: p,
      summary: `Перенести бронь ${whoLabel(b!)}: ${b!.court.name}, ${fmtRange(b!.startTime, b!.endTime, tz)} → ${court.name}, ${fmtRange(start, end, tz)}`,
    };
  },
  async execute(clubId, raw, ctx) {
    const p = parsePayload(bookingRescheduleSchema, raw, 'Перенесення');
    const actor = await resolveActor(clubId, ctx);
    const b = await loadBooking(clubId, p.bookingId);
    const problem = rescheduleProblem(b);
    if (problem) throw new ActionFailedError(problem);
    const court = await loadCourt(clubId, p.courtId ?? b!.courtId);
    if (!court) throw new ActionFailedError('Корт не знайдено або вимкнено.');
    const slot = await slotProblem(clubId, court.id, new Date(p.start), new Date(p.end), await clubTimezone(clubId));
    if (slot) throw new ActionFailedError(slot);
    unwrapOutcome(await patchAdminBooking(b!.id, { courtId: court.id, start: p.start, end: p.end }, actor));
    return { bookingId: b!.id };
  },
});
