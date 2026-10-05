import { prisma } from './db';
import { trainerPhotoUrl } from './courtMedia';

/**
 * Оцінка заняття з тренером — одне місце істини.
 *
 * Правила допуску живуть тут і тільки тут: їх читають і віджет (картка
 * «Оцініть заняття» в /customer/me, POST /customer/trainer-ratings), і
 * Telegram-бот (тік запиту й кнопки ⭐1…⭐5). Якби кожен рахував їх по-своєму,
 * гравець бачив би в боті кнопку, яку віджет потім відхилить.
 *
 * ── Що можна оцінити ────────────────────────────────────────────────────
 *
 * Підтверджене заняття з тренером, яке вже закінчилось не більше семи днів
 * тому й на яке гравець не запізнився остаточно (неявка — не заняття).
 * Індивідуальна бронь належить Booking.customerId; групове заняття — це
 * контейнер без клієнта, оцінює той, хто записаний місцем зі статусом BOOKED.
 *
 * ── Відмова теж запис ───────────────────────────────────────────────────
 *
 * «Не оцінювати» — рядок із score = null. Він не рахується в середній, але
 * закриває питання: ні віджет, ні бот більше не питають про це заняття.
 * Коментар без оцінки не зберігаємо — відгук без зірок нічого не важить, а
 * гравець, що передумав, не має лишати по собі текст.
 *
 * ── Чому середню видно не одразу ────────────────────────────────────────
 *
 * Публічно рейтинг показується від трьох оцінок: одна не повинна визначати
 * репутацію тренера. Кабінет бачить усе з першої.
 */

/** Скільки днів після кінця заняття його ще можна оцінити (або змінити оцінку). */
export const RATING_WINDOW_DAYS = 7;

/** Довжина коментаря. */
export const RATING_COMMENT_MAX = 500;

/** Скільки карток «Оцініть заняття» віджет показує за раз. */
export const PENDING_RATINGS_MAX = 3;

/** Від скількох оцінок середня стає видимою гравцям. */
export const RATING_PUBLIC_MIN = 3;

const DAY_MS = 86_400_000;

export type RatingKind = 'b' | 's';
export type RatingApiKind = 'court' | 'seat';
export type RatingSource = 'TELEGRAM' | 'WIDGET';

/** Віджет каже 'court' | 'seat', Telegram-колбек — 'b' | 's'. Це одне й те саме. */
export const ratingKindFromApi = (kind: RatingApiKind | RatingKind): RatingKind =>
  kind === 'court' || kind === 'b' ? 'b' : 's';

export const ratingKindToApi = (kind: RatingKind): RatingApiKind => (kind === 'b' ? 'court' : 'seat');

/**
 * Вікно, у яке має потрапити кінець заняття: [now - 7 днів, now].
 * Окремою функцією, щоб запити до бази й перевірка в памʼяті брали одні межі.
 */
export function ratingWindow(now: Date = new Date()): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - RATING_WINDOW_DAYS * DAY_MS), to: now };
}

/** Усе, що треба знати про заняття, щоб вирішити «можна оцінити чи ні». */
export type RatingTarget = {
  kind: RatingKind;
  /** bookingId для 'b', seatId для 's' */
  id: string;
  bookingId: string;
  seatId: string | null;
  clubId: string;
  timezone: string;
  trainerId: string | null;
  trainerName: string | null;
  /** Гравець заняття: Booking.customerId або BookingSeat.customerId */
  customerId: string | null;
  /** Telegram гравця — для перевірки, що кнопку натиснув саме він */
  chatId: string | null;
  bookingStatus: string;
  /** Місце групи; для індивідуальної броні null */
  seatStatus: string | null;
  attendance: string;
  start: Date;
  end: Date;
};

export type RatingBlocker =
  | 'NO_TRAINER'
  | 'NO_PLAYER'
  | 'NOT_CONFIRMED'
  | 'SEAT_NOT_BOOKED'
  | 'NO_SHOW'
  | 'NOT_ENDED'
  | 'TOO_LATE';

/**
 * Чому заняття не можна оцінити; null — можна. Не перевіряє, чи оцінку вже
 * поставлено: для змінити-оцінку це не перешкода, а список «очікують» і тік
 * Telegram відсіюють такі рядки самі.
 */
