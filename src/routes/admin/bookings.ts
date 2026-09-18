import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { paymentPlanSchema } from '../../lib/settlements';
import { isTournament, tournamentTitle } from '../../lib/tournamentPay';
import { z } from 'zod';
import { DateTime } from 'luxon';

import { prisma, isSlotTakenError } from '../../lib/db';
import { normalizePhone } from '../../lib/phone';
import { getActivePasses, findOrCreateCustomer } from '../../lib/customers';
import { requireAuth, requireStaff, hasFeature, param } from './shared';
import { diffFields, moveChange, recordChanges } from '../../lib/changeLog';
import { notifyBooking, notifySeriesCancelled } from '../../lib/notifyBooking';
import { isRegistrationOpen } from '../../lib/registrationCutoff';
import { paymentStatusPatch } from '../../lib/bookingPaymentStatus';
import { courtPriceWithPromos, type CourtPriceResult } from '../../lib/promo';
import {
  RentalError, loadOccupancy, lockRentableItems, previewRentals, recalcRentalsForMove,
  rentalCreateData, reserveRentals,
} from '../../lib/rentalStore';
import {
  MAX_RENT_LINES, MAX_RENT_QUANTITY, findShortages, type MoveResult,
} from '../../lib/rentals';

export const bookingsRouter = Router();

async function paymentPlanSnapshot(plan: { method: string; account: string }, userId: string) {
  const actor = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  return { ...plan, by: actor.email, at: new Date().toISOString() };
}

/* BOOKINGS                                                                   */
/* -------------------------------------------------------------------------- */

const BUSY = [
  'PENDING',
  'CONFIRMED',
] as const;

const trainerCost = (
  pricePerHour: number,
  start: Date,
  end: Date,
) =>
  Math.round(
    (
      pricePerHour *
      ((end.getTime() - start.getTime()) / 60_000)
    ) / 60,
  );

/**
 * Вихід із транзакції з осмисленим кодом.
 *
 * Усередині prisma.$transaction звичайний res.status(...) не годиться:
 * транзакцію треба відкотити, а не тихо закомітити разом із помилкою.
 * Кидаємо — Prisma відкочує, обробник перекладає назад у HTTP.
 */
class SeatError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

/**
 * GET /api/admin/bookings
 *
 * LEVEL 1 достаточно для чтения.
 */
