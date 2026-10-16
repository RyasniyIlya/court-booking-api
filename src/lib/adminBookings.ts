import { z } from 'zod';

import { prisma, isSlotTakenError } from './db';
import { paymentPlanSchema } from './settlements';
import { isTournament, tournamentTitle } from './tournamentPay';
import { SPORTS, defaultTeamSize, sportError } from './sport';
import { buildTournamentSettings, type TournamentSettings } from './sportRules';
import { normalizePhone } from './phone';
import { findOrCreateCustomer } from './customers';
import { diffFields, moveChange, recordChanges } from './changeLog';
import { notifyBooking } from './notifyBooking';
import { paymentStatusPatch } from './bookingPaymentStatus';
import { OPEN_MATCH_TITLE, SKILL_LEVELS } from './openMatch';
import { inviteMatch } from './openMatchInvite';
import { courtPriceWithPromos, type CourtPriceResult } from './promo';
import { RentalError, loadOccupancy, lockRentableItems, previewRentals, recalcRentalsForMove, rentalCreateData, reserveRentals } from './rentalStore';
import { MAX_RENT_LINES, MAX_RENT_QUANTITY, findShortages, type MoveResult } from './rentals';
import { hasFeature } from '../routes/admin/shared';

/**
 * Створення й правка броні персоналом клубу.
 *
 * Жило всередині POST/PATCH /api/admin/bookings. Винесено, коли друга сторона
 * — ІІ-менеджер (lib/ai/executors) — мусить робити бронь, групу чи скасування
 * РІВНО за тими самими правилами, що й людина з кабінету: конфлікт слота,
 * зайнятий тренер, ціна з акціями й знижкою клієнта, прокат, план оплати,
 * статус за оплатою. Друга копія правил роз'їхалась би з першою на першій же
 * зміні тарифу, тому роут і виконавець ІІ викликають одні й ті самі функції.
 *
 * Функції не знають про HTTP: повертають { status, body }, який роут віддає
 * як є. Поведінка роутів не змінилась — це перенесення, не переписування.
 */

export type BookingOutcome = { status: number; body: unknown };

/** Хто діє. viaAi — дія йде від ІІ-менеджера: у журналі броні це видно за позначкою. */
export type BookingActor = {
  clubId: string;
  userId: string;
  role: string;
  trainerId?: string | null;
  viaAi?: boolean;
};

/** Позначка автора для createdBy/cancelledBy: щоб за рік було видно, що це зробив не співробітник руками. */
const AI_MARK = ' (ІІ-менеджер)';

export async function paymentPlanSnapshot(plan: { method: string; account: string }, userId: string) {
  const actor = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  return { ...plan, by: actor.email, at: new Date().toISOString() };
}

export const BUSY = ['PENDING', 'CONFIRMED'] as const;

export const trainerCost = (pricePerHour: number, start: Date, end: Date) =>
  Math.round((pricePerHour * ((end.getTime() - start.getTime()) / 60_000)) / 60);

/**
 * Вихід із транзакції з осмисленим кодом.
 *
 * Усередині prisma.$transaction звичайний res.status(...) не годиться:
 * транзакцію треба відкотити, а не тихо закомітити разом із помилкою.
 * Кидаємо — Prisma відкочує, обробник перекладає назад у HTTP.
 */
