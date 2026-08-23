import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';

import { prisma } from '../../lib/db';
import { requireAuth, requireRole, param } from './shared';

export const staffRouter = Router();

/* STAFF                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/admin/staff
 *
 * Список акаунтів клубу. Тільки OWNER/ADMIN — тренер не має бачити,
 * хто ще має доступ до кабінету.
 */
staffRouter.get(
  '/staff',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const staff = await prisma.user.findMany({
      where: { clubId: req.auth!.clubId },
      select: {
        id: true,
        email: true,
        role: true,
        trainerId: true,
        createdAt: true,
        trainer: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json(staff);
  },
);

/**
 * POST /api/admin/staff
 *
 * Заводить акаунт ADMIN або TRAINER у своєму клубі. Тільки OWNER —
 * інакше ADMIN міг би плодити собі рівних.
 *
 * TRAINER без trainerId зайти зможе, але /bookings йому завжди
 * поверне порожній список — прив'язку до картки тренера можна
 * додати пізніше через PATCH /trainers/:id чи окремий endpoint.
 */
staffRouter.post(
  '/staff',
  requireAuth,
  requireRole('OWNER'),
  async (req, res) => {
    const parsed = z
      .object({
        email: z.string().trim().toLowerCase().email(),
        password: z.string().min(8).max(200),
        role: z.enum(['ADMIN', 'TRAINER']),
        trainerId: z.string().uuid().nullable().optional(),
        // Без цього новий співробітник заходив на LEVEL 1 і назавжди лишався
        // там: /elevate вимагає pinModerHash, а поставити його самому можна
        // тільки з LEVEL 2. Власник задає PIN одразу тут же, як і собі при
        // реєстрації клубу — той самий патерн, той самий /elevate потім.
        moderatorPin: z.string().regex(/^\d{4,8}$/).optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    if (await prisma.user.findUnique({ where: { email: parsed.data.email } })) {
      return res.status(409).json({
        error: 'EMAIL_TAKEN',
      });
    }

    if (parsed.data.trainerId) {
      const trainer = await prisma.trainer.findFirst({
        where: {
          id: parsed.data.trainerId,
          clubId: req.auth!.clubId,
        },
      });

      if (!trainer) {
        return res.status(400).json({
          error: 'TRAINER_NOT_FOUND',
        });
      }
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 10);

    const pinModerHash = parsed.data.moderatorPin
      ? await bcrypt.hash(parsed.data.moderatorPin, 12)
      : null;

    const user = await prisma.user.create({
      data: {
        clubId: req.auth!.clubId,
        email: parsed.data.email,
        passwordHash,
        role: parsed.data.role,
        trainerId: parsed.data.trainerId ?? null,
        pinModerHash,
      },
      select: {
        id: true,
        email: true,
        role: true,
        trainerId: true,
        createdAt: true,
      },
    });

    res.status(201).json(user);
  },
);

/**
 * DELETE /api/admin/staff/:id
 *
 * Тільки OWNER, і не можна видалити самого себе — інакше можна лишити
 * клуб без жодного власника.
 */
staffRouter.delete(
  '/staff/:id',
  requireAuth,
  requireRole('OWNER'),
  async (req, res) => {
    const id = param(req, 'id');

    if (id === req.auth!.userId) {
      return res.status(400).json({
        error: 'CANNOT_REMOVE_SELF',
      });
    }

    const result = await prisma.user.deleteMany({
      where: {
        id,
        clubId: req.auth!.clubId,
      },
    });

    if (result.count === 0) {
      return res.status(404).json({
        error: 'NOT_FOUND',
      });
    }

    res.json({ ok: true });
  },
);