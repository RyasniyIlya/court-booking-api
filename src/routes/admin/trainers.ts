import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { requireAuth, requireStaff, requireLevel, requireFeature, param } from './shared';
import { mountNoteRoutes } from './notes';

export const trainersRouter = Router();

/* TRAINERS                                                                   */
/* -------------------------------------------------------------------------- */

trainersRouter.get(
  '/trainers',
  requireAuth,
  async (req, res) => {
    const trainers =
      await prisma.trainer.findMany({
        where: {
          clubId:
            req.auth!.clubId,
        },
        orderBy: [
          {
            isActive:
              'desc',
          },
          {
            sortOrder:
              'asc',
          },
          {
            name:
              'asc',
          },
        ],
      });

    res.json(trainers);
  },
);

const trainerSchema =
  z.object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(80),

    phone: z
      .string()
      .trim()
      .max(30)
      .nullable()
      .optional(),

    pricePerHour: z
      .number()
      .int()
      .min(0)
      .max(10_000_00)
      .default(0),

    note: z
      .string()
      .trim()
      .max(200)
      .nullable()
      .optional(),

    sortOrder: z
      .number()
      .int()
      .min(0)
      .max(999)
      .default(0),

    isActive: z
      .boolean()
      .default(true),
  });

trainersRouter.post(
  '/trainers',
  requireAuth,
  requireStaff,
  requireLevel(2),
  requireFeature('trainers'),
  async (req, res) => {
    const parsed =
      trainerSchema.safeParse(
        req.body,
      );

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const trainer =
      await prisma.trainer.create({
        data: {
          ...parsed.data,
          clubId:
            req.auth!.clubId,
        },
      });

    res.status(201).json(
      trainer,
    );
  },
);

trainersRouter.patch(
  '/trainers/:id',
  requireAuth,
  requireStaff,
  requireLevel(2),
  requireFeature('trainers'),
  async (req, res) => {
    const parsed =
      trainerSchema
        .partial()
        .safeParse(
          req.body,
        );

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const result =
      await prisma.trainer.updateMany({
        where: {
          id: param(
            req,
            'id',
          ),
          clubId:
            req.auth!.clubId,
        },
        data:
          parsed.data,
      });

    if (
      result.count === 0
    ) {
      return res.status(404).json({
        error: 'NOT_FOUND',
      });
    }

    res.json({
      ok: true,
    });
  },
);

trainersRouter.delete(
  '/trainers/:id',
  requireAuth,
  requireStaff,
  requireLevel(2),
  requireFeature('trainers'),
  async (req, res) => {
    const trainer =
      await prisma.trainer.findFirst({
        where: {
          id: param(
            req,
            'id',
          ),
          clubId:
            req.auth!.clubId,
        },
      });

    if (!trainer) {
      return res.status(404).json({
        error: 'NOT_FOUND',
      });
    }

    const used =
      await prisma.booking.count({
        where: {
          trainerId:
            trainer.id,
        },
      });

    if (used > 0) {
      await prisma.trainer.update({
        where: {
          id: trainer.id,
        },
        data: {
          isActive:
            false,
        },
      });

      return res.json({
        ok: true,
        hidden: true,
        bookings:
          used,
      });
    }

    await prisma.trainer.delete({
      where: {
        id: trainer.id,
      },
    });

    res.json({
      ok: true,
      hidden: false,
    });
  },
);

/* ОСОБОВА СПРАВА (Note, subject = TRAINER)                                   */
/* -------------------------------------------------------------------------- */
//
// Приватний журнал персоналу про тренера — не плутати з Trainer.note (та одна
// й публічна, летить у віджет). Той самий рушій, що й у courts.ts — див.
// notes.ts. Пише тільки OWNER/ADMIN, тренер про себе тільки читає.

mountNoteRoutes(trainersRouter, {
  path: '/trainers/:id/notes',
  subject: 'TRAINER',
  findInClub: (clubId, id) =>
    prisma.trainer.findFirst({
      where: { id, clubId },
      select: { id: true },
    }),
  scope: (id) => ({ trainerId: id, courtId: null }),
  selfOnlyId: (req) => req.auth!.trainerId,
});