bookingsRouter.get(
  '/bookings',
  requireAuth,
  async (req, res) => {
    const parsed = z
      .object({
        from: z.string().datetime({
          offset: true,
        }),
        to: z.string().datetime({
          offset: true,
        }),
      })
      .safeParse(req.query);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    if (req.auth!.role === 'TRAINER' && !req.auth!.trainerId) {
      return res.json([]);
    }

    const bookings = await prisma.booking.findMany({
      where: {
        clubId: req.auth!.clubId,
        ...(req.auth!.role === 'TRAINER'
          ? { trainerId: req.auth!.trainerId! }
          : {}),
        startTime: {
          lt: new Date(parsed.data.to),
        },
        endTime: {
          gt: new Date(parsed.data.from),
        },
      },
      include: {
        ledgerEntries: req.auth!.role !== 'TRAINER' ? {
          where: { seatId: null },
          select: {
            id: true, kind: true, amount: true, method: true,
            account: true, note: true, actorEmail: true, actorRole: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        } : false,
        court: {
          select: {
            name: true,
          },
        },
        trainer: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
        payment: {
          select: {
            status: true,
            paidAt: true,
            amount: true,
            /* Щоб кабінет міг сказати «повернення в дорозі» замість того,
               щоб пропонувати натиснути кнопку вдруге. */
            refundRequestedAt: true, refundRequestedBy: true, provider: true, providerRef: true,
            refundedAt: true,
          },
        },
        customer: {
          select: {
            id: true,
            telegramChatId: true,
            isBlocked: true,
            note: true,
          },
        },
        /* Прокат: що видати й що ще не повернули. У групи рядків немає. */
        rentals: {
          orderBy: { createdAt: 'asc' },
        },
        /* Записані в групове заняття. У приватної броні масив завжди
           порожній — окремої гілки в запиті не потрібно. Беремо повний
           список, а не лічильник: панель броні все одно показує, ХТО
           записався, а на день таких записів десятки, не тисячі. */
        seats: {
          select: {
            id: true,
            customerName: true,
            customerPhone: true,
            status: true,
            price: true,
            /* Нагадування в Telegram і «Прийду» — панель показує їх біля
               кожного учасника, як і біля броні корту. */
            playerRemindedAt: true,
            playerConfirmedAt: true,
            ledgerEntries: req.auth!.role !== 'TRAINER'
              ? {
                select: {
                  id: true, kind: true, amount: true, method: true,
                  account: true, note: true, actorEmail: true, actorRole: true,
                  createdAt: true,
                },
                orderBy: { createdAt: 'asc' },
              }
              : false,
            /* У групі платить кожен за себе, тому й повертати доводиться
               поштучно — панель має показати гроші на рівні місця, а не
               заняття цілком. */
            payment: {
              select: {
                status: true,
                paidAt: true,
                amount: true,
                refundRequestedAt: true, refundRequestedBy: true, provider: true, providerRef: true,
                refundedAt: true,
              },
            },
          },
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
      orderBy: {
        startTime: 'asc',
      },
    });

    const ids = [
      ...new Set(
        bookings
          .map((b) => b.customerId)
          .filter(Boolean),
      ),
    ] as string[];

    const passes = await getActivePasses(ids);

    /* Журнал змін по всіх бронях дня — одним запитом, а не по одному на
       картку: правок за день одиниці, а запитів було б стільки ж, скільки
       броней. Тренеру не віддаємо: пошта того, хто переніс чуже заняття,
       — внутрішня кухня ресепшена. */
    const changes = req.auth!.role === 'TRAINER' ? [] : await prisma.changeLog.findMany({
      where: {
        clubId: req.auth!.clubId,
        entity: { in: ['BOOKING', 'TOURNAMENT'] },
        entityId: { in: bookings.map((b) => b.id) },
      },
      select: { entityId: true, field: true, before: true, after: true, actorEmail: true, actorRole: true, at: true },
      orderBy: { at: 'asc' },
    });

    /* Хто чекає на цей час у черзі. Одним запитом на весь діапазон, а
       розкладаємо по бронях у памʼяті: черг на день одиниці. */
    const queued = await prisma.waitlistEntry.findMany({
      where: {
        clubId: req.auth!.clubId,
        status: { in: ['WAITING', 'OFFERED'] },
        startTime: { lt: new Date(parsed.data.to) },
        endTime: { gt: new Date(parsed.data.from) },
      },
      select: { courtId: true, startTime: true, endTime: true },
    });
    const waitlistFor = (b: { courtId: string; startTime: Date; endTime: Date; capacity: number | null }) =>
      b.capacity != null ? 0 : queued.filter((w) => w.courtId === b.courtId
        && w.startTime < b.endTime && w.endTime > b.startTime).length;

    res.json(
      bookings.map((b) => ({
        ...b,
        changes: changes.filter((row) => row.entityId === b.id),
        pass: b.customerId
          ? passes.get(b.customerId) ?? null
          : null,
        waitlistCount: waitlistFor(b),
        reminderReachable: Boolean(
          b.customer?.telegramChatId,
        ),
        /* Скільки місць зайнято зараз. Скасовані й протухлі не рахуються,
           але з масиву не зникають — клуб має бачити, хто передумав.
           PENDING рахується: місце під оплатою нікому іншому не продати. */
        seatsTaken: b.seats.filter(
          (s) => s.status === 'BOOKED' || s.status === 'PENDING',
        ).length,
      })),
    );
  },
);

/**
 * POST /api/admin/bookings
 *
 * LEVEL 2.
 */
bookingsRouter.post(
  '/bookings',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const parsed = z
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
        if (d.capacity != null) {
          if (!d.title) {
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
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const d = parsed.data;
    const clubId = req.auth!.clubId;

    const start = new Date(d.start);
    const end = new Date(d.end);

    if (end <= start) {
      return res.status(400).json({
        error: 'BAD_INTERVAL',
      });
    }

    if (
      end.getTime() - start.getTime() >
      12 * 3600_000
    ) {
      return res.status(400).json({
        error: 'TOO_LONG',
      });
    }

    const court = await prisma.court.findFirst({
      where: {
        id: d.courtId,
        clubId,
      },
    });

    if (!court) {
      return res.status(404).json({
        error: 'COURT_NOT_FOUND',
      });
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
        return res.status(404).json({
          error: 'TRAINER_NOT_FOUND',
        });
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
        return res.status(409).json({
          error: 'TRAINER_BUSY',
        });
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
    if (isGroup && !(await hasFeature(req.auth!.clubId, 'groups'))) {
      return res.status(402).json({
        error: 'PLAN_REQUIRED',
        feature: 'groups',
      });
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
      return res.status(409).json({ error: 'RENTAL_NOT_AVAILABLE', itemId: rentalPreview.itemId });
    }

    const priceTotal = (!isGroup && d.priceTotal === undefined
      ? Math.round(priceBeforeDiscount * (100 - (customer?.discountPercent ?? 0)) / 100)
      : priceBeforeDiscount) + rentalPreview.total;

    const initialStatus = isGroup || priceTotal === 0
      ? d.status
      : 'PENDING';

    /* Усе, що читає базу поза самою броню, — до транзакції: вона тримає
       замок на ракетках, і чекати в ній на зайві запити нема чого. */
    const actorEmail = (await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId }, select: { email: true } })).email;
    const paymentPlan = d.paymentPlan && (!isGroup || isTournament(d))
      ? await paymentPlanSnapshot(d.paymentPlan, req.auth!.userId)
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
                ? d.title!
                : null,
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
        actorUserId: req.auth!.userId,
        skipClubChat: true,
      });

      res.status(201).json(
        booking,
      );
    } catch (e) {
      if (isSlotTakenError(e)) {
        return res.status(409).json({
          error: 'SLOT_TAKEN',
        });
      }

      if (e instanceof RentalError) {
        return res.status(e.status).json({ error: e.code, ...e.details });
      }

      console.error(
        '[admin booking] create failed',
        e,
      );

      res.status(500).json({
        error: 'INTERNAL',
      });
    }
  },
);

