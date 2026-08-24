import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { isSearchableTail } from '../../lib/phone';
import { getActivePass, getActivePasses } from '../../lib/customers';
import { requireAuth, requireStaff, requireLevel, requireRole, param } from './shared';

export const customersRouter = Router();

/* CUSTOMERS                                                                  */
/* -------------------------------------------------------------------------- */

customersRouter.get(
  '/customers',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const parsed = z
      .object({
        q: z
          .string()
          .trim()
          .min(2)
          .max(40),
      })
      .safeParse(
        req.query,
      );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          'BAD_REQUEST',
      });
    }

    const q =
      parsed.data.q;

    const digits =
      q.replace(
        /\D/g,
        '',
      );

    const where =
      digits.length >= 4 &&
      isSearchableTail(
        digits,
      )
        ? {
            clubId:
              req.auth!.clubId,
            phoneTail: {
              endsWith:
                digits.slice(
                  -7,
                ),
            },
          }
        : {
            clubId:
              req.auth!.clubId,
            name: {
              contains: q,
              mode:
                'insensitive' as const,
            },
          };

    const customers =
      await prisma.customer.findMany({
        where,
        take: 10,
        orderBy: {
          name:
            'asc',
        },
      });

    const passes =
      await getActivePasses(
        customers.map(
          (c) => c.id,
        ),
      );

    res.json(
      customers.map(
        (c) => ({
          id: c.id,
          name: c.name,
          phone: c.phone,
          isBlocked:
            c.isBlocked,
          note: c.note,
          pass:
            passes.get(
              c.id,
            ) ?? null,
        }),
      ),
    );
  },
);

/* -------------------------------------------------------------------------- */
/* PASSES                                                                     */
/* -------------------------------------------------------------------------- */

customersRouter.post(
  '/customers/:id/passes',
  requireAuth,
  requireStaff,
  requireLevel(2),
  async (req, res) => {
    const parsed = z
      .object({
        type: z.enum([
          'PACKAGE',
          'UNLIMITED',
        ]),

        totalSessions:
          z.number()
            .int()
            .min(1)
            .max(200)
            .nullable()
            .optional(),

        validFrom:
          z.string()
            .datetime({
              offset: true,
            }),

        validUntil:
          z.string()
            .datetime({
              offset: true,
            }),

        price:
          z.number()
            .int()
            .min(0)
            .default(0),
      })
      .safeParse(
        req.body,
      );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          'BAD_REQUEST',
      });
    }

    const d =
      parsed.data;

    if (
      d.type ===
        'PACKAGE' &&
      !d.totalSessions
    ) {
      return res.status(400).json({
        error:
          'SESSIONS_REQUIRED',
      });
    }

    if (
      new Date(
        d.validUntil,
      ) <=
      new Date(
        d.validFrom,
      )
    ) {
      return res.status(400).json({
        error:
          'BAD_PERIOD',
      });
    }

    const customer =
      await prisma.customer.findFirst({
        where: {
          id: param(
            req,
            'id',
          ),

          clubId:
            req.auth!.clubId,
        },
      });

    if (!customer) {
      return res.status(404).json({
        error:
          'NOT_FOUND',
      });
    }

    const pass =
      await prisma.pass.create({
        data: {
          clubId:
            req.auth!.clubId,

          customerId:
            customer.id,

          type:
            d.type,

          totalSessions:
            d.type ===
            'PACKAGE'
              ? d.totalSessions!
              : null,

          validFrom:
            new Date(
              d.validFrom,
            ),

          validUntil:
            new Date(
              d.validUntil,
            ),

          price:
            d.price,
        },
      });

    res.status(201).json(
      pass,
    );
  },
);

/* -------------------------------------------------------------------------- */
/* USE PASS                                                                   */
/* -------------------------------------------------------------------------- */