export function ratingBlocker(t: RatingTarget, now: Date = new Date()): RatingBlocker | null {
  if (!t.trainerId) return 'NO_TRAINER';
  if (!t.customerId) return 'NO_PLAYER';
  if (t.bookingStatus !== 'CONFIRMED') return 'NOT_CONFIRMED';
  if (t.kind === 's' && t.seatStatus !== 'BOOKED') return 'SEAT_NOT_BOOKED';
  if (t.attendance === 'NO_SHOW') return 'NO_SHOW';
  const { from, to } = ratingWindow(now);
  if (t.end.getTime() > to.getTime()) return 'NOT_ENDED';
  if (t.end.getTime() < from.getTime()) return 'TOO_LATE';
  return null;
}

/**
 * Прочитати заняття разом з усім, що треба для допуску. null — такого немає.
 *
 * Бронь групи як 'b' не віддається: контейнер нікому не належить, гравець
 * записаний у нього місцем (kind = 's').
 */
export async function loadRatingTarget(kind: RatingKind, id: string): Promise<RatingTarget | null> {
  if (kind === 'b') {
    const b = await prisma.booking.findUnique({
      where: { id },
      select: {
        id: true, clubId: true, status: true, capacity: true, attendance: true,
        startTime: true, endTime: true, trainerId: true, customerId: true,
        trainer: { select: { name: true } },
        customer: { select: { telegramChatId: true } },
        club: { select: { timezone: true } },
      },
    });
    if (!b || b.capacity != null) return null;
    return {
      kind, id: b.id, bookingId: b.id, seatId: null,
      clubId: b.clubId, timezone: b.club.timezone,
      trainerId: b.trainerId, trainerName: b.trainer?.name ?? null,
      customerId: b.customerId, chatId: b.customer?.telegramChatId ?? null,
      bookingStatus: b.status, seatStatus: null, attendance: b.attendance,
      start: b.startTime, end: b.endTime,
    };
  }

  const s = await prisma.bookingSeat.findUnique({
    where: { id },
    select: {
      id: true, status: true, customerId: true, bookingId: true,
      customer: { select: { telegramChatId: true } },
      booking: {
        select: {
          clubId: true, status: true, capacity: true, attendance: true,
          startTime: true, endTime: true, trainerId: true,
          trainer: { select: { name: true } },
          club: { select: { timezone: true } },
        },
      },
    },
  });
  if (!s || s.booking.capacity == null) return null;
  return {
    kind, id: s.id, bookingId: s.bookingId, seatId: s.id,
    clubId: s.booking.clubId, timezone: s.booking.club.timezone,
    trainerId: s.booking.trainerId, trainerName: s.booking.trainer?.name ?? null,
    customerId: s.customerId, chatId: s.customer?.telegramChatId ?? null,
    bookingStatus: s.booking.status, seatStatus: s.status, attendance: s.booking.attendance,
    start: s.booking.startTime, end: s.booking.endTime,
  };
}

export type RateableResult =
  | { ok: true; target: RatingTarget }
  | { ok: false; error: 'NOT_FOUND' | 'NOT_RATEABLE' };

/**
 * Заняття, яке ЦЕЙ гравець може оцінити зараз. Чуже й неіснуюче — однаково
 * NOT_FOUND: відповідь не має підказувати, що такий id у базі є.
 */
export async function loadRateableItem(
  kind: RatingKind | RatingApiKind,
  id: string,
  who: { customerId: string; clubId: string },
  now: Date = new Date(),
): Promise<RateableResult> {
  const target = await loadRatingTarget(ratingKindFromApi(kind), id);
  if (!target || target.customerId !== who.customerId || target.clubId !== who.clubId) {
    return { ok: false, error: 'NOT_FOUND' };
  }
  if (ratingBlocker(target, now)) return { ok: false, error: 'NOT_RATEABLE' };
  return { ok: true, target };
}

