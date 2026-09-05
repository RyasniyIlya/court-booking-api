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

const trainerHoursSchema = z.array(z.object({
  weekday: z.number().int().min(0).max(6),
  openMinute: z.number().int().min(0).max(1799),
  closeMinute: z.number().int().min(0).max(1800),
  isClosed: z.boolean(),
}).superRefine((row, ctx) => {
  if (!row.isClosed && row.closeMinute <= row.openMinute) {
    ctx.addIssue({ code: 'custom', message: 'closeMinute must be after openMinute' });
  }
})).length(7).superRefine((rows, ctx) => {
  if (new Set(rows.map((row) => row.weekday)).size !== 7) {
    ctx.addIssue({ code: 'custom', message: 'Every weekday must be present once' });
  }
});

/**
 * Особистий графік тренера. Окремий `/me`, а не довільний id: навіть
 * підмінивши адресу запиту, тренер фізично не зможе переписати чужі години.
 */
trainersRouter.get('/trainer-hours/me', requireAuth, async (req, res) => {
  if (req.auth!.role !== 'TRAINER' || !req.auth!.trainerId) {
    return res.status(403).json({ error: 'TRAINER_NOT_LINKED' });
  }

  const trainer = await prisma.trainer.findFirst({
    where: { id: req.auth!.trainerId, clubId: req.auth!.clubId },
    select: {
      id: true,
      hours: { orderBy: { weekday: 'asc' } },
      club: { select: { hours: { orderBy: { weekday: 'asc' } } } },
    },
  });
  if (!trainer) return res.status(404).json({ error: 'TRAINER_NOT_FOUND' });

  res.json({
    configured: trainer.hours.length > 0,
    hours: trainer.hours.length > 0 ? trainer.hours : trainer.club.hours,
  });
});

trainersRouter.put(
  '/trainer-hours/me',
  requireAuth,
  requireLevel(2),
  requireFeature('trainers'),
  async (req, res) => {
    if (req.auth!.role !== 'TRAINER' || !req.auth!.trainerId) {
      return res.status(403).json({ error: 'TRAINER_NOT_LINKED' });
    }

    const parsed = trainerHoursSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const trainer = await prisma.trainer.findFirst({
      where: { id: req.auth!.trainerId, clubId: req.auth!.clubId },
      select: { id: true },
    });
    if (!trainer) return res.status(404).json({ error: 'TRAINER_NOT_FOUND' });

    await prisma.$transaction([
      prisma.trainerHours.deleteMany({ where: { trainerId: trainer.id } }),
      prisma.trainerHours.createMany({
        data: parsed.data.map((row) => ({ ...row, trainerId: trainer.id })),
      }),
    ]);

    res.json({ ok: true });
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
