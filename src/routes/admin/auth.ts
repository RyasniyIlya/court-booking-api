import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';

import { prisma } from '../../lib/db';
import {
  type AccessLevel,
  requireAuth,
  requireLevel,
  param,
  signToken,
  verifyStepUpPin,
} from './shared';

export const authRouter = Router();

/**
 * IP-ліміти на вхід/PIN — другий рубіж поверх bcrypt і власного
 * pinFails/pinLockedUntil на елевейті. Той лічильник блокує один акаунт;
 * цей — заважає перебирати паролі/PIN одразу по багатьох акаунтах з однієї
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

const elevateLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
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

  password: z
    .string()
    .min(8)
    .max(128),

  moderatorPin: z
    .string()
    .regex(/^\d{4,8}$/),

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
 * - LEVEL 1
 * - пароль хранится только как bcrypt hash
 * - PIN модератора хранится только как bcrypt hash
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

  const moderatorPinHash = await bcrypt.hash(
    data.moderatorPin,
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
            pinModerHash: moderatorPinHash,
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

    // Рівень 2, а не 1: PIN модератора щойно заданий у цьому самому запиті —
    // перепитувати його одразу ж окремим /elevate було б абсурдним UX
    // ("ви щойно ввели PIN, а тепер введіть ще раз, щоб зберегти майстер").
    // 45 хвилин, а не 7 днів токена логіну: та сама тривалість, що й у
    // звичайного /elevate — рівень 2 залишається коротким вікном, навіть
    // коли отриманий одразу при реєстрації.
    const token = signToken(
      {
        userId: result.user.id,
        clubId: result.club.id,
        role: result.user.role,
        level: 2,
        trainerId: null,
      },
      '45m',
    );

    return res.status(201).json({
      token,
      level: 2,
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
 * Каждый обычный вход начинается с Level 1.
 *
 * Level 2 получается только через /elevate + PIN.
 */
authRouter.post('/login', loginLimiter, async (req, res) => {
  const parsed = z
    .object({
      email: z.string().email(),
      password: z.string().min(8),
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

  const valid = await bcrypt.compare(
    parsed.data.password,
    user.passwordHash,
  );

  if (!valid) {
    return res.status(401).json({
      error: 'INVALID_CREDENTIALS',
    });
  }

  const token = signToken(
    {
      userId: user.id,
      clubId: user.clubId,
      role: user.role,
      level: 1,
      trainerId: user.trainerId,
    },
    '7d',
  );

  return res.json({
    token,
    level: 1,
    role: user.role,
  });
});

/* -------------------------------------------------------------------------- */
/* ELEVATE                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/admin/elevate
 *
 * Перевіряє PIN модератора або власника.
 *
 * type: 'moderator' -> LEVEL 1/2 -> LEVEL 2
 * type: 'owner'      -> LEVEL 1/2 -> LEVEL 3 (тільки role OWNER)
 *
 * П'ять невдалих спроб — блокування на 15 хвилин (спільне для обох PIN).
 * Новий токен живе 45 хвилин.
 */
authRouter.post(
  '/elevate',
  elevateLimiter,
  requireAuth,
  async (req, res) => {
    const parsed = z
      .object({
        pin: z.string().regex(/^\d{4,8}$/),
        type: z.enum(['moderator', 'owner']).default('moderator'),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: req.auth!.userId,
      },
      select: {
        id: true,
        clubId: true,
        role: true,
        trainerId: true,
      },
    });

    if (!user) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
      });
    }

    const targetLevel: AccessLevel =
      parsed.data.type === 'owner' ? 3 : 2;

    if (targetLevel === 3 && user.role !== 'OWNER') {
      return res.status(403).json({
        error: 'FORBIDDEN',
      });
    }

    const field =
      parsed.data.type === 'owner' ? 'pinOwnerHash' : 'pinModerHash';

    const result = await verifyStepUpPin(
      user.id,
      parsed.data.pin,
      field,
    );

    if (!result.ok) {
      const status = result.reason === 'LOCKED' ? 423 : 403;
      return res.status(status).json({
        error:
          result.reason === 'LOCKED'
            ? 'PIN_LOCKED'
            : result.reason === 'NOT_SET'
              ? 'PIN_NOT_SET'
              : 'INVALID_PIN',
      });
    }

    const token = signToken(
      {
        userId: user.id,
        clubId: user.clubId,
        role: user.role,
        level: targetLevel,
        trainerId: user.trainerId,
      },
      '45m',
    );

    return res.json({
      token,
      level: targetLevel,
      expiresIn: 2700,
    });
  },
);

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
        pinOwnerHash: true,
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
      level: req.auth!.level,
      trainerId: user.trainerId,

      // Чи заведений PIN власника. Сам хеш, звісно, не віддаємо — потрібен
      // тільки факт: кабінет має розрізняти «введіть PIN» і «придумайте
      // PIN». Свіжозареєстрований клуб має лише PIN модератора (його
      // питають при реєстрації), тому рівень 3 — а з ним і платіжна
      // інтеграція — до цього був для нього просто недосяжним: майстер
      // пропонував увімкнути передоплату й отримував 403, а кнопка
      // «Режим власника» в шапці нічого не давала, бо PIN ще не існував.
      hasOwnerPin: Boolean(user.pinOwnerHash),
    });
  },
);

/* PIN SETTINGS                                                               */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/admin/pins
 *
 * Зміна власних PIN. Кожен акаунт задає PIN тільки собі — where завжди
 * по req.auth!.userId, підмінити чужий PIN так не вийде.
 *
 * moderatorPin — LEVEL 2, будь-яка роль.
 * ownerPin     — тільки role OWNER (інакше ADMIN міг би сам собі видати
 *                перепустку на LEVEL 3).
 */
authRouter.post(
  '/pins',
  requireAuth,
  requireLevel(2),
  async (req, res) => {
    const parsed = z
      .object({
        moderatorPin: z
          .string()
          .regex(/^\d{4,8}$/)
          .optional(),
        ownerPin: z
          .string()
          .regex(/^\d{4,8}$/)
          .optional(),
      })
      .refine(
        (v) => v.moderatorPin || v.ownerPin,
        { message: 'NOTHING_TO_UPDATE' },
      )
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    if (parsed.data.ownerPin && req.auth!.role !== 'OWNER') {
      return res.status(403).json({
        error: 'FORBIDDEN',
      });
    }

    const data: Record<string, string> = {};

    if (parsed.data.moderatorPin) {
      data.pinModerHash = await bcrypt.hash(
        parsed.data.moderatorPin,
        12,
      );
    }

    if (parsed.data.ownerPin) {
      data.pinOwnerHash = await bcrypt.hash(
        parsed.data.ownerPin,
        12,
      );
    }

    await prisma.user.update({
      where: {
        id: req.auth!.userId,
      },
      data,
    });

    res.json({
      ok: true,
    });
  },
);

