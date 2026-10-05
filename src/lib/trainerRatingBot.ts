import { withSendSummary } from './telegramSafety';
import { prisma } from './db';
import { planFeatures } from './plans';
import { sendReminderMessage } from './telegram';
import { dayLabel, html, timeRange } from './playerBot';
import {
  hasTrainerRating,
  loadRatingTarget,
  ratingBlocker,
  type RatingKind,
  type RatingTarget,
} from './trainerRating';

/**
 * Запит оцінки тренера в Telegram — одне повідомлення після кінця заняття.
 *
 * ── Чому тік, а не подія ────────────────────────────────────────────────
 *
 * Заняття «закінчується» за годинником, а не діями людей: ніхто не натискає
 * «завершити». Тому раз на хвилину беремо те, що скінчилось за останні три
 * години, і питаємо один раз. Пізніше за три години питати вже незручно
 * (людина забула заняття) — для цього є картка «Оцініть заняття» у віджеті.
 *
 * ── Мітка rateAskedAt ───────────────────────────────────────────────────
 *
 * Ставиться ДО відправки умовним updateMany: два процеси не надішлють одне
 * й те саме двічі. Якщо Telegram явно не прийняв повідомлення (мережа,
 * 5xx) — мітку знімаємо, наступний тік спробує знову, поки не вийде вікно.
 * Допуск (неявка, статус, вікно) перевіряє lib/trainerRating.ts, тут тільки
 * вибір кандидатів.
 */

/** Скільки після кінця заняття ще питаємо в Telegram */
export const RATING_ASK_HOURS = 3;

const BATCH = 100;

/** callback_data: tr:<0-5>:<b|s>:<uuid> — 3+1+1+1+1+1+36 = 44 байти (ліміт Telegram — 64) */
export const ratingCallback = (score: number, kind: RatingKind, id: string) => `tr:${score}:${kind}:${id}`;

export function ratingAskText(target: RatingTarget, now: Date = new Date()): string {
  const when = `${dayLabel(target.start, target.timezone, now)}, ${timeRange(target.start, target.end, target.timezone)}`;
  return `Як пройшло заняття з тренером ${html(target.trainerName ?? '')} (${when})? `
    + 'Оцінка необовʼязкова — її бачить лише клуб.';
}

export function ratingAskKeyboard(kind: RatingKind, id: string) {
  return {
    inline_keyboard: [
      [1, 2, 3, 4, 5].map((n) => ({ text: `⭐${n}`, callback_data: ratingCallback(n, kind, id) })),
      [{ text: 'Не оцінювати', callback_data: ratingCallback(0, kind, id) }],
    ],
  };
}

export const runTrainerRatingTick = (now?: Date) => withSendSummary('trainer-rating', () => runTrainerRatingTickInner(now));
async function runTrainerRatingTickInner(now: Date = new Date()): Promise<number> {
  const from = new Date(now.getTime() - RATING_ASK_HOURS * 3_600_000);
  const ended = { gt: from, lte: now };
  const withTelegram = { telegramChatId: { not: null } };

  const [bookings, seats] = await Promise.all([
    prisma.booking.findMany({
      where: {
        capacity: null,
        status: 'CONFIRMED',
        trainerId: { not: null },
        rateAskedAt: null,
        endTime: ended,
        attendance: { not: 'NO_SHOW' },
        customer: withTelegram,
      },
      select: { id: true, club: { select: { plan: true } } },
      take: BATCH,
    }),
    prisma.bookingSeat.findMany({
      where: {
        status: 'BOOKED',
        rateAskedAt: null,
        customer: withTelegram,
        booking: {
          status: 'CONFIRMED',
          trainerId: { not: null },
          endTime: ended,
          attendance: { not: 'NO_SHOW' },
        },
      },
      select: { id: true, booking: { select: { club: { select: { plan: true } } } } },
      take: BATCH,
    }),
  ]);

  /* Потрібні обидва права: Telegram (тариф) і тренери — без другого тренера
     в клубі й не буває, але гасимо явно, щоб старий запис не питав про
     «тренера» клубу, який відмовився від модуля. */
  const allowed = (plan: Parameters<typeof planFeatures>[0]) => {
    const f = planFeatures(plan);
    return f.telegram && f.trainers;
  };
  const queue: { kind: RatingKind; id: string }[] = [
    ...bookings.filter((b) => allowed(b.club.plan)).map((b) => ({ kind: 'b' as const, id: b.id })),
    ...seats.filter((s) => allowed(s.booking.club.plan)).map((s) => ({ kind: 's' as const, id: s.id })),
  ];

  let delivered = 0;

  for (const { kind, id } of queue) {
    const claim = kind === 'b'
      ? await prisma.booking.updateMany({ where: { id, rateAskedAt: null }, data: { rateAskedAt: now } })
      : await prisma.bookingSeat.updateMany({ where: { id, rateAskedAt: null }, data: { rateAskedAt: now } });
    if (claim.count === 0) continue;

    try {
      const target = await loadRatingTarget(kind, id);
      if (!target?.chatId || !target.customerId || ratingBlocker(target, now)) continue;
      /* Уже оцінив у віджеті (або відмовився) — питати нема чого. */
      if (await hasTrainerRating(target.bookingId, target.customerId)) continue;

      const result = await sendReminderMessage(target.chatId, ratingAskText(target, now), ratingAskKeyboard(kind, id));
      if (result === 'sent') delivered += 1;
      if (result === 'permanent') console.warn('[trainer-rating] delivery unavailable', kind, id);
      if (result === 'retry') {
        /* Не прийняли — знімаємо мітку, нехай наступний тік спробує знову. */
        const release = { where: { id, rateAskedAt: now }, data: { rateAskedAt: null } };
        if (kind === 'b') await prisma.booking.updateMany(release);
        else await prisma.bookingSeat.updateMany(release);
      }
    } catch (e) {
      /* Після збою мітка лишається: краще не спитати, ніж спитати двічі. */
      console.error('[trainer-rating] failed', kind, id);
    }
  }

  return delivered;
}
