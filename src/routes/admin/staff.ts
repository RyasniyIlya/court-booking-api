import { Router } from 'express';
import { z } from 'zod';
import { hashPassword } from '../../lib/passwordHash';

import { prisma } from '../../lib/db';
import { hasFeature, requireAuth, requireRole, param } from './shared';

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
        name: true,
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
 * Заводить акаунт у своєму клубі.
 *
 * OWNER — будь-яку роль. ADMIN — тільки TRAINER: модератор веде клуб
 * майже нарівні з власником, але не роздає доступ такого ж рівня, як
 * у себе. Інакше "майже нарівні" перестало б мати межу — досить завести
 * собі другий ADMIN-акаунт, і жодна дія вже не прив'язана до людини.
 *
 * TRAINER без trainerId зайти зможе, але /bookings йому завжди
 * поверне порожній список — прив'язку до картки тренера можна
 * додати пізніше через PATCH /trainers/:id чи окремий endpoint.
 */
staffRouter.post(
  '/staff',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const parsed = z
      .object({
        email: z.string().trim().toLowerCase().email(),
        name: z.string().trim().min(2).max(80).optional(),
        password: z.string().min(8).max(128),
        role: z.enum(['ADMIN', 'TRAINER', 'ACCOUNTANT']),
        trainerId: z.string().uuid().nullable().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    if (
      req.auth!.role !== 'OWNER' &&
      parsed.data.role !== 'TRAINER'
    ) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        requiredRole: ['OWNER'],
      });
    }

    if (parsed.data.role !== 'TRAINER' && !parsed.data.name) {
      return res.status(400).json({ error: 'NAME_REQUIRED' });
    }

    if (await prisma.user.findUnique({ where: { email: parsed.data.email } })) {
      return res.status(409).json({
        error: 'EMAIL_TAKEN',
      });
    }

    if (parsed.data.role === 'TRAINER' && !await hasFeature(req.auth!.clubId, 'trainers')) {
      return res.status(402).json({ error: 'PLAN_REQUIRED', feature: 'trainers' });
    }

    /* Бухгалтер без «Аналітики» побачив би тільки 402 на кожному запиті
       фінансів — акаунт без сенсу. Плани редагують без деплою, тому
       перевіряємо базу, а не токен, як і всюди на цьому шляху. */
    if (parsed.data.role === 'ACCOUNTANT' && !await hasFeature(req.auth!.clubId, 'analytics')) {
      return res.status(402).json({ error: 'PLAN_REQUIRED', feature: 'analytics' });
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

    const passwordHash = await hashPassword(parsed.data.password, 12);

    const user = await prisma.user.create({
      data: {
        clubId: req.auth!.clubId,
        name: parsed.data.name ?? null,
        email: parsed.data.email,
        passwordHash,
        role: parsed.data.role,
        trainerId: parsed.data.trainerId ?? null,
      },
      select: {
        id: true,
        name: true,
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
 * OWNER знімає будь-кого, ADMIN — тільки тренерів (симетрично до того,
 * кого кожен з них може завести). Себе не можна нікому: власник інакше
 * лишив би клуб без власника, модератор — без доступу до кабінету,
 * і обидва випадки розгрібаються тільки руками в базі.
 */
staffRouter.delete(
  '/staff/:id',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const id = param(req, 'id');

    if (id === req.auth!.userId) {
      return res.status(400).json({
        error: 'CANNOT_REMOVE_SELF',
      });
    }

    const target = await prisma.user.findFirst({
      where: {
        id,
        clubId: req.auth!.clubId,
      },
      select: { role: true },
    });

    if (!target) {
      return res.status(404).json({
        error: 'NOT_FOUND',
      });
    }

    if (
      req.auth!.role !== 'OWNER' &&
      target.role !== 'TRAINER'
    ) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        requiredRole: ['OWNER'],
      });
    }

    await prisma.user.delete({ where: { id } });

    res.json({ ok: true });
  },
);