/**
 * PATCH /api/admin/bookings/:id
 */
bookingsRouter.patch(
  '/bookings/:id',
  requireAuth,
  async (req, res) => {
    const parsed = z
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
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const p = parsed.data;
    const clubId = req.auth!.clubId;

    if (Object.keys(p).length === 0) {
      return res.status(400).json({
        error: 'NOTHING_TO_UPDATE',
      });
    }

    if (
      (p.start === undefined) !==
      (p.end === undefined)
    ) {
      return res.status(400).json({
        error: 'START_AND_END_TOGETHER',
      });
    }

    const booking =
      await prisma.booking.findFirst({
        where: {
          id: param(req, 'id'),
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
      return res.status(404).json({
        error: 'NOT_FOUND',
      });
    }

    // Тренер на рівні 2 закриває власне заняття — і тільки його. Список
    // /bookings йому і так віддається звужений по trainerId, але PATCH
    // ходить по конкретному id: без цієї перевірки досить було б підглянути
    // чужий id, щоб скасувати чужу броню.
    if (req.auth!.role === 'TRAINER') {
      if (
        !req.auth!.trainerId ||
        booking.trainerId !== req.auth!.trainerId
      ) {
        return res.status(404).json({
          error: 'NOT_FOUND',
        });
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
        return res.status(403).json({
          error: 'FORBIDDEN',
          requiredRole: ['OWNER', 'ADMIN'],
        });
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
        return res.status(400).json({ error: 'BAD_REQUEST' });
      }
      data.paymentPlan = await paymentPlanSnapshot(p.paymentPlan, req.auth!.userId);
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
        return res.status(400).json({
          error: 'BAD_INTERVAL',
        });
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
        return res.status(404).json({
          error: 'COURT_NOT_FOUND',
        });
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
        const actor = await prisma.user.findUniqueOrThrow({
          where: { id: req.auth!.userId },
          select: { email: true, name: true, role: true },
        });
        data.cancelledBy = actor.role === 'OWNER'
          ? { role: 'OWNER' }
          : { role: actor.role, name: actor.name, email: actor.email };
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
        return res.status(400).json({ error: 'NOT_A_GROUP_BOOKING' });
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
          return res.status(404).json({
            error: 'TRAINER_NOT_FOUND',
          });
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
      if (!settled.ok) return res.status(409).json({ error: settled.error });
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
        return res.status(409).json({
          error: 'TRAINER_BUSY',
        });
      }
    }

    let rentalShortages: MoveResult['shortages'] = [];

    try {
      if (rentalWork) {
        const actorEmail = (await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId }, select: { email: true } })).email;

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
              confirmedBy: (await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId }, select: { email: true } })).email,
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
          actorUserId: req.auth!.userId,
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
          where: { id: req.auth!.userId },
          select: { email: true, role: true },
        });
        /* Журнал не має права завалити саму правку: бронь уже змінена, і
           500 замість «готово» тут — це гірша брехня, ніж пропущений
           рядок. Помилку лишаємо в логах сервера. */
        await recordChanges(
          prisma,
          { clubId, entity: isTournament(booking) ? 'TOURNAMENT' : 'BOOKING', entityId: booking.id },
          { userId: req.auth!.userId, email: who.email, role: who.role },
          logged,
        ).catch((e) => console.error('[change log] booking patch', e));
      }

      res.json({
        ok: true,
        /* Кабінет показує «на новий час вільна 1 з 2». Це попередження, а
           не відмова: прокат лишився в броні як був. */
        ...(rentalShortages.length > 0 ? { rentalShortages } : {}),
      });
    } catch (e) {
      if (isSlotTakenError(e)) {
        return res.status(409).json({
          error: 'SLOT_TAKEN',
        });
      }

      if (e instanceof RentalError) {
        return res.status(e.status).json({ error: e.code, ...e.details });
      }

      if (e instanceof SeatError) {
        return res.status(e.status).json({ error: e.code });
      }

      throw e;
    }
  },
);

