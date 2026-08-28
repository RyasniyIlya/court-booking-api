import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DateTime } from 'luxon';

import { prisma, isSlotTakenError } from '../../lib/db';
import { normalizePhone } from '../../lib/phone';
import { getActivePasses, findOrCreateCustomer } from '../../lib/customers';
import { requireAuth, requireStaff, requireLevel, hasFeature, param } from './shared';

export const bookingsRouter = Router();

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
            refundRequestedAt: true,
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
            /* У групі платить кожен за себе, тому й повертати доводиться
               поштучно — панель має показати гроші на рівні місця, а не
               заняття цілком. */
            payment: {
              select: {
                status: true,
                amount: true,
                refundRequestedAt: true,
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

    res.json(
      bookings.map((b) => ({
        ...b,
        pass: b.customerId
          ? passes.get(b.customerId) ?? null
          : null,
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
  requireLevel(2),
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
    const priceTotal = isGroup
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

    try {
      const booking =
        await prisma.booking.create({
          data: {
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
            status: d.status,
            source: 'ADMIN',
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
          },
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
  requireLevel(2),
  async (req, res) => {
    const parsed = z
      .object({
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
        p.courtId !== undefined ||
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

    const start = p.start
      ? new Date(p.start)
      : booking.startTime;

    const end = p.end
      ? new Date(p.end)
      : booking.endTime;

    const moved = Boolean(
      p.start || p.courtId,
    );

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

      const minutes =
        (end.getTime() -
          start.getTime()) /
        60_000;

      data.priceTotal =
        Math.round(
          (court.pricePerHour *
            minutes) /
            60,
        ) +
        booking.trainerPrice;
    }

    if (p.status !== undefined) {
      data.status = p.status;
      data.cancelledAt =
        p.status === 'CANCELLED'
          ? new Date()
          : null;
    }

    if (p.comment !== undefined) {
      data.comment =
        p.comment === null ||
        p.comment === ''
          ? null
          : p.comment;
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

    try {
      await prisma.booking.update({
        where: {
          id: booking.id,
        },
        data,
      });

      res.json({
        ok: true,
      });
    } catch (e) {
      if (isSlotTakenError(e)) {
        return res.status(409).json({
          error: 'SLOT_TAKEN',
        });
      }

      throw e;
    }
  },
);

/* -------------------------------------------------------------------------- */
/* BOOKING SERIES                                                             */
/* -------------------------------------------------------------------------- */

bookingsRouter.post(
  '/bookings/series',
  requireAuth,
  requireStaff,
  requireLevel(2),
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
                d.status,
              source:
                'ADMIN',
              seriesId,
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
  requireLevel(2),
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
        },
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
  requireLevel(2),
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
          { id: string; clubId: string; capacity: number | null; pricePerSeat: number | null }[]
        >`SELECT "id", "clubId", "capacity", "pricePerSeat"
            FROM "Booking" WHERE "id" = ${id.data}::uuid FOR UPDATE`;

        const b = rows[0];
        if (!b || b.clubId !== clubId) throw new SeatError(404, 'NOT_FOUND');
        if (b.capacity == null) throw new SeatError(400, 'NOT_A_GROUP');

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

        const price = b.pricePerSeat ?? 0;

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
  requireLevel(2),
  async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    try {
      await prisma.$transaction(async (tx) => {
        const seat = await tx.bookingSeat.findUnique({
          where: { id: id.data },
          include: { booking: { select: { id: true, clubId: true } } },
        });
        if (!seat || seat.booking.clubId !== req.auth!.clubId) {
          throw new SeatError(404, 'NOT_FOUND');
        }
        if (seat.status === 'CANCELLED' || seat.status === 'EXPIRED') return;

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
      });

      res.json({ ok: true });
    } catch (e) {
      if (e instanceof SeatError) return res.status(e.status).json({ error: e.code });
      console.error('[admin seat] cancel failed', e);
      res.status(500).json({ error: 'INTERNAL' });
    }
  },
);
