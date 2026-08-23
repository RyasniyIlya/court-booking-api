import { Router } from 'express';
import { z } from 'zod';

import { prisma, isSlotTakenError } from '../../lib/db';
import { requireAuth, requireLevel, param } from './shared';

export const blocksRouter = Router();

/* BLOCKS                                                                     */
/* -------------------------------------------------------------------------- */

blocksRouter.get(
  '/blocks',
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
      .safeParse(
        req.query,
      );

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const blocks =
      await prisma.block.findMany({
        where: {
          clubId:
            req.auth!.clubId,

          startTime: {
            lt: new Date(
              parsed.data.to,
            ),
          },

          endTime: {
            gt: new Date(
              parsed.data.from,
            ),
          },
        },

        include: {
          court: {
            select: {
              name: true,
            },
          },
        },

        orderBy: {
          startTime:
            'asc',
        },
      });

    res.json(blocks);
  },
);

blocksRouter.post(
  '/blocks',
  requireAuth,
  requireLevel(2),
  async (req, res) => {
    const parsed = z
      .object({
        courtId:
          z.string()
            .uuid()
            .nullable()
            .optional(),

        start:
          z.string()
            .datetime({
              offset: true,
            }),

        end:
          z.string()
            .datetime({
              offset: true,
            }),

        reason:
          z.string()
            .max(200)
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

    const {
      courtId,
      start,
      end,
      reason,
    } = parsed.data;

    if (
      new Date(end) <=
      new Date(start)
    ) {
      return res.status(400).json({
        error:
          'BAD_INTERVAL',
      });
    }

    if (courtId) {
      const court =
        await prisma.court.findFirst({
          where: {
            id: courtId,
            clubId:
              req.auth!.clubId,
          },
        });

      if (!court) {
        return res.status(404).json({
          error:
            'COURT_NOT_FOUND',
        });
      }
    }

    try {
      const block =
        await prisma.block.create({
          data: {
            clubId:
              req.auth!.clubId,

            courtId:
              courtId ?? null,

            startTime:
              new Date(start),

            endTime:
              new Date(end),

            reason,
          },
        });

      res.status(201).json(
        block,
      );
    } catch (e) {
      if (isSlotTakenError(e)) {
        return res.status(409).json({
          error:
            'BLOCK_OVERLAP',
        });
      }

      throw e;
    }
  },
);

blocksRouter.delete(
  '/blocks/:id',
  requireAuth,
  requireLevel(2),
  async (req, res) => {
    const parsed =
      z.string()
        .uuid()
        .safeParse(
          param(
            req,
            'id',
          ),
        );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          'BAD_REQUEST',
      });
    }

    const result =
      await prisma.block.deleteMany({
        where: {
          id:
            parsed.data,

          clubId:
            req.auth!.clubId,
        },
      });

    if (
      result.count === 0
    ) {
      return res.status(404).json({
        error:
          'NOT_FOUND',
      });
    }

    res.json({
      ok: true,
    });
  },
);