/* -------------------------------------------------------------------------- */
/* BOOKING SERIES                                                            */
/* -------------------------------------------------------------------------- */

bookingsRouter.post(
  '/bookings/series',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const parsed = z
      .object({
        courtId: z.string().uuid(),
        start: z.string().datetime({
          offset: true,
        }),
        end: z.string().datetime({
          offset: true,
        }),
        /* Як і в одиночній броні: у групи імені немає, є назва.
           Перевіряє superRefine нижче. */
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
        weeks: z
          .number()
          .int()
          .min(2)
          .max(52),
        status: z
          .enum([
            'PENDING',
            'CONFIRMED',
          ])
          .default('CONFIRMED'),

        /* Регулярна група — «щовівторка йога». Саме заради цього серії
           й потрібні групам найбільше. */
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
      })
      .superRefine((d, ctx) => {
        if (d.capacity != null) {
          if (!d.title) {
            ctx.addIssue({
              code: 'custom',
              path: ['title'],
              message: 'Групове заняття без назви',
            });
          }
        } else if (!d.customerName) {
          ctx.addIssue({
            code: 'custom',
            path: ['customerName'],
            message: 'Бронь без імені',
          });
        }
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const d = parsed.data;
    const clubId =
      req.auth!.clubId;
    const isGroup =
      d.capacity != null;

    const first = new Date(
      d.start,
    );

    const firstEnd = new Date(
      d.end,
    );

    if (firstEnd <= first) {
      return res.status(400).json({
        error: 'BAD_INTERVAL',
      });
    }

    if (
      firstEnd.getTime() -
        first.getTime() >
      12 * 3600_000
    ) {
      return res.status(400).json({
        error: 'TOO_LONG',
      });
    }

    const club =
      await prisma.club.findUnique({
        where: {
          id: clubId,
        },
        select: {
          timezone: true,
        },
      });

    const court =
      await prisma.court.findFirst({
        where: {
          id: d.courtId,
          clubId,
        },
      });

    if (!court) {
      return res.status(404).json({
        error: 'COURT_NOT_FOUND',
      });
    }

    let trainer = null;

    if (d.trainerId) {
      trainer =
        await prisma.trainer.findFirst({
          where: {
            id: d.trainerId,
            clubId,
            isActive: true,
          },
        });

      if (!trainer) {
        return res.status(404).json({
          error: 'TRAINER_NOT_FOUND',
        });
      }
    }

    const minutes =
      (firstEnd.getTime() -
        first.getTime()) /
      60_000;

    const trainerPrice =
      trainer
        ? trainerCost(
            trainer.pricePerHour,
            first,
            firstEnd,
          )
        : 0;

    /* Група: виручка приходить із проданих місць, тому кожне заняття
       серії стартує з нуля — так само, як одиночне. */
    const priceTotal = isGroup
      ? 0
      : Math.round(
          (court.pricePerHour *
            minutes) /
            60,
        ) +
        trainerPrice;

    const phone = !isGroup && d.customerPhone
      ? normalizePhone(
          d.customerPhone,
        )
      : null;

    const customer = phone
      ? await findOrCreateCustomer({
          clubId,
          name: d.customerName!,
          rawPhone:
            d.customerPhone!,
        })
      : null;

    const initialStatus = isGroup || priceTotal === 0
      ? d.status
      : 'PENDING';

    const seriesId = randomUUID();

    const tz =
      club?.timezone ??
      'Europe/Kyiv';

    const startLocal =
      DateTime.fromJSDate(
        first,
      ).setZone(tz);

    const endLocal =
      DateTime.fromJSDate(
        firstEnd,
      ).setZone(tz);

    const created: {
      start: string;
      id: string;
    }[] = [];

    const skipped: {
      start: string;
      reason:
        | 'SLOT_TAKEN'
        | 'TRAINER_BUSY';
    }[] = [];

    for (
      let i = 0;
      i < d.weeks;
      i++
    ) {
      const s =
        startLocal
          .plus({
            weeks: i,
          })
          .toJSDate();

      const e =
        endLocal
          .plus({
            weeks: i,
          })
          .toJSDate();

      if (trainer) {
        const clash =
          await prisma.booking.findFirst({
            where: {
              trainerId:
                trainer.id,
              status: {
                in: [...BUSY],
              },
              startTime: {
                lt: e,
              },
              endTime: {
                gt: s,
              },
            },
            select: {
              id: true,
            },
          });

        if (clash) {
          skipped.push({
            start:
              s.toISOString(),
            reason:
              'TRAINER_BUSY',
          });

          continue;
        }
      }

      try {
        const booking =
          await prisma.booking.create({
            data: {
              clubId,
              courtId:
                court.id,
              customerName:
                isGroup
                  ? null
                  : d.customerName!,
              customerPhone:
                isGroup
                  ? null
                  : (phone?.e164 ?? ''),
              capacity:
                d.capacity ?? null,
              title: isGroup
                ? d.title!
                : null,
              pricePerSeat:
                isGroup
                  ? (d.pricePerSeat ?? 0)
                  : null,
              customerId:
                customer?.id ??
                null,
              trainerId:
                trainer?.id ??
                null,
              trainerPrice,
              comment:
                d.comment,
              startTime: s,
              endTime: e,
              priceTotal,
              status:
                initialStatus,
              source:
                'ADMIN',
              createdBy: (await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId }, select: { email: true } })).email,
              ...(initialStatus === 'CONFIRMED' ? {
                confirmedBy: (await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId }, select: { email: true } })).email,
                confirmedAt: new Date(),
              } : {}),
              seriesId,
              ...(d.paymentPlan && d.capacity == null ? { paymentPlan: await paymentPlanSnapshot(d.paymentPlan, req.auth!.userId) } : {}),
            },
            select: {
              id: true,
            },
          });

        created.push({
          start:
            s.toISOString(),
          id: booking.id,
        });
      } catch (err) {
        if (isSlotTakenError(err)) {
          skipped.push({
            start:
              s.toISOString(),
            reason:
              'SLOT_TAKEN',
          });

          continue;
        }

        console.error(
          '[series] create failed',
          err,
        );

        return res.status(500).json({
          error: 'INTERNAL',
          created,
          skipped,
        });
      }
    }

    if (
      created.length === 0
    ) {
      return res.status(409).json({
        error: 'ALL_TAKEN',
        created,
        skipped,
      });
    }

    res.status(201).json({
      seriesId,
      created,
      skipped,
    });
  },
);

