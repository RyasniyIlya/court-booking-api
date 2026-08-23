import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { requireAuth, requireStaff, requireLevel, param } from './shared';
import { mountNoteRoutes } from './notes';

export const courtsRouter = Router();

/* COURTS                                                                     */
/* -------------------------------------------------------------------------- */

courtsRouter.get(
  '/courts',
  requireAuth,
  async (req, res) => {
    const courts =
      await prisma.court.findMany({
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

    res.json(courts);
  },
);

courtsRouter.post(
  '/courts',
  requireAuth,
  requireStaff,
  requireLevel(2),
  async (req, res) => {
    const parsed = z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(60),

        pricePerHour:
          z
            .number()
            .int()
            .min(0)
            .default(0),

        slotMinutes:
          z
            .number()
            .int()
            .min(15)
            .max(240)
            .nullable()
            .optional(),

        sortOrder:
          z
            .number()
            .int()
            .default(0),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const court =
      await prisma.court.create({
        data: {
          ...parsed.data,
          slotMinutes:
            parsed.data
              .slotMinutes ??
            null,
          clubId:
            req.auth!.clubId,
        },
      });

    res.status(201).json(
      court,
    );
  },
);

courtsRouter.patch(
  '/courts/:id',
  requireAuth,
  requireStaff,
  requireLevel(2),
  async (req, res) => {
    const parsed =
      z.object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .optional(),

        pricePerHour:
          z
            .number()
            .int()
            .min(0)
            .max(100_000_00)
            .optional(),

        slotMinutes:
          z
            .number()
            .int()
            .min(15)
            .max(240)
            .nullable()
            .optional(),

        sortOrder:
          z
            .number()
            .int()
            .min(0)
            .max(999)
            .optional(),

        isActive:
          z
            .boolean()
            .optional(),
      })
      .safeParse(
        req.body,
      );

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const result =
      await prisma.court.updateMany({
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

courtsRouter.delete(
  '/courts/:id',
  requireAuth,
  requireStaff,
  requireLevel(2),
  async (req, res) => {
    const court =
      await prisma.court.findFirst({
        where: {
          id: param(
            req,
            'id',
          ),
          clubId:
            req.auth!.clubId,
        },
      });

    if (!court) {
      return res.status(404).json({
        error: 'NOT_FOUND',
      });
    }

    const used =
      await prisma.booking.count({
        where: {
          courtId:
            court.id,
        },
      });

    if (used > 0) {
      await prisma.court.update({
        where: {
          id: court.id,
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

    await prisma.court.delete({
      where: {
        id: court.id,
      },
    });

    res.json({
      ok: true,
      hidden: false,
    });
  },
);

/* НОТАТКИ Й ВІДГУКИ (Note, subject = COURT)                                  */
/* -------------------------------------------------------------------------- */
//
// Той самий рушій, що й в особовій справі тренера — див. notes.ts. Запис без
// rating — довідкова замітка («20×40, ґрунт, для дітей»); запис з rating
// (1–5) — відгук персоналу про стан корту. Одна стрічка, а не дві вкладки:
// відгук — це та сама замітка, просто з оцінкою. У корту немає "власного"
// акаунта на кшталт тренерського, тому читання теж тільки персоналу.

mountNoteRoutes(courtsRouter, {
  path: '/courts/:id/notes',
  subject: 'COURT',
  findInClub: (clubId, id) =>
    prisma.court.findFirst({
      where: { id, clubId },
      select: { id: true },
    }),
  scope: (id) => ({ trainerId: null, courtId: id }),
  ratingAllowed: true,
  readRequiresStaff: true,
});