export class SeatError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export const createBookingSchema = z
  .object({
    courtId: z.string().uuid(),
    start: z.string().datetime({
      offset: true,
    }),
    end: z.string().datetime({
      offset: true,
    }),
    /* Необовʼязкове, бо в групового заняття одного клієнта немає.
       Що саме має бути заповнене — стежить superRefine нижче. */
    paymentPlan: paymentPlanSchema.optional(),
    customerName: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional(),

    customerPhone: z
      .string()
      .trim()
      .max(30)
      .optional(),

    trainerId: z
      .string()
      .uuid()
      .nullable()
      .optional(),

    comment: z
      .string()
      .trim()
      .max(300)
      .optional(),

    status: z
      .enum([
        'PENDING',
        'CONFIRMED',
      ])
      .default('CONFIRMED'),

    priceTotal: z
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .optional(),

    /* ── Групове заняття ────────────────────────────────────────────
       Присутня capacity -> це група, а не приватна бронь. Корт при
       цьому займається рівно один раз, тому booking_no_overlap
       продовжує працювати без винятків. */
    capacity: z
      .number()
      .int()
      .min(2)
      .max(200)
      .optional(),

    title: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .optional(),

    pricePerSeat: z
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .optional(),

    /* ── Відкрита гра ───────────────────────────────────────────────
       Те саме групове заняття, тільки без тренера й без назви
       заняття: гравцям бракує партнерів на свій рівень. Рівень
       необовʼязковий — гра без нього видима всім. */
    isOpenMatch: z
      .boolean()
      .default(false),

    levelMin: z
      .enum(SKILL_LEVELS)
      .nullish(),

    levelMax: z
      .enum(SKILL_LEVELS)
      .nullish(),

    /* Вид спорту й формат турніру (1 = одиночний, 2 = парний); зміст має
       лише для турніру — інакше ігноруються. */
    /* Клубний турнір: false = «Без рейтингу» (товариський); типово true. */
    rated: z.boolean().optional(),
    tournamentSport: z.enum(SPORTS).nullish(),
    tournamentTeamSize: z.union([z.literal(1), z.literal(2)]).optional(),
    /* До скількох виграних сетів іде матч; без значення — дефолт клубу. */
    tournamentSetsToWin: z.number().int().min(1).max(3).optional(),
    /* Налаштування за правилами спорту (lib/sportRules.ts); без них — типові для спорту. */
    tournamentSettings: z.record(z.string(), z.unknown()).optional(),

    /* Прокат — лише для приватної броні. Ручна priceTotal вище — це
       ціна корту й тренера; прокат додається до неї зверху, щоб
       rentalTotal лишався рівно сумою рядків. */
    rentals: z
      .array(z.object({
        itemId: z.string().uuid(),
        quantity: z.number().int().min(1).max(MAX_RENT_QUANTITY),
      }))
      .max(MAX_RENT_LINES)
      .default([]),
  })
  /* Дзеркалить CHECK booking_private_or_group у базі. Тут — щоб
     віддати зрозумілу помилку замість 500 від констрейнта. */
  .superRefine((d, ctx) => {
    /* Відкрита гра — це група: без місць до неї нема куди записатись.
       Дзеркалить CHECK booking_open_match_is_group. */
    if (d.isOpenMatch && d.capacity == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['capacity'],
        message: 'Відкрита гра без місць',
      });
    }

    /* Діапазон навпаки («від B+ до C») мовчки не перевертаємо: це не
       одруківка, а незрозуміло чого хотів адміністратор. */
    if (d.levelMin && d.levelMax && SKILL_LEVELS.indexOf(d.levelMin) > SKILL_LEVELS.indexOf(d.levelMax)) {
      ctx.addIssue({
        code: 'custom',
        path: ['levelMax'],
        message: 'Рівень «від» вищий за «до»',
      });
    }

    if (d.capacity != null) {
      /* У відкритої гри назва своя: заняття немає, є година й рівень. */
      if (!d.title && !d.isOpenMatch) {
        ctx.addIssue({
          code: 'custom',
          path: ['title'],
          message: 'Групове заняття без назви',
        });
      }
      if (d.rentals.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['rentals'],
          message: 'Прокат — лише для приватної броні',
        });
      }
    } else if (!d.customerName) {
      ctx.addIssue({
        code: 'custom',
        path: ['customerName'],
        message: 'Бронь без імені',
      });
    }
  });

