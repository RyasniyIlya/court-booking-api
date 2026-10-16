import { DateTime } from 'luxon';
import { z } from 'zod';

import { prisma } from '../../db';
import type { BookingActor, BookingOutcome } from '../../adminBookings';
import { ActionFailedError, ActionInvalidError, type ActionContext } from '../actions';

/**
 * Спільне для виконавців ІІ-менеджера: розбір payload, людські підписи,
 * автор дії, переклад кодів помилок доменних функцій в українські повідомлення.
 */

export const isoOffset = z.string().datetime({ offset: true });
export const uuid = z.string().uuid();

/** Розбір payload: перше ж порушення — коротке українське пояснення, а не дамп zod. */
export function parsePayload<S extends z.ZodTypeAny>(schema: S, payload: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(payload);
  if (!r.success) {
    const where = r.error.issues[0]?.path.join('.') || 'запит';
    throw new ActionInvalidError(`${what}: некоректні дані (${where}).`);
  }
  return r.data;
}

const WEEKDAYS = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['січ', 'лют', 'бер', 'квіт', 'трав', 'черв', 'лип', 'серп', 'вер', 'жовт', 'лист', 'груд'];

/** «пт 18 жовт 19:00–20:30» за часом клубу; перетин північі показує й дату кінця. */
export function fmtRange(start: Date, end: Date, tz: string): string {
  const s = DateTime.fromJSDate(start).setZone(tz);
  const e = DateTime.fromJSDate(end).setZone(tz);
  const day = `${WEEKDAYS[s.weekday % 7]} ${s.day} ${MONTHS[s.month - 1]}`;
  const tail = s.hasSame(e, 'day') ? e.toFormat('HH:mm') : `${e.day} ${MONTHS[e.month - 1]} ${e.toFormat('HH:mm')}`;
  return `${day} ${s.toFormat('HH:mm')}–${tail}`;
}

/** «Олена Коваль» → «Олена К.»: у черзі та журналі не потрібне повне прізвище. */
export function shortName(name: string): string {
  const [first, second] = name.trim().split(/\s+/);
  return second ? `${first} ${second[0].toUpperCase()}.` : first;
}

export const uah = (kop: number) => `${Math.round(kop / 100)} грн`;

export async function clubTimezone(clubId: string): Promise<string> {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } });
  return club?.timezone ?? 'UTC';
}

/**
 * Від чийого імені діє ІІ: співробітник, що просив (або, якщо його вже нема, хто підтвердив).
 * Права на саму дію вже перевірені політикою; тут лише ролі, які й руками правлять броні.
 */
export async function resolveActor(clubId: string, ctx: ActionContext): Promise<BookingActor> {
  const userId = ctx.requestedById ?? ctx.decidedById;
  const user = userId
    ? await prisma.user.findFirst({ where: { id: userId, clubId }, select: { id: true, role: true } })
    : null;
  if (!user) throw new ActionFailedError('Не знайдено співробітника, від імені якого діє ІІ-менеджер.');
  if (user.role !== 'OWNER' && user.role !== 'ADMIN') {
    throw new ActionFailedError('Ця роль не може створювати чи змінювати бронювання.');
  }
  return { clubId, userId: user.id, role: user.role, viaAi: true };
}

/** Коди помилок доменних функцій (ті самі, що бачить кабінет) → текст для власника. */
const DOMAIN_ERRORS: Record<string, string> = {
  SLOT_TAKEN: 'Цей час на корті вже зайнятий.',
  TRAINER_BUSY: 'Тренер у цей час зайнятий.',
  COURT_NOT_FOUND: 'Корт не знайдено.',
  TRAINER_NOT_FOUND: 'Тренера не знайдено або він неактивний.',
  NOT_FOUND: 'Бронь не знайдено.',
  BAD_INTERVAL: 'Кінець раніше за початок.',
  TOO_LONG: 'Бронь довша за 12 годин.',
  PLAN_REQUIRED: 'Групові заняття недоступні на тарифі клубу.',
  RATINGS_LOCKED: 'Результати вже враховано в рейтингу, змінювати не можна.',
  PAYMENT_REQUIRED: 'Спершу потрібна оплата.',
  RENTAL_NOT_AVAILABLE: 'Прокат на цей час недоступний.',
  RENTAL_BUSY: 'Прокат на цей час недоступний.',
  FORBIDDEN: 'Недостатньо прав.',
  FEDERATION_ONLY: 'Федераційні турніри ведуться лише федерацією.',
};

/** Успіх — тіло відповіді; будь-що інше — ActionFailedError (статус FAILED у журналі). */
export function unwrapOutcome(out: BookingOutcome, ok: number[] = [200, 201]): unknown {
  if (ok.includes(out.status)) return out.body;
  const code = (out.body as { error?: string } | null)?.error ?? 'UNKNOWN';
  throw new ActionFailedError(DOMAIN_ERRORS[code] ?? `Не вдалося виконати (${code}).`);
}

/**
 * Перевірки, яких людині в кабінеті не треба, а моделі — так: вона легко «вигадує»
 * 03:00 або минулу дату. Годинник роботи й блокування корту не пускають бронь
 * у закритий час. Повертає причину відмови або null.
 */
export async function slotProblem(clubId: string, courtId: string, start: Date, end: Date, tz: string): Promise<string | null> {
  if (end <= start) return 'Кінець має бути пізніше за початок.';
  if (end.getTime() - start.getTime() > 12 * 3600_000) return 'Бронь не може бути довшою за 12 годин.';
  if (start.getTime() < Date.now()) return 'Цей час уже минув.';

  const local = DateTime.fromJSDate(start).setZone(tz);
  const hours = await prisma.clubHours.findUnique({ where: { clubId_weekday: { clubId, weekday: local.weekday % 7 } } });
  if (hours) {
    const open = local.startOf('day').plus({ minutes: hours.openMinute });
    const close = local.startOf('day').plus({ minutes: hours.closeMinute });
    if (hours.isClosed || start < open.toJSDate() || end > close.toJSDate()) {
      return hours.isClosed
        ? 'У цей день клуб не працює.'
        : `Клуб працює ${open.toFormat('HH:mm')}–${close.toFormat('HH:mm')}, цей час поза графіком.`;
    }
  }

  const block = await prisma.block.findFirst({
    where: { clubId, OR: [{ courtId }, { courtId: null }], startTime: { lt: end }, endTime: { gt: start } },
    select: { reason: true },
  });
  if (block) return `Корт у цей час заблоковано${block.reason ? ` (${block.reason})` : ''}.`;
  return null;
}