customersRouter.post(
  '/bookings/:id/use-pass',
  requireAuth,
  requireStaff,
  requireLevel(2),
  async (req, res) => {
    const booking =
      await prisma.booking.findFirst({
        where: {
          id: param(
            req,
            'id',
          ),

          clubId:
            req.auth!.clubId,
        },
      });

    if (
      !booking ||
      !booking.customerId
    ) {
      return res.status(404).json({
        error:
          'NOT_FOUND',
      });
    }

    const existing =
      await prisma.passUsage.findUnique({
        where: {
          bookingId:
            booking.id,
        },
      });

    if (
      existing &&
      !existing.revertedAt
    ) {
      return res.status(409).json({
        error:
          'ALREADY_USED',
      });
    }

    const balance =
      await getActivePass(
        booking.customerId,
        booking.startTime,
      );

    if (!balance) {
      return res.status(409).json({
        error:
          'NO_ACTIVE_PASS',
      });
    }

    await prisma.$transaction([
      prisma.pass.update({
        where: {
          id:
            balance.passId,
        },

        data: {
          usedSessions: {
            increment:
              1,
          },
        },
      }),

      prisma.passUsage.create({
        data: {
          passId:
            balance.passId,

          bookingId:
            booking.id,

          by:
            req.auth!.userId,
        },
      }),
    ]);

    res.json({
      ok: true,
      left:
        balance.left === null
          ? null
          : balance.left - 1,
    });
  },
);

customersRouter.delete(
  '/bookings/:id/use-pass',
  requireAuth,
  requireStaff,
  requireLevel(2),
  async (req, res) => {
    const usage =
      await prisma.passUsage.findUnique({
        where: {
          bookingId:
            param(
              req,
              'id',
            ),
        },

        include: {
          pass: true,
        },
      });

    if (
      !usage ||
      usage.revertedAt ||
      usage.pass.clubId !==
        req.auth!.clubId
    ) {
      return res.status(404).json({
        error:
          'NOT_FOUND',
      });
    }

    await prisma.$transaction([
      prisma.pass.update({
        where: {
          id:
            usage.passId,
        },

        data: {
          usedSessions: {
            decrement:
              1,
          },
        },
      }),

      prisma.passUsage.update({
        where: {
          id:
            usage.id,
        },

        data: {
          revertedAt:
            new Date(),
        },
      }),
    ]);

    res.json({
      ok: true,
    });
  },
);


/**
 * PATCH /api/admin/customers/:id — картка клієнта: мітки, замітка, чорний список.
 *
 * До цього ці три поля існували в схемі, але змінити їх не було чим:
 * `note` і `isBlocked` заповнювались хіба що руками в базі. Мітки без
 * такого роуту були б так само мертві.
 *
 * Рівень 2, як і решта змін у кабінеті: «боржник» на картці — це те, що
 * побачить наступна зміна адміністраторів, і ставити його з відкритого
 * ноутбука на ресепшені без PIN не варто.
 */
customersRouter.patch(
  '/customers/:id',
  requireAuth,
  requireStaff,
  requireLevel(2),
  async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const parsed = z
      .object({
        /* Мітки приходять цілим списком, а не по одній: так у кабінеті
           не потрібні окремі «додати» й «прибрати», а гонка двох вкладок
           закінчується останнім збереженням, а не половиною списку. */
        /* Порожні рядки тут НЕ відхиляються: кабінет надсилає список
           цілком, і випадковий пробіл у полі не має валити збереження
           решти міток. Чистка нижче — вона ж прибирає дублі. */
        tags: z
          .array(z.string().max(40))
          .max(20)
          .optional(),
        note: z.string().trim().max(1000).nullable().optional(),
        isBlocked: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const d = parsed.data;
    if (d.tags === undefined && d.note === undefined && d.isBlocked === undefined) {
      return res.status(400).json({ error: 'NOTHING_TO_UPDATE' });
    }

    // Дублі й порожні мітки прибираємо тут, а не просимо кабінет стежити
    const tags = d.tags
      ? [...new Set(d.tags.map((t) => t.trim()).filter(Boolean))]
      : undefined;

    const { count } = await prisma.customer.updateMany({
      // clubId у where, а не окремою перевіркою: чужу картку не видно й не змінити
      where: { id: id.data, clubId: req.auth!.clubId },
      data: {
        ...(tags ? { tags } : {}),
        ...(d.note !== undefined ? { note: d.note } : {}),
        ...(d.isBlocked !== undefined ? { isBlocked: d.isBlocked } : {}),
      },
    });
    if (count === 0) return res.status(404).json({ error: 'NOT_FOUND' });

    const customer = await prisma.customer.findUnique({
      where: { id: id.data },
      select: { id: true, name: true, phone: true, tags: true, note: true, isBlocked: true },
    });
    res.json(customer);
  },
);