export async function createAdminBooking(d: CreateBookingInput, actor: BookingActor): Promise<BookingOutcome> {
  const clubId = actor.clubId;

  const start = new Date(d.start);
  const end = new Date(d.end);

  if (end <= start) {
    return { status: 400, body: {
      error: 'BAD_INTERVAL',
    } };
  }

  if (
    end.getTime() - start.getTime() >
    12 * 3600_000
  ) {
    return { status: 400, body: {
      error: 'TOO_LONG',
    } };
  }

  /* Турнір: вид спорту + формат за правилами lib/sport.ts. */
  const tourney = isTournament(d);
  const tSport = tourney ? (d.tournamentSport ?? null) : null;
  let tTeamSize = tourney ? (d.tournamentTeamSize ?? defaultTeamSize(tSport)) : 1;
  if (tourney && (tSport || d.tournamentTeamSize)) {
    const clubSports = (await prisma.club.findUnique({ where: { id: clubId }, select: { sports: true } }))?.sports ?? [];
    const bad = sportError(tSport, tTeamSize, clubSports);
    if (bad) return { status: 400, body: { error: bad } };
  }

  let tSetsToWin = tourney
    ? (d.tournamentSetsToWin ?? (await prisma.club.findUnique({ where: { id: clubId }, select: { defaultSetsToWin: true } }))?.defaultSetsToWin ?? 3)
    : null;
  let tSettings: TournamentSettings | null = null;
  if (tourney) {
    const built = buildTournamentSettings(tSport, { settings: d.tournamentSettings, teamSize: d.tournamentTeamSize, setsToWin: tSetsToWin });
    if (!built.ok) return { status: 400, body: { error: built.error } };
    tSettings = built.settings;
    if (tSettings) { tTeamSize = built.teamSize; tSetsToWin = built.setsToWin; }
  }

  const court = await prisma.court.findFirst({
    where: {
      id: d.courtId,
      clubId,
    },
  });

  if (!court) {
    return { status: 404, body: {
      error: 'COURT_NOT_FOUND',
    } };
  }

  let trainer = null;

  if (d.trainerId) {
    trainer = await prisma.trainer.findFirst({
      where: {
        id: d.trainerId,
        clubId,
        isActive: true,
      },
    });

    if (!trainer) {
      return { status: 404, body: {
        error: 'TRAINER_NOT_FOUND',
      } };
    }

    const clash = await prisma.booking.findFirst({
      where: {
        trainerId: trainer.id,
        status: {
          in: [...BUSY],
        },
        startTime: {
          lt: end,
        },
        endTime: {
          gt: start,
        },
      },
      select: {
        id: true,
      },
    });

    if (clash) {
      return { status: 409, body: {
        error: 'TRAINER_BUSY',
      } };
    }
  }

  const minutes =
    (end.getTime() - start.getTime()) /
    60_000;

  const trainerPrice = trainer
    ? trainerCost(
        trainer.pricePerHour,
        start,
        end,
      )
    : 0;

  const courtPrice = Math.round(
    (court.pricePerHour * minutes) / 60,
  );

  const isGroup = d.capacity != null;

  /* Групове заняття — можливість плану, звичайна бронь — ні. Перевірка
     саме тут, а не middleware на весь роут: обидва створюються одним
     POST /bookings і відрізняються лише наявністю capacity, тож вартовий
     на роуті закрив би клубу першого рівня всі броні разом із групами. */
  if (isGroup && !(await hasFeature(actor.clubId, 'groups'))) {
    return { status: 402, body: {
      error: 'PLAN_REQUIRED',
      feature: 'groups',
    } };
  }

  /* Виручка групи — це сума проданих місць, а не ціна корту: клуб бере
     гроші з кожного гравця окремо. Тому контейнер створюється з нулем і
     росте, коли люди записуються. Так підсумок дня рахується сам, без
     окремої гілки в аналітиці. */
  const priceBeforeDiscount = isGroup
    ? (d.priceTotal ?? 0)
    : (d.priceTotal ??
      courtPrice +
        trainerPrice);

  /* У групи клієнта немає — записані лежать у BookingSeat. Картку
     заводити нема на кого, телефон теж нічий. */
  const phone = !isGroup && d.customerPhone
    ? normalizePhone(
        d.customerPhone,
      )
    : null;

  const customer = phone
    ? await findOrCreateCustomer({
        clubId,
        name: d.customerName!,
        rawPhone: d.customerPhone!,
      })
    : null;

  /* Прокат без знижки, поверх ціни. Попередньо — щоб знати, чи бронь
     платна; під замком у транзакції сума перевіряється ще раз. */
  const rentalPreview = await previewRentals(prisma, clubId, d.rentals, start, end);
  if (!rentalPreview.ok) {
    return { status: 409, body: { error: 'RENTAL_NOT_AVAILABLE', itemId: rentalPreview.itemId } };
  }

  const priceTotal = (!isGroup && d.priceTotal === undefined
    ? Math.round(priceBeforeDiscount * (100 - (customer?.discountPercent ?? 0)) / 100)
    : priceBeforeDiscount) + rentalPreview.total;

  const initialStatus = isGroup || priceTotal === 0
    ? d.status
    : 'PENDING';

  /* Усе, що читає базу поза самою броню, — до транзакції: вона тримає
     замок на ракетках, і чекати в ній на зайві запити нема чого. */
  const actorEmail = (await prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { email: true } })).email + (actor.viaAi ? AI_MARK : '');
  const paymentPlan = d.paymentPlan && (!isGroup || isTournament(d))
    ? await paymentPlanSnapshot(d.paymentPlan, actor.userId)
    : undefined;

  try {
    const booking =
      await prisma.$transaction(async (tx) => {
        const rentals = await reserveRentals(tx, { clubId, start, end, request: d.rentals });
        if (rentals.total !== rentalPreview.total) {
          throw new RentalError(409, 'RENTAL_NOT_AVAILABLE');
        }

        return tx.booking.create({
          data: {
            rentalTotal: rentals.total,
            rentals: { create: rentalCreateData(clubId, rentals.lines) },
            clubId,
            courtId: court.id,
            /* Група: ні імені, ні телефону — замість них title. Приватна
               бронь лишається рівно такою, як була, разом із порожнім
               рядком замість телефону, якщо його не дали. */
            customerName: isGroup
              ? null
              : d.customerName!,
            customerPhone: isGroup
              ? null
              : (phone?.e164 ?? ''),
            capacity: d.capacity ?? null,
            title: isGroup
              ? (d.title ?? OPEN_MATCH_TITLE)
              : null,
            isOpenMatch: d.isOpenMatch,
            ...(tourney ? { tournamentRated: d.rated ?? true, tournamentSport: tSport, tournamentTeamSize: tTeamSize, tournamentSetsToWin: tSetsToWin, ...(tSettings ? { tournamentSettings: tSettings } : {}) } : {}),
            levelMin: d.levelMin ?? null,
            levelMax: d.levelMax ?? null,
            pricePerSeat: isGroup
              ? (d.pricePerSeat ?? 0)
              : null,
            customerId:
              customer?.id ?? null,
            trainerId:
              trainer?.id ?? null,
            trainerPrice,
            comment: d.comment,
            startTime: start,
            endTime: end,
            priceTotal,
            /* Ручне створення адміністратором акцій не рахує — ціну він
               вводить сам або бере пряму ціну корту. Тому знімок «до
               акції» дорівнює самій ціні: акції тут просто немає. */
            listPrice: priceTotal,
            status: initialStatus,
            source: 'ADMIN',
            /* Те саме правило, що й у PATCH: план оплати дозволений
               приватній броні й турніру, але не звичайній групі. */
            ...(paymentPlan ? { paymentPlan } : {}),
            createdBy: actorEmail,
            ...(initialStatus === 'CONFIRMED' ? {
              confirmedBy: actorEmail,
              confirmedAt: new Date(),
            } : {}),
          },
          include: {
            court: {
              select: {
                name: true,
              },
            },
            trainer: {
              select: {
                id: true,
                name: true,
              },
            },
            rentals: true,
          },
        });
      });

    /* Повідомляємо і тут, а не тільки при бронюванні з віджета:
       адміністратор ставить заняття на тренера з кабінету так само часто,
       як гравець сам, — а для тренера це рівно та сама подія «мене
       викликали».

       skipClubChat: у спільну групу нічого не йде. Клуб щойно зробив це
       сам, і повідомляти його про власну дію — шум. З тієї ж причини
       actorUserId прибирає з розсилки того, хто натиснув: решта
       персоналу бронь побачить, автор — ні. */
    void notifyBooking({
      bookingId: booking.id,
      event: 'created',
      actorUserId: actor.userId,
      skipClubChat: true,
    });

    /* Відкрита гра без запрошень — просто порожня година в розкладі.
       Кличемо одразу і чекаємо на результат: кабінет показує список
       «кого покликали й чому» тим самим екраном, інакше «ми когось
       повідомили» доводиться брати на віру. Збій розсилки саму гру не
       скасовує — бронь уже створена й корт зайнятий. */
    const invited = booking.isOpenMatch
      ? await inviteMatch(booking.id).catch((e) => {
          console.error('[open-match] запрошення не розіслані', booking.id, e);
          return [];
        })
      : [];

    return { status: 201, body: booking.isOpenMatch ? { ...booking, invited } : booking };
  } catch (e) {
    if (isSlotTakenError(e)) {
      return { status: 409, body: {
        error: 'SLOT_TAKEN',
      } };
    }

    if (e instanceof RentalError) {
      return { status: e.status, body: { error: e.code, ...e.details } };
    }

    console.error(
      '[admin booking] create failed',
      e,
    );

    return { status: 500, body: {
      error: 'INTERNAL',
    } };
  }
}