/** Чи вже є рядок оцінки (включно з відмовою) для (заняття, гравець). */
export async function hasTrainerRating(bookingId: string, customerId: string): Promise<boolean> {
  const row = await prisma.trainerRating.findUnique({
    where: { bookingId_customerId: { bookingId, customerId } },
    select: { id: true },
  });
  return row != null;
}

export const cleanRatingComment = (comment: string | null | undefined): string | null => {
  const text = (comment ?? '').trim().slice(0, RATING_COMMENT_MAX);
  return text || null;
};

/**
 * Записати оцінку: upsert по (заняття, гравець). Повторна оцінка в межах
 * вікна замінює попередню — разом із відмовою: гравець передумав.
 *
 * score = null — відмова. Коментар без оцінки відкидається.
 * Допуск перевіряється тут ще раз, свіжо: між відкриттям картки й
 * натисканням кнопки заняття могло вийти за вікно.
 */
export async function saveTrainerRating(
  target: RatingTarget,
  input: { score: number | null; comment?: string | null; source: RatingSource },
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; error: 'NOT_RATEABLE' }> {
  if (ratingBlocker(target, now)) return { ok: false, error: 'NOT_RATEABLE' };

  const score = input.score;
  if (score != null && (!Number.isInteger(score) || score < 1 || score > 5)) {
    return { ok: false, error: 'NOT_RATEABLE' };
  }
  const comment = score == null ? null : cleanRatingComment(input.comment);

  await prisma.trainerRating.upsert({
    where: { bookingId_customerId: { bookingId: target.bookingId, customerId: target.customerId! } },
    create: {
      clubId: target.clubId,
      trainerId: target.trainerId!,
      bookingId: target.bookingId,
      seatId: target.seatId,
      customerId: target.customerId!,
      score,
      comment,
      source: input.source,
    },
    update: { score, comment, source: input.source, seatId: target.seatId },
  });
  return { ok: true };
}

/* ── Очікують оцінки ────────────────────────────────────────────────────── */

export type PendingRating = {
  kind: RatingApiKind;
  id: string;
  trainerName: string;
  trainerPhotoUrl: string | null;
  startTime: Date;
  endTime: Date;
};

/**
 * Перше фото кожного тренера одним запитом. Без байтів: тільки id.
 */
