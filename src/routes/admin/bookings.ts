import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DateTime } from 'luxon';

import { prisma, isSlotTakenError } from '../../lib/db';
import { normalizePhone } from '../../lib/phone';
import { getActivePasses, findOrCreateCustomer } from '../../lib/customers';
import { requireAuth, requireStaff, requireLevel, param } from './shared';

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
        /* Скільки місць зайнято зараз. Скасовані не рахуються, але з
           масиву не зникають — клуб має бачити, хто передумав. */
        seatsTaken: b.seats.filter(
          (s) => s.status === 'BOOKED',
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