export const patchBookingSchema = z
  .object({
    paymentPlan: paymentPlanSchema.optional(),
    status: z
      .enum([
        'PENDING',
        'CONFIRMED',
        'CANCELLED',
      ])
      .optional(),

    trainerId: z
      .string()
      .uuid()
      .nullable()
      .optional(),

    comment: z
      .string()
      .trim()
      .max(300)
      .nullable()
      .optional(),

    /* Назва й ціна місця — тільки для групової події (турніру).
       У приватної броні назви немає взагалі: там імʼя клієнта. */
    title: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional(),

    pricePerSeat: z
      .number()
      .int()
      .min(0)
      .max(10_000_00)
      .optional(),

    courtId: z
      .string()
      .uuid()
      .optional(),

    start: z
      .string()
      .datetime({
        offset: true,
      })
      .optional(),

    end: z
      .string()
      .datetime({
        offset: true,
      })
      .optional(),
  });

export async function patchAdminBooking(bookingId: string, p: PatchBookingInput, actor: BookingActor): Promise<BookingOutcome> {
  const clubId = actor.clubId;

  if (Object.keys(p).length === 0) {
    return { status: 400, body: {
      error: 'NOTHING_TO_UPDATE',
    } };
  }

  if (
    (p.start === undefined) !==
    (p.end === undefined)
  ) {
    return { status: 400, body: {
      error: 'START_AND_END_TOGETHER',
    } };
  }

  const booking =
    await prisma.booking.findFirst({
      where: {
        id: bookingId,
        clubId,
      },
      include: {
        payment: true,
        ledgerEntries: {
          where: { seatId: null },
        },
        rentals: true,
      },
    });

  if (!booking) {
    return { status: 404, body: {
      error: 'NOT_FOUND',
    } };
  }

  if (booking.tournamentScope === 'FEDERATION') return { status: 403, body: { error: 'FEDERATION_ONLY' } };
  if (booking.ratingsAppliedAt && (p.status === 'CANCELLED' || p.title !== undefined)) return { status: 409, body: { error: 'RATINGS_LOCKED' } };
  // Тренер на рівні 2 закриває власне заняття — і тільки його. Список
  // /bookings йому і так віддається звужений по trainerId, але PATCH
  // ходить по конкретному id: без цієї перевірки досить було б підглянути
  // чужий id, щоб скасувати чужу броню.
  if (actor.role === 'TRAINER') {
    if (
      !actor.trainerId ||
      booking.trainerId !== actor.trainerId
    ) {
      return { status: 404, body: {
        error: 'NOT_FOUND',
      } };
    }

    // Статус і коментар — так. Пересунути заняття на інший корт чи час,
    // а тим більше переписати його на іншого тренера, — ні: це вже
    // перекроювання чужої сітки, робота ресепшена.
    if (
      p.trainerId !== undefined ||
      p.paymentPlan !== undefined ||
      p.courtId !== undefined ||
      p.title !== undefined ||
      p.pricePerSeat !== undefined ||
      p.start !== undefined ||
      p.end !== undefined
    ) {
      return { status: 403, body: {
        error: 'FORBIDDEN',
        requiredRole: ['OWNER', 'ADMIN'],
      } };
    }
  }

  const data: Record<
    string,
    unknown
  > = {};

  /* План оплати є у приватної броні (домовленість із клієнтом) і в
     турніру (правило для реєстрацій). У звичайного групового заняття
     його немає: там кожне місце платить своїм способом, і одна
     домовленість на всіх була б неправдою в картці. */
  if (p.paymentPlan) {
    if (booking.capacity !== null && !isTournament(booking)) {
      return { status: 400, body: { error: 'BAD_REQUEST' } };
    }
    data.paymentPlan = await paymentPlanSnapshot(p.paymentPlan, actor.userId);
  }

  const start = p.start
    ? new Date(p.start)
    : booking.startTime;

  const end = p.end
    ? new Date(p.end)
    : booking.endTime;

  const moved = Boolean(
    p.start || p.courtId,
  );

  let movePricing: {
    court: CourtPriceResult;
    discountPercent: number;
  } | null = null;

  if (moved) {
    if (end <= start) {
      return { status: 400, body: {
        error: 'BAD_INTERVAL',
      } };
    }

    const courtId =
      p.courtId ??
      booking.courtId;

    const court =
      await prisma.court.findFirst({
        where: {
          id: courtId,
          clubId,
        },
      });

    if (!court) {
      return { status: 404, body: {
        error: 'COURT_NOT_FOUND',
      } };
    }

    data.courtId = court.id;
    data.startTime = start;
    data.endTime = end;

    /* Ціна перенесеної броні — за тим самим правилом, що й перенесення
       гравцем (POST /customer/bookings/:id/reschedule): корт з акціями +
       тренер, мінус персональна знижка. Інакше адміністратор, посунувши
       бронь зі знижкою, мовчки піднімав би їй ціну, а правило статусу
       робило б із різниці борг. Суму збираємо нижче, коли відомий тренер.
       Групу не чіпаємо: її priceTotal — це продані місця, а не корт. */
    if (booking.capacity === null) {
      const [club, customer] = await Promise.all([
        prisma.club.findUniqueOrThrow({
          where: { id: clubId },
          select: { timezone: true, slotMinutes: true, promos: { where: { isActive: true } } },
        }),
        booking.customerId
          ? prisma.customer.findUnique({
              where: { id: booking.customerId },
              select: { discountPercent: true, birthDate: true },
            })
          : null,
      ]);

      movePricing = {
        court: courtPriceWithPromos({
          pricePerHour: court.pricePerHour,
          start,
          end,
          timezone: club.timezone,
          courtId: court.id,
          slotMinutes: court.slotMinutes ?? club.slotMinutes,
          promos: club.promos,
          birthDate: customer?.birthDate,
        }),
        discountPercent: customer?.discountPercent ?? 0,
      };
    }
  }

  if (p.status !== undefined) {
    data.status = p.status;
    data.cancelledAt =
      p.status === 'CANCELLED'
        ? new Date()
        : null;
    if (p.status === 'CANCELLED') {
      const who = await prisma.user.findUniqueOrThrow({
        where: { id: actor.userId },
        select: { email: true, name: true, role: true },
      });
      data.cancelledBy = actor.viaAi
        ? { role: who.role, name: 'ІІ-менеджер', email: who.email }
        : who.role === 'OWNER'
          ? { role: 'OWNER' }
          : { role: who.role, name: who.name, email: who.email };
    } else {
      data.cancelledBy = null;
    }
  }

  if (p.comment !== undefined) {
    data.comment =
      p.comment === null ||
      p.comment === ''
        ? null
        : p.comment;
  }

  /* Назва й ціна місця — власність групової події. У приватної броні
     міняти нічого: там імʼя клієнта, а не назва, і ціна корту, а не
     місця. */
  if (p.title !== undefined || p.pricePerSeat !== undefined) {
    if (booking.capacity === null) {
      return { status: 400, body: { error: 'NOT_A_GROUP_BOOKING' } };
    }
    if (p.title !== undefined) {
      /* Маркер турніру зберігаємо: саме за ним старий API відрізняє
         турнір від звичайного групового заняття, і людина, яка стерла
         емодзі з поля назви, не мала на увазі «перетвори це на йогу». */
      data.title = isTournament(booking)
        ? tournamentTitle(p.title)
        : p.title;
    }
    if (p.pricePerSeat !== undefined) {
      /* Уже продані місця не дешевшають і не дорожчають: BookingSeat.price
         — знімок на момент запису, і переписати його заднім числом
         означало б підняти борг людині, яка вже заплатила рівно стільки,
         скільки в неї попросили. Нова ціна діє для нових реєстрацій. */
      data.pricePerSeat = p.pricePerSeat;
    }
  }

  if (p.trainerId !== undefined) {
    if (p.trainerId === null) {
      data.trainerId = null;
      data.trainerPrice = 0;

      data.priceTotal =
        (data.priceTotal as number ??
          booking.priceTotal) -
        booking.trainerPrice;
    } else {
      const trainer =
        await prisma.trainer.findFirst({
          where: {
            id: p.trainerId,
            clubId,
            isActive: true,
          },
        });

      if (!trainer) {
        return { status: 404, body: {
          error: 'TRAINER_NOT_FOUND',
        } };
      }

      const price =
        trainerCost(
          trainer.pricePerHour,
          start,
          end,
        );

      data.trainerId =
        trainer.id;

      data.trainerPrice =
        price;

      data.priceTotal =
        (data.priceTotal as number ??
          booking.priceTotal) -
        booking.trainerPrice +
        price;
    }
  }

  if (movePricing) {
    /* Тренер рахується на новий інтервал за поточною ставкою — як і в
       перенесенні гравцем. Якщо тренера змінили цим же PATCH, ціна вже
       порахована вище. */
    let trainerPrice = data.trainerPrice as number | undefined;
    if (trainerPrice === undefined) {
      const trainer = booking.trainerId
        ? await prisma.trainer.findFirst({
            where: { id: booking.trainerId, clubId },
            select: { pricePerHour: true },
          })
        : null;
      trainerPrice = trainer
        ? trainerCost(trainer.pricePerHour, start, end)
        : booking.trainerPrice;
      data.trainerPrice = trainerPrice;
    }

    /* Прокат — зверху й без знижки. rentalTotal поки старий: якщо прокат
       на новий час урізається, різницю врахує транзакція нижче, під
       замком на позиціях. */
    data.priceTotal =
      Math.round(
        ((movePricing.court.price + trainerPrice) *
          (100 - movePricing.discountPercent)) /
          100,
      ) +
      booking.rentalTotal;
    data.promoNames = movePricing.court.applied
      .map((promo) => promo.title?.trim())
      .filter((title): title is string => Boolean(title));
    data.promoDiscount = Math.max(
      0,
      movePricing.court.basePrice - movePricing.court.price,
    );
  }

  /* Прокат зачіпається, коли бронь переїжджає (на новий час ракеток може
     не бути) або повертається зі скасованих (поки вона була скасована,
     її ракетки могли взяти інші). Тоді ціна й статус рахуються в
     транзакції нижче — після того, як відомо, що лишилось від прокату. */
  const reactivating =
    p.status !== undefined &&
    p.status !== 'CANCELLED' &&
    !BUSY.includes(booking.status as never);
  const rentalWork =
    booking.capacity === null &&
    booking.rentals.length > 0 &&
    p.status !== 'CANCELLED' &&
    (moved || reactivating);

  /* Онлайн-холд підтверджує платіжний провайдер. Запис з оплатою на
     місці адміністратор може прийняти до оплати; борг лишається в касі. */
  if (!rentalWork && booking.capacity === null && p.status !== 'CANCELLED') {
    const settled = paymentStatusPatch({
      booking,
      finalPrice: (data.priceTotal as number | undefined) ?? booking.priceTotal,
      requestedStatus: p.status,
    });
    if (!settled.ok) return { status: 409, body: { error: settled.error } };
    Object.assign(data, settled.data);
  }

  const finalTrainerId =
    p.trainerId !== undefined
      ? p.trainerId
      : booking.trainerId;

  if (
    finalTrainerId &&
    (moved ||
      p.trainerId !== undefined)
  ) {
    const clash =
      await prisma.booking.findFirst({
        where: {
          id: {
            not: booking.id,
          },
          trainerId:
            finalTrainerId,
          status: {
            in: [...BUSY],
          },
          startTime: {
            lt: end,
          },
          endTime: {
            gt: start,
          },
        },
        select: {
          id: true,
        },
      });

    if (clash) {
      return { status: 409, body: {
        error: 'TRAINER_BUSY',
      } };
    }
  }

  let rentalShortages: MoveResult['shortages'] = [];

  try {
    if (rentalWork) {
      const actorEmail = (await prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { email: true } })).email + (actor.viaAi ? AI_MARK : '');

      rentalShortages = await prisma.$transaction(async (tx) => {
        let shortWarnings: MoveResult['shortages'] = [];

        if (moved) {
          /* Перенесення чек-листа не торкається: переїжджає бронь, а
             видане лишається виданим. Міняється тільки сума HOURLY-позицій
             — тривалість стала іншою, і ціна мусить збігтися з тим, що
             клієнт справді взяв. Нестача на новий час іде адміністратору
             попередженням: мовчки зрізати чужу бронь система права не
             має, це його розмова з клієнтом, а не наше рішення. */
          const move = await recalcRentalsForMove(tx, booking, booking.rentals, start, end);
          shortWarnings = move.shortages;

          data.priceTotal = (data.priceTotal as number) - booking.rentalTotal + move.rentalTotal;
          data.rentalTotal = move.rentalTotal;
        } else {
          /* Повернення зі скасованих на те саме місце — не перенесення:
             мовчки різати прокат тут нема підстав. Нехай адміністратор
             побачить нестачу й сам вирішить, що зняти. */
          const ids = booking.rentals.map((r) => r.itemId);
          const items = await lockRentableItems(tx, clubId, ids);
          const occupancy = await loadOccupancy(tx, clubId, ids, start, end, booking.id);
          const shortages = findShortages(
            booking.rentals.map((r) => ({ itemId: r.itemId, quantity: r.quantity })),
            items, occupancy, start, end,
          );
          if (shortages.length > 0) throw new RentalError(409, 'RENTAL_BUSY', { shortages });
        }

        const settled = paymentStatusPatch({
          booking,
          finalPrice: (data.priceTotal as number | undefined) ?? booking.priceTotal,
          requestedStatus: p.status,
        });
        if (!settled.ok) throw new SeatError(409, settled.error);
        Object.assign(data, settled.data);

        await tx.booking.update({
          where: { id: booking.id },
          data: {
            ...data,
            ...(data.status === 'CONFIRMED' && booking.status !== 'CONFIRMED' ? {
              confirmedBy: actorEmail,
              confirmedAt: new Date(),
            } : {}),
          },
        });

        return shortWarnings;
      });
    } else {
      await prisma.booking.update({
        where: {
          id: booking.id,
        },
        data: {
          ...data,
          ...(data.status === 'CONFIRMED' && booking.status !== 'CONFIRMED' ? {
            confirmedBy: (await prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { email: true } })).email,
            confirmedAt: new Date(),
          } : {}),
        },
      });
    }

    /* Скасування руками з кабінету. Тренер має дізнатись про це так
       само, як дізнався про сам виклик: він планує день по цих
       повідомленнях, і мовчазне зникнення заняття — гірше за його
       відсутність. Умова саме на ПЕРЕХІД: повторний PATCH тим самим
       статусом не має слати друге повідомлення. */
    if (data.status === 'CANCELLED' && booking.status !== 'CANCELLED') {
      void notifyBooking({
        bookingId: booking.id,
        event: 'cancelled',
        actorUserId: actor.userId,
        skipClubChat: true,
      });
    }

    /* Журнал змін. Пишемо ПІСЛЯ вдалого запису: рядок «переніс бронь»
       під відмову 409 гірший за відсутній — він стверджує те, чого не
       сталось.

       Статус, скасування й підтвердження в журнал не кладемо: у них є
       власні мітки часу (cancelledAt, confirmedAt), і історія броні вже
       показує їх поіменно. Дублювати означало б намалювати кожне
       скасування двічі. */
    const logged = diffFields(booking as unknown as Record<string, unknown>, data, [
      'comment', 'trainerId', 'title', 'pricePerSeat', 'priceTotal',
    ]);
    const move = moveChange(booking, {
      courtId: data.courtId as string | undefined,
      startTime: data.startTime as Date | undefined,
      endTime: data.endTime as Date | undefined,
    });
    if (move) logged.push(move);

    if (logged.length > 0) {
      const who = await prisma.user.findUniqueOrThrow({
        where: { id: actor.userId },
        select: { email: true, role: true },
      });
      /* Журнал не має права завалити саму правку: бронь уже змінена, і
         500 замість «готово» тут — це гірша брехня, ніж пропущений
         рядок. Помилку лишаємо в логах сервера. */
      await recordChanges(
        prisma,
        { clubId, entity: isTournament(booking) ? 'TOURNAMENT' : 'BOOKING', entityId: booking.id },
        { userId: actor.userId, email: who.email, role: who.role },
        logged,
      ).catch((e) => console.error('[change log] booking patch', e));
    }

    return {
      status: 200,
      body: {
      ok: true,
      /* Кабінет показує «на новий час вільна 1 з 2». Це попередження, а
         не відмова: прокат лишився в броні як був. */
      ...(rentalShortages.length > 0 ? { rentalShortages } : {}),
      },
    };
  } catch (e) {
    if (isSlotTakenError(e)) {
      return { status: 409, body: {
        error: 'SLOT_TAKEN',
      } };
    }

    if (e instanceof RentalError) {
      return { status: e.status, body: { error: e.code, ...e.details } };
    }

    if (e instanceof SeatError) {
      return { status: e.status, body: { error: e.code } };
    }

    throw e;
  }
}

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type PatchBookingInput = z.infer<typeof patchBookingSchema>;
