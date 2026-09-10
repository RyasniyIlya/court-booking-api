import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';

import { prisma } from '../../lib/db';
import {
  requireAuth,
  signToken,
  verifyAccountPassword,
} from './shared';
import { planFeatures } from '../../lib/plans';

export const authRouter = Router();

/**
 * IP-ліміти на вхід — другий рубіж поверх bcrypt і лічильника невдалих
 * спроб акаунта. Він блокує один акаунт; цей заважає перебирати паролі
 * одразу по багатьох акаунтах з однієї
 * адреси. standardHeaders: додає RateLimit-* у відповідь, щоб фронт міг
 * колись показати «спробуйте пізніше», а не просто ловити 429.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS' },
});

/* -------------------------------------------------------------------------- */
/* REGISTER                                                                   */
/* -------------------------------------------------------------------------- */

const registerSchema = z.object({
  clubName: z.string().trim().min(2).max(120),

  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(60)
    .regex(/^[a-z0-9-]+$/),

  email: z
    .string()
    .trim()
    .email()
    .toLowerCase(),

  password: z.string().min(8).max(128),

  phone: z
    .string()
    .trim()
    .max(30)
    .optional(),
});

/**
 * POST /api/admin/register
 *
 * Создаёт:
 * 1. клуб
 * 2. единственный аккаунт клуба
 *
 * Клуб получает:
 * - approvedAt = null
 * - widget ещё не активирован публично
 *
 * Аккаунт:
 * - роль визначає доступ
 * - єдиний пароль зберігається тільки як bcrypt hash
 */
authRouter.post('/register', registerLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'BAD_REQUEST',
      details: parsed.error.flatten(),
    });
  }

  const data = parsed.data;

  const existingUser = await prisma.user.findUnique({
    where: {
      email: data.email,
    },
    select: {
      id: true,
    },
  });

  if (existingUser) {
    return res.status(409).json({
      error: 'EMAIL_ALREADY_EXISTS',
    });
  }

  const existingClub = await prisma.club.findUnique({
    where: {
      slug: data.slug,
    },
    select: {
      id: true,
    },
  });

  if (existingClub) {
    return res.status(409).json({
      error: 'SLUG_ALREADY_EXISTS',
    });
  }

  const passwordHash = await bcrypt.hash(
    data.password,
    12,
  );

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const club = await tx.club.create({
          data: {
            name: data.clubName,
            slug: data.slug,
            phone: data.phone ?? null,

            approvedAt: null,
          },
        });

        // Дефолтні години — щодня 08:00–22:00. Без цього віджет показував би
        // "зачинено" всі сім днів, поки власник не дійде до кроку "Години"
        // в майстрі: свіжозареєстрований клуб має щось живе одразу, а не
        // порожню сітку в перші хвилини.
        await tx.clubHours.createMany({
          data: Array.from({ length: 7 }, (_, weekday) => ({
            clubId: club.id,
            weekday,
            openMinute: 8 * 60,
            closeMinute: 22 * 60,
          })),
        });

        const user = await tx.user.create({
          data: {
            email: data.email,
            passwordHash,
            role: 'OWNER',
            clubId: club.id,
          },
        });

        return {
          club,
          user,
        };
      },
    );

    const token = signToken(
      {
        userId: result.user.id,
        clubId: result.club.id,
        role: result.user.role,
        trainerId: null,
      },
      '7d',
    );

    return res.status(201).json({
      token,
      club: {
        id: result.club.id,
        name: result.club.name,
        slug: result.club.slug,
      },
    });
  } catch (error) {
    console.error('[admin register] failed', error);

    return res.status(500).json({
      error: 'INTERNAL',
    });
  }
});

/* -------------------------------------------------------------------------- */
/* LOGIN                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/admin/login
 *
 * Пошта визначає акаунт, його єдиний пароль підтверджує вхід, а роль у
 * токені визначає доступ. Повторного підтвердження для окремих дій немає.
 */
authRouter.post('/login', loginLimiter, async (req, res) => {
  const parsed = z
    .object({
      email: z.string().email(),
      password: z.string().min(1).max(128),
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'BAD_REQUEST',
    });
  }

  const email = parsed.data.email.toLowerCase();

  const user = await prisma.user.findUnique({
    where: {
      email,
    },
  });

  if (!user) {
    return res.status(401).json({
      error: 'INVALID_CREDENTIALS',
    });
  }

  const valid = await verifyAccountPassword(user.id, parsed.data.password);
  if (!valid.ok) return res.status(valid.reason === 'LOCKED' ? 423 : 401).json({
    error: valid.reason === 'LOCKED' ? 'PASSWORD_LOCKED' : 'INVALID_CREDENTIALS',
  });

  const token = signToken(
    {
      userId: user.id,
      clubId: user.clubId,
      role: user.role,
      trainerId: user.trainerId,
    },
    '7d',
  );

  return res.json({
    token,
    role: user.role,
  });
});

/* -------------------------------------------------------------------------- */
/* ME                                                                         */
/* -------------------------------------------------------------------------- */

authRouter.get(
  '/me',
  requireAuth,
  async (req, res) => {
    const user = await prisma.user.findUnique({
      where: {
        id: req.auth!.userId,
      },
      select: {
        id: true,
        email: true,
        role: true,
        clubId: true,
        trainerId: true,
        club: {
          select: {
            plan: {
              select: {
                name: true,
                tier: true,
                featTrainers: true,
                featGroups: true,
                featAnalytics: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({
        error: 'NOT_FOUND',
      });
    }

    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      clubId: user.clubId,
      trainerId: user.trainerId,

      /* Можливості за планом — тут, поруч із роллю, бо кабінет має
         отримувати обидві частини прав одним
         запитом. Через /billing їх не віддати: ту вкладку бачить не кожен,
         а ховати «Аналітику» треба до того, як хтось у неї зайде.
         Клуб без плану отримує повний набір — див. lib/plans.ts. */
      features: planFeatures(user.club?.plan),
      /* Назва рівня для підказки «доступно на плані ...» */
      planName: user.club?.plan?.name ?? null,
    });
  },
);

/* PASSWORD SETTINGS                                                          */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/admin/password
 *
 * Зміна власного пароля. Кожен акаунт задає пароль тільки собі — where
 * завжди по req.auth!.userId, підмінити чужий пароль так не вийде.
 *
 * У кожного акаунта рівно один пароль. Зміна впливає на наступний вхід.
 */
authRouter.post(
  '/password',
  requireAuth,
  async (req, res) => {
    const parsed = z
      .object({
        password: z.string().min(8).max(128),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);

    await prisma.user.update({
      where: {
        id: req.auth!.userId,
      },
      data: { passwordHash, pinFails: 0, pinLockedUntil: null },
    });

    res.json({
      ok: true,
    });
  },
);