export async function firstPhotoIds(trainerIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (trainerIds.length === 0) return out;
  const rows = await prisma.trainerPhoto.findMany({
    where: { trainerId: { in: trainerIds } },
    select: { id: true, trainerId: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  for (const row of rows) if (!out.has(row.trainerId)) out.set(row.trainerId, row.id);
  return out;
}

/**
 * Заняття, про які віджет має спитати гравця: найсвіжіші, до трьох.
 * Ті самі правила, що й ratingBlocker, але у вигляді where — щоб не тягнути
 * з бази всю історію. Рядок TrainerRating (оцінка або відмова) заняття прибирає.
 */
export async function listPendingRatings(
  who: { customerId: string; clubId: string },
  now: Date = new Date(),
): Promise<PendingRating[]> {
  const { from, to } = ratingWindow(now);
  const window = { gte: from, lte: to };
  const mine = { trainerRatings: { none: { customerId: who.customerId } } };

  const [bookings, seats] = await Promise.all([
    prisma.booking.findMany({
      where: {
        clubId: who.clubId,
        customerId: who.customerId,
        capacity: null,
        status: 'CONFIRMED',
        trainerId: { not: null },
        attendance: { not: 'NO_SHOW' },
        endTime: window,
        ...mine,
      },
      select: {
        id: true, startTime: true, endTime: true, trainerId: true,
        trainer: { select: { name: true } },
      },
      orderBy: { endTime: 'desc' },
      take: PENDING_RATINGS_MAX,
    }),
    prisma.bookingSeat.findMany({
      where: {
        customerId: who.customerId,
        status: 'BOOKED',
        booking: {
          clubId: who.clubId,
          capacity: { not: null },
          status: 'CONFIRMED',
          trainerId: { not: null },
          attendance: { not: 'NO_SHOW' },
          endTime: window,
          ...mine,
        },
      },
      select: {
        id: true,
        booking: {
          select: {
            startTime: true, endTime: true, trainerId: true,
            trainer: { select: { name: true } },
          },
        },
      },
      orderBy: { booking: { endTime: 'desc' } },
      take: PENDING_RATINGS_MAX,
    }),
  ]);

  const items = [
    ...bookings.map((b) => ({
      kind: 'court' as const, id: b.id, trainerId: b.trainerId!, trainerName: b.trainer?.name ?? '',
      startTime: b.startTime, endTime: b.endTime,
    })),
    ...seats.map((s) => ({
      kind: 'seat' as const, id: s.id, trainerId: s.booking.trainerId!, trainerName: s.booking.trainer?.name ?? '',
      startTime: s.booking.startTime, endTime: s.booking.endTime,
    })),
  ]
    .sort((a, b) => b.endTime.getTime() - a.endTime.getTime())
    .slice(0, PENDING_RATINGS_MAX);

  const photos = await firstPhotoIds([...new Set(items.map((i) => i.trainerId))]);

  return items.map((i) => ({
    kind: i.kind,
    id: i.id,
    trainerName: i.trainerName,
    trainerPhotoUrl: photos.has(i.trainerId) ? trainerPhotoUrl(photos.get(i.trainerId)!) : null,
    startTime: i.startTime,
    endTime: i.endTime,
  }));
}

/* ── Середня оцінка ─────────────────────────────────────────────────────── */

export type RatingSummary = { avg: number; count: number };

/** Середня з одним знаком після коми: 4.75 → 4.8. */
export const roundAvg = (value: number): number => Math.round(value * 10) / 10;

/**
 * Середня й кількість для багатьох тренерів одним запитом. Рахуються тільки
 * оцінки (score != null): відмови в середню не входять. Тренера без оцінок
 * у мапі немає.
 */
export async function ratingSummaries(
  trainerIds: string[],
  clubId: string,
): Promise<Map<string, RatingSummary>> {
  const out = new Map<string, RatingSummary>();
  if (trainerIds.length === 0) return out;

  const rows = await prisma.trainerRating.groupBy({
    by: ['trainerId'],
    where: { clubId, trainerId: { in: trainerIds }, score: { not: null } },
    _avg: { score: true },
    _count: { score: true },
  });
  for (const row of rows) {
    const count = row._count.score;
    if (count > 0 && row._avg.score != null) out.set(row.trainerId, { avg: roundAvg(row._avg.score), count });
  }
  return out;
}

/** Для гравців: null, поки оцінок менше трьох. */
export const publicRating = (summary: RatingSummary | undefined): RatingSummary | null =>
  summary && summary.count >= RATING_PUBLIC_MIN ? summary : null;

/** Для кабінету: null тільки коли оцінок немає зовсім. */
export const adminRating = (summary: RatingSummary | undefined): RatingSummary | null =>
  summary && summary.count > 0 ? summary : null;

export type TrainerRatingItem = {
  id: string;
  score: number;
  comment: string | null;
  customerName: string;
  sessionStart: string;
  source: string;
  createdAt: string;
};

/**
 * Відгуки одного тренера для кабінету: найновіші спершу, без відмов.
 * Тренер чужого клубу — null (роут віддасть 404).
 */
export async function listTrainerRatings(
  trainerId: string,
  clubId: string,
  limit: number,
): Promise<{ avg: number | null; count: number; items: TrainerRatingItem[] } | null> {
  const trainer = await prisma.trainer.findFirst({ where: { id: trainerId, clubId }, select: { id: true } });
  if (!trainer) return null;

  const [summaries, rows] = await Promise.all([
    ratingSummaries([trainer.id], clubId),
    prisma.trainerRating.findMany({
      where: { trainerId: trainer.id, clubId, score: { not: null } },
      select: {
        id: true, score: true, comment: true, source: true, createdAt: true,
        customer: { select: { name: true } },
        booking: { select: { startTime: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
  ]);

  const summary = summaries.get(trainer.id);
  return {
    avg: summary?.avg ?? null,
    count: summary?.count ?? 0,
    items: rows.map((r) => ({
      id: r.id,
      score: r.score!,
      comment: r.comment,
      customerName: r.customer.name,
      sessionStart: r.booking.startTime.toISOString(),
      source: r.source,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}