bookingsRouter.post(
  '/series/:seriesId/cancel',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const parsed =
      z.string()
        .uuid()
        .safeParse(
          param(
            req,
            'seriesId',
          ),
        );

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const actor = await prisma.user.findUniqueOrThrow({
      where: { id: req.auth!.userId },
      select: { email: true, name: true, role: true },
    });

    /* Читаємо ДО updateMany: після нього ці заняття вже CANCELLED, і за
       тим самим where не знайдеться жодного. Без списку сповіщати нема
       про що — updateMany віддає лише кількість, а тренеру треба знати,
       які саме заняття зняли. */
    const doomed = await prisma.booking.findMany({
      where: {
        seriesId: parsed.data,
        clubId: req.auth!.clubId,
        status: { in: [...BUSY] },
        startTime: { gte: new Date() },
      },
      select: {
        trainerId: true,
        startTime: true,
        court: { select: { name: true } },
      },
    });

    const result =
      await prisma.booking.updateMany({
        where: {
          seriesId:
            parsed.data,
          clubId:
            req.auth!.clubId,
          status: {
            in: [...BUSY],
          },
          startTime: {
            gte: new Date(),
          },
        },
        data: {
          status:
            'CANCELLED',
          cancelledAt:
            new Date(),
          cancelledBy: actor.role === 'OWNER'
            ? { role: 'OWNER' }
            : { role: actor.role, name: actor.name, email: actor.email },
        },
      });

    /* Одне повідомлення на всю серію, а не на кожне заняття: тренеру з
       дванадцятьма щотижневими тренуваннями дванадцять однакових рядків
       поспіль сказали б менше, ніж один рядок із числом. */
    void notifySeriesCancelled({
      clubId: req.auth!.clubId,
      actorUserId: req.auth!.userId,
      bookings: doomed.map((b) => ({
        trainerId: b.trainerId,
        startTime: b.startTime,
        courtName: b.court.name,
      })),
    });

    res.json({
      ok: true,
      cancelled:
        result.count,
    });
  },
);


