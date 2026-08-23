import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { requireAuth, requireStaff, requireLevel } from './shared';

export const hoursRouter = Router();

/* HOURS                                                                      */
/* -------------------------------------------------------------------------- */

hoursRouter.get(
  '/hours',
  requireAuth,
  async (req, res) => {
    const hours =
      await prisma.clubHours.findMany({
        where: {
          clubId:
            req.auth!.clubId,
        },
        orderBy: {
          weekday:
            'asc',
        },
      });

    res.json(hours);
  },
);

hoursRouter.put(
  '/hours',
  requireAuth,
  requireStaff,
  requireLevel(2),
  async (req, res) => {
    const parsed = z
      .array(
        z.object({
          weekday:
            z.number()
              .int()
              .min(0)
              .max(6),

          openMinute:
            z.number()
              .int()
              .min(0)
              .max(1440),

          closeMinute:
            z.number()
              .int()
              .min(0)
              .max(1680),

          isClosed:
            z.boolean()
              .default(false),
        }),
      )
      .length(7)
      .safeParse(
        req.body,
      );

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const clubId =
      req.auth!.clubId;

    await prisma.$transaction(
      parsed.data.map((h) =>
        prisma.clubHours.upsert({
          where: {
            clubId_weekday: {
              clubId,
              weekday:
                h.weekday,
            },
          },

          update: h,

          create: {
            ...h,
            clubId,
          },
        }),
      ),
    );

    res.json({
      ok: true,
    });
  },
);

