import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { paymentPlanSchema } from '../../lib/settlements';
import { z } from 'zod';
import { DateTime } from 'luxon';

import { prisma, isSlotTakenError } from '../../lib/db';
import { normalizePhone } from '../../lib/phone';
import { getActivePasses, findOrCreateCustomer } from '../../lib/customers';
import { requireAuth, requireStaff, param } from './shared';
import { notifyBooking, notifySeriesCancelled } from '../../lib/notifyBooking';
import { isRegistrationOpen } from '../../lib/registrationCutoff';
import {
  BUSY, SeatError, createAdminBooking, createBookingSchema, patchAdminBooking, patchBookingSchema,
  paymentPlanSnapshot, trainerCost,
} from '../../lib/adminBookings';

export const bookingsRouter = Router();

/* -------------------------------------------------------------------------- */
/* BOOKINGS                                                                   */
/* -------------------------------------------------------------------------- */

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
            /* Тільки ім'я й телефон — решту (нотатка персоналу, блокування,
               Telegram id) тренеру не віддаємо, див. нижче. */
            name: true,
            phone: true,
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
        /* Тренер бачить про гравця лише ім'я й телефон. Прапорець
           reminderReachable нижче рахується з telegramChatId, але сам id
           назовні не йде. */
        ...(req.auth!.role === 'TRAINER'
          ? { customer: b.customer ? { name: b.customer.name, phone: b.customer.phone } : null }
          : {}),
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
    if (req.body?.tournamentScope === 'FEDERATION' || req.body?.federationId) return res.status(403).json({ error: 'FEDERATION_ONLY' });
    const parsed = createBookingSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const out = await createAdminBooking(parsed.data, {
      clubId: req.auth!.clubId, userId: req.auth!.userId, role: req.auth!.role,
    });
    res.status(out.status).json(out.body);
  },
);

/**
 * PATCH /api/admin/bookings/:id
 */
bookingsRouter.patch(
  '/bookings/:id',
  requireAuth,
  async (req, res) => {
    if (req.body?.tournamentScope === 'FEDERATION' || req.body?.federationId) return res.status(403).json({ error: 'FEDERATION_ONLY' });
    const parsed = patchBookingSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const out = await patchAdminBooking(param(req, 'id'), parsed.data, {
      clubId: req.auth!.clubId, userId: req.auth!.userId, role: req.auth!.role, trainerId: req.auth!.trainerId,
    });
    res.status(out.status).json(out.body);
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
              /* Серія — те саме ручне створення, акцій тут не рахуємо. */
              listPrice: priceTotal,
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