/* -------------------------------------------------------------------------- */
/* МІСЦЯ В ГРУПОВИХ ЗАНЯТТЯХ                                                  */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/admin/bookings/:id/seats — записати людину руками.
 *
 * Половина записів у групу приходить телефоном: людина дзвонить на
 * ресепшен, а не тисне кнопку у віджеті. Без цього роуту адміністратор
 * бачив би заняття, у яке не може нікого вписати, і вів би паралельний
 * список у зошиті — а зошит не вміє рахувати вільні місця.
 *
 * Телефон тут обовʼязковий, на відміну від звичайної броні. Причина
 * технічна й чесна: місця розрізняються по (заняття, телефон), і двоє
 * безіменних із порожнім номером просто не влізли б у той самий індекс.
 * Причина людська та сама: заняття переносять, і групу треба обдзвонити.
 */
bookingsRouter.post(
  '/bookings/:id/seats',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const parsed = z
      .object({
        customerName: z.string().trim().min(1).max(80),
        customerPhone: z.string().trim().min(5).max(30),
        comment: z.string().trim().max(300).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const d = parsed.data;
    const clubId = req.auth!.clubId;

    const phone = normalizePhone(d.customerPhone);
    if (!phone) return res.status(400).json({ error: 'BAD_PHONE' });

    const customer = await findOrCreateCustomer({
      clubId,
      name: d.customerName,
      rawPhone: d.customerPhone,
    });

    try {
      const seat = await prisma.$transaction(async (tx) => {
        /* Той самий FOR UPDATE, що й у публічному записі: ресепшен і
           гравець можуть тиснути в одну мілісекунду на останнє місце. */
        const rows = await tx.$queryRaw<
          { id: string; clubId: string; capacity: number | null; pricePerSeat: number | null; startTime: Date }[]
        >`SELECT "id", "clubId", "capacity", "pricePerSeat", "startTime"
            FROM "Booking" WHERE "id" = ${id.data}::uuid FOR UPDATE`;

        const b = rows[0];
        if (!b || b.clubId !== clubId) throw new SeatError(404, 'NOT_FOUND');
        if (b.capacity == null) throw new SeatError(400, 'NOT_A_GROUP');
        if (!isRegistrationOpen(b.startTime)) throw new SeatError(409, 'REGISTRATION_CLOSED');

        /* PENDING зайняте нарівні з BOOKED: місце, за яке гравець саме
           зараз платить у віджеті, ресепшен не має віддати іншому. */
        const HELD = ['BOOKED', 'PENDING'] as const;

        const taken = await tx.bookingSeat.count({
          where: { bookingId: b.id, status: { in: [...HELD] } },
        });
        if (taken >= b.capacity) throw new SeatError(409, 'GROUP_FULL');

        const already = await tx.bookingSeat.findFirst({
          where: { bookingId: b.id, customerPhone: phone.e164, status: { in: [...HELD] } },
          select: { id: true },
        });
        if (already) throw new SeatError(409, 'ALREADY_JOINED');

        const price = Math.round((b.pricePerSeat ?? 0) * (100 - (customer?.discountPercent ?? 0)) / 100);

        const created = await tx.bookingSeat.create({
          data: {
            bookingId: b.id,
            customerId: customer?.id ?? null,
            customerName: d.customerName,
            customerPhone: phone.e164,
            comment: d.comment,
            price,
            source: 'ADMIN',
          },
        });

        await tx.booking.update({
          where: { id: b.id },
          data: { priceTotal: { increment: price } },
        });

        return created;
      });

      /* Половина записів у групу приходить телефоном, і тренер має знати
         про них так само, як про тих, хто записався сам у віджеті. */
      void notifyBooking({
        bookingId: seat.bookingId,
        seatId: seat.id,
        event: 'created',
        actorUserId: req.auth!.userId,
        skipClubChat: true,
      });

      res.status(201).json(seat);
    } catch (e) {
      if (e instanceof SeatError) return res.status(e.status).json({ error: e.code });
      console.error('[admin seat] create failed', e);
      res.status(500).json({ error: 'INTERNAL' });
    }
  },
);

/**
 * POST /api/admin/seats/:id/cancel — прибрати запис.
 *
 * Вікном скасування (Club.cancelCutoffMinutes) адміністратор НЕ обмежений:
 * воно існує, щоб гравець не відписувався від підготовленого заняття за
 * пʼять хвилин, а клуб домовляється голосом і має право зняти запис
 * будь-коли — зокрема саме тоді, коли гравець зателефонував і попросив.
 */
bookingsRouter.post(
  '/seats/:id/cancel',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    try {
      /* Транзакція каже, чи справді щось знято: вже скасоване або протухле
         місце виходить через `return null`, і сповіщати про нього нема про
         що — нічого не змінилось. */
      const cancelled = await prisma.$transaction(async (tx) => {
        const seat = await tx.bookingSeat.findUnique({
          where: { id: id.data },
          include: { booking: { select: { id: true, clubId: true } } },
        });
        if (!seat || seat.booking.clubId !== req.auth!.clubId) {
          throw new SeatError(404, 'NOT_FOUND');
        }
        if (seat.status === 'CANCELLED' || seat.status === 'EXPIRED') return null;

        /* Місце під оплатою знімається так само (клуб має право), але
           виручку чіпати нічим: неоплачене місце в priceTotal не входило
           — його додає вебхук (див. lib/payments/apply.ts). */
        const wasPaid = seat.status === 'BOOKED';

        await tx.bookingSeat.update({
          where: { id: seat.id },
          data: { status: 'CANCELLED', cancelledAt: new Date(), expiresAt: null },
        });
        if (wasPaid) {
          await tx.booking.update({
            where: { id: seat.booking.id },
            data: { priceTotal: { decrement: seat.price } },
          });
        }

        return { bookingId: seat.booking.id, seatId: seat.id };
      });

      /* Після коміту, а не всередині: транзакція може відкотитись, і
         повідомлення про зняте місце пішло б у чат раніше, ніж стало
         правдою — а забрати його звідти вже не можна. */
      if (cancelled) {
        void notifyBooking({
          ...cancelled,
          event: 'cancelled',
          actorUserId: req.auth!.userId,
          skipClubChat: true,
        });
      }

      res.json({ ok: true });
    } catch (e) {
      if (e instanceof SeatError) return res.status(e.status).json({ error: e.code });
      console.error('[admin seat] cancel failed', e);
      res.status(500).json({ error: 'INTERNAL' });
    }
  },
);
