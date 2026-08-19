import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from 'express';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DateTime } from 'luxon';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';

import { JWT_SECRET } from '../lib/authSecret';

import { prisma, isSlotTakenError } from '../lib/db';
import {
  normalizePhone,
  isSearchableTail,
} from '../lib/phone';

import {
  getActivePasses,
  getActivePass,
  findOrCreateCustomer,
} from '../lib/customers';

import {
  KNOWN_PROVIDERS,
  publicBase,
} from '../lib/payments';

import {
  encryptSecret,
  paymentsSecretReady,
} from '../lib/crypto';

import {
  clubBilling,
  GRACE_DAYS,
  PERIOD_PRICE,
} from '../lib/billing';

export const adminRouter = Router();

/* -------------------------------------------------------------------------- */
/* AUTH                                                                       */
/* -------------------------------------------------------------------------- */

type AccessLevel = 1 | 2 | 3;

type Auth = {
  userId: string;
  clubId: string;
  role: string;
  level: AccessLevel;
  /// Тільки для role === 'TRAINER'. Яку картку тренера бачить цей акаунт.
  trainerId: string | null;
};

declare global {
  namespace Express {
    interface Request {
      auth?: Auth;
    }
  }
}

const SECRET = JWT_SECRET;

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

function param(req: Request, name: string): string {
  const value = (
    req.params as Record<string, string | string[] | undefined>
  )[name];

  return Array.isArray(value)
    ? (value[0] ?? '')
    : (value ?? '');
}

function signToken(auth: Auth, expiresIn: string) {
  return jwt.sign(auth, SECRET, {
    expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
  });
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
    });
  }

  try {
    const payload = jwt.verify(
      header.slice(7),
      SECRET,
    ) as Partial<Auth>;

    if (
      typeof payload.userId !== 'string' ||
      typeof payload.clubId !== 'string' ||
      typeof payload.role !== 'string' ||
      (payload.level !== 1 && payload.level !== 2 && payload.level !== 3)
    ) {
      return res.status(401).json({
        error: 'INVALID_TOKEN',
      });
    }

    req.auth = {
      userId: payload.userId,
      clubId: payload.clubId,
      role: payload.role,
      level: payload.level,
      trainerId: payload.trainerId ?? null,
    };

    next();
  } catch {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
    });
  }
}

function requireLevel(level: AccessLevel) {
  return (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (!req.auth) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
      });
    }

    if (req.auth.level < level) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        requiredLevel: level,
        currentLevel: req.auth.level,
      });
    }

    next();
  };
}

export function requireRole(...roles: string[]) {
  return (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (!req.auth) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
      });
    }

    if (!roles.includes(req.auth.role)) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        requiredRole: roles,
      });
    }

    next();
  };
}

const MAX_PIN_FAILS = 5;
const PIN_LOCK_MINUTES = 15;

/**
 * Перевіряє PIN (moder/owner) з блокуванням після невдалих спроб.
 * Лічильник і блокування спільні для обох PIN одного акаунта — прицільний
 * підбір "просто спробую власника" так само вважається невдалою спробою.
 */
async function verifyStepUpPin(
  userId: string,
  pin: string,
  field: 'pinModerHash' | 'pinOwnerHash',
): Promise<
  | { ok: true }
  | { ok: false; reason: 'LOCKED' | 'NOT_SET' | 'INVALID_PIN' }
> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      pinModerHash: true,
      pinOwnerHash: true,
      pinFails: true,
      pinLockedUntil: true,
    },
  });

  if (!user) {
    return { ok: false, reason: 'NOT_SET' };
  }

  if (user.pinLockedUntil && user.pinLockedUntil > new Date()) {
    return { ok: false, reason: 'LOCKED' };
  }

  const hash = user[field];

  if (!hash) {
    return { ok: false, reason: 'NOT_SET' };
  }

  const valid = await bcrypt.compare(pin, hash);

  if (!valid) {
    const fails = user.pinFails + 1;
    const locked = fails >= MAX_PIN_FAILS;

    await prisma.user.update({
      where: { id: userId },
      data: {
        pinFails: fails,
        pinLockedUntil: locked
          ? new Date(Date.now() + PIN_LOCK_MINUTES * 60000)
          : undefined,
      },
    });

    return { ok: false, reason: 'INVALID_PIN' };
  }

  if (user.pinFails > 0 || user.pinLockedUntil) {
    await prisma.user.update({
      where: { id: userId },
      data: { pinFails: 0, pinLockedUntil: null },
    });
  }

  return { ok: true };
}

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
adminRouter.post('/register', registerLimiter, async (req, res) => {
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

    const token = signToken(
      {
        userId: result.user.id,
        clubId: result.club.id,
        role: result.user.role,
        level: 1,
        trainerId: null,
      },
      '7d',
    );

    return res.status(201).json({
      token,
      level: 1,
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
adminRouter.post('/login', loginLimiter, async (req, res) => {
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
adminRouter.post(
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

adminRouter.get(
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
    });
  },
);

/* -------------------------------------------------------------------------- */
/* BOOKINGS                                                                   */
/* -------------------------------------------------------------------------- */

const BUSY = [
  'PENDING',
  'CONFIRMED',
] as const;

const trainerCost = (
  pricePerHour: number,
  start: Date,
  end: Date,
) =>
  Math.round(
    (
      pricePerHour *
      ((end.getTime() - start.getTime()) / 60_000)
    ) / 60,
  );

/**
 * GET /api/admin/bookings
 *
 * LEVEL 1 достаточно для чтения.
 */
adminRouter.get(
  '/bookings',
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
      .safeParse(req.query);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    if (req.auth!.role === 'TRAINER' && !req.auth!.trainerId) {
      return res.json([]);
    }

    const bookings = await prisma.booking.findMany({
      where: {
        clubId: req.auth!.clubId,
        ...(req.auth!.role === 'TRAINER'
          ? { trainerId: req.auth!.trainerId! }
          : {}),
        startTime: {
          lt: new Date(parsed.data.to),
        },
        endTime: {
          gt: new Date(parsed.data.from),
        },
      },
      include: {
        court: {
          select: {
            name: true,
          },
        },
        trainer: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
        payment: {
          select: {
            status: true,
            paidAt: true,
            amount: true,
          },
        },
        customer: {
          select: {
            id: true,
            telegramChatId: true,
            isBlocked: true,
            note: true,
          },
        },
      },
      orderBy: {
        startTime: 'asc',
      },
    });

    const ids = [
      ...new Set(
        bookings
          .map((b) => b.customerId)
          .filter(Boolean),
      ),
    ] as string[];

    const passes = await getActivePasses(ids);

    res.json(
      bookings.map((b) => ({
        ...b,
        pass: b.customerId
          ? passes.get(b.customerId) ?? null
          : null,
        reminderReachable: Boolean(
          b.customer?.telegramChatId,
        ),
      })),
    );
  },
);

/**
 * POST /api/admin/bookings
 *
 * LEVEL 2.
 */
adminRouter.post(
  '/bookings',
  requireAuth,
  requireLevel(2),
  async (req, res) => {
    const parsed = z
      .object({
        courtId: z.string().uuid(),
        start: z.string().datetime({
          offset: true,
        }),
        end: z.string().datetime({
          offset: true,
        }),
        customerName: z
          .string()
          .trim()
          .min(1)
          .max(80),

        customerPhone: z
          .string()
          .trim()
          .max(30)
          .optional(),

        trainerId: z
          .string()
          .uuid()
          .nullable()
          .optional(),

        comment: z
          .string()
          .trim()
          .max(300)
          .optional(),

        status: z
          .enum([
            'PENDING',
            'CONFIRMED',
          ])
          .default('CONFIRMED'),

        priceTotal: z
          .number()
          .int()
          .min(0)
          .max(100_000_000)
          .optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const d = parsed.data;
    const clubId = req.auth!.clubId;

    const start = new Date(d.start);
    const end = new Date(d.end);

    if (end <= start) {
      return res.status(400).json({
        error: 'BAD_INTERVAL',
      });
    }

    if (
      end.getTime() - start.getTime() >
      12 * 3600_000
    ) {
      return res.status(400).json({
        error: 'TOO_LONG',
      });
    }

    const court = await prisma.court.findFirst({
      where: {
        id: d.courtId,
        clubId,
      },
    });

    if (!court) {
      return res.status(404).json({
        error: 'COURT_NOT_FOUND',
      });
    }

    let trainer = null;

    if (d.trainerId) {
      trainer = await prisma.trainer.findFirst({
        where: {
          id: d.trainerId,
          clubId,
          isActive: true,
        },
      });

      if (!trainer) {
        return res.status(404).json({
          error: 'TRAINER_NOT_FOUND',
        });
      }

      const clash = await prisma.booking.findFirst({
        where: {
          trainerId: trainer.id,
          status: {
            in: [...BUSY],
          },
          startTime: {
            lt: end,
          },
          endTime: {
            gt: start,
          },
        },
        select: {
          id: true,
        },
      });

      if (clash) {
        return res.status(409).json({
          error: 'TRAINER_BUSY',
        });
      }
    }

    const minutes =
      (end.getTime() - start.getTime()) /
      60_000;

    const trainerPrice = trainer
      ? trainerCost(
          trainer.pricePerHour,
          start,
          end,
        )
      : 0;

    const courtPrice = Math.round(
      (court.pricePerHour * minutes) / 60,
    );

    const priceTotal =
      d.priceTotal ??
      courtPrice +
        trainerPrice;

    const phone = d.customerPhone
      ? normalizePhone(
          d.customerPhone,
        )
      : null;

    const customer = phone
      ? await findOrCreateCustomer({
          clubId,
          name: d.customerName,
          rawPhone: d.customerPhone!,
        })
      : null;

    try {
      const booking =
        await prisma.booking.create({
          data: {
            clubId,
            courtId: court.id,
            customerName: d.customerName,
            customerPhone:
              phone?.e164 ?? '',
            customerId:
              customer?.id ?? null,
            trainerId:
              trainer?.id ?? null,
            trainerPrice,
            comment: d.comment,
            startTime: start,
            endTime: end,
            priceTotal,
            status: d.status,
            source: 'ADMIN',
          },
          include: {
            court: {
              select: {
                name: true,
              },
            },
            trainer: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        });

      res.status(201).json(
        booking,
      );
    } catch (e) {
      if (isSlotTakenError(e)) {
        return res.status(409).json({
          error: 'SLOT_TAKEN',
        });
      }

      console.error(
        '[admin booking] create failed',
        e,
      );

      res.status(500).json({
        error: 'INTERNAL',
      });
    }
  },
);

/**
 * PATCH /api/admin/bookings/:id
 */
adminRouter.patch(
  '/bookings/:id',
  requireAuth,
  requireLevel(2),
  async (req, res) => {
    const parsed = z
      .object({
        status: z
          .enum([
            'PENDING',
            'CONFIRMED',
            'CANCELLED',
          ])
          .optional(),

        trainerId: z
          .string()
          .uuid()
          .nullable()
          .optional(),

        comment: z
          .string()
          .trim()
          .max(300)
          .nullable()
          .optional(),

        courtId: z
          .string()
          .uuid()
          .optional(),

        start: z
          .string()
          .datetime({
            offset: true,
          })
          .optional(),

        end: z
          .string()
          .datetime({
            offset: true,
          })
          .optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const p = parsed.data;
    const clubId = req.auth!.clubId;

    if (Object.keys(p).length === 0) {
      return res.status(400).json({
        error: 'NOTHING_TO_UPDATE',
      });
    }

    if (
      (p.start === undefined) !==
      (p.end === undefined)
    ) {
      return res.status(400).json({
        error: 'START_AND_END_TOGETHER',
      });
    }

    const booking =
      await prisma.booking.findFirst({
        where: {
          id: param(req, 'id'),
          clubId,
        },
      });

    if (!booking) {
      return res.status(404).json({
        error: 'NOT_FOUND',
      });
    }

    const data: Record<
      string,
      unknown
    > = {};

    const start = p.start
      ? new Date(p.start)
      : booking.startTime;

    const end = p.end
      ? new Date(p.end)
      : booking.endTime;

    const moved = Boolean(
      p.start || p.courtId,
    );

    if (moved) {
      if (end <= start) {
        return res.status(400).json({
          error: 'BAD_INTERVAL',
        });
      }

      const courtId =
        p.courtId ??
        booking.courtId;

      const court =
        await prisma.court.findFirst({
          where: {
            id: courtId,
            clubId,
          },
        });

      if (!court) {
        return res.status(404).json({
          error: 'COURT_NOT_FOUND',
        });
      }

      data.courtId = court.id;
      data.startTime = start;
      data.endTime = end;

      const minutes =
        (end.getTime() -
          start.getTime()) /
        60_000;

      data.priceTotal =
        Math.round(
          (court.pricePerHour *
            minutes) /
            60,
        ) +
        booking.trainerPrice;
    }

    if (p.status !== undefined) {
      data.status = p.status;
      data.cancelledAt =
        p.status === 'CANCELLED'
          ? new Date()
          : null;
    }

    if (p.comment !== undefined) {
      data.comment =
        p.comment === null ||
        p.comment === ''
          ? null
          : p.comment;
    }

    if (p.trainerId !== undefined) {
      if (p.trainerId === null) {
        data.trainerId = null;
        data.trainerPrice = 0;

        data.priceTotal =
          (data.priceTotal as number ??
            booking.priceTotal) -
          booking.trainerPrice;
      } else {
        const trainer =
          await prisma.trainer.findFirst({
            where: {
              id: p.trainerId,
              clubId,
              isActive: true,
            },
          });

        if (!trainer) {
          return res.status(404).json({
            error: 'TRAINER_NOT_FOUND',
          });
        }

        const price =
          trainerCost(
            trainer.pricePerHour,
            start,
            end,
          );

        data.trainerId =
          trainer.id;

        data.trainerPrice =
          price;

        data.priceTotal =
          (data.priceTotal as number ??
            booking.priceTotal) -
          booking.trainerPrice +
          price;
      }
    }

    const finalTrainerId =
      p.trainerId !== undefined
        ? p.trainerId
        : booking.trainerId;

    if (
      finalTrainerId &&
      (moved ||
        p.trainerId !== undefined)
    ) {
      const clash =
        await prisma.booking.findFirst({
          where: {
            id: {
              not: booking.id,
            },
            trainerId:
              finalTrainerId,
            status: {
              in: [...BUSY],
            },
            startTime: {
              lt: end,
            },
            endTime: {
              gt: start,
            },
          },
          select: {
            id: true,
          },
        });

      if (clash) {
        return res.status(409).json({
          error: 'TRAINER_BUSY',
        });
      }
    }

    try {
      await prisma.booking.update({
        where: {
          id: booking.id,
        },
        data,
      });

      res.json({
        ok: true,
      });
    } catch (e) {
      if (isSlotTakenError(e)) {
        return res.status(409).json({
          error: 'SLOT_TAKEN',
        });
      }

      throw e;
    }
  },
);

/* -------------------------------------------------------------------------- */
/* BOOKING SERIES                                                             */
/* -------------------------------------------------------------------------- */

adminRouter.post(
  '/bookings/series',
  requireAuth,
  requireLevel(2),
  async (req, res) => {
    const parsed = z
      .object({
        courtId: z.string().uuid(),
        start: z.string().datetime({
          offset: true,
        }),
        end: z.string().datetime({
          offset: true,
        }),
        customerName: z
          .string()
          .trim()
          .min(1)
          .max(80),
        customerPhone: z
          .string()
          .trim()
          .max(30)
          .optional(),
        trainerId: z
          .string()
          .uuid()
          .nullable()
          .optional(),
        comment: z
          .string()
          .trim()
          .max(300)
          .optional(),
        weeks: z
          .number()
          .int()
          .min(2)
          .max(52),
        status: z
          .enum([
            'PENDING',
            'CONFIRMED',
          ])
          .default('CONFIRMED'),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const d = parsed.data;
    const clubId =
      req.auth!.clubId;

    const first = new Date(
      d.start,
    );

    const firstEnd = new Date(
      d.end,
    );

    if (firstEnd <= first) {
      return res.status(400).json({
        error: 'BAD_INTERVAL',
      });
    }

    if (
      firstEnd.getTime() -
        first.getTime() >
      12 * 3600_000
    ) {
      return res.status(400).json({
        error: 'TOO_LONG',
      });
    }

    const club =
      await prisma.club.findUnique({
        where: {
          id: clubId,
        },
        select: {
          timezone: true,
        },
      });

    const court =
      await prisma.court.findFirst({
        where: {
          id: d.courtId,
          clubId,
        },
      });

    if (!court) {
      return res.status(404).json({
        error: 'COURT_NOT_FOUND',
      });
    }

    let trainer = null;

    if (d.trainerId) {
      trainer =
        await prisma.trainer.findFirst({
          where: {
            id: d.trainerId,
            clubId,
            isActive: true,
          },
        });

      if (!trainer) {
        return res.status(404).json({
          error: 'TRAINER_NOT_FOUND',
        });
      }
    }

    const minutes =
      (firstEnd.getTime() -
        first.getTime()) /
      60_000;

    const trainerPrice =
      trainer
        ? trainerCost(
            trainer.pricePerHour,
            first,
            firstEnd,
          )
        : 0;

    const priceTotal =
      Math.round(
        (court.pricePerHour *
          minutes) /
          60,
      ) +
      trainerPrice;

    const phone = d.customerPhone
      ? normalizePhone(
          d.customerPhone,
        )
      : null;

    const customer = phone
      ? await findOrCreateCustomer({
          clubId,
          name: d.customerName,
          rawPhone:
            d.customerPhone!,
        })
      : null;

    const seriesId = randomUUID();

    const tz =
      club?.timezone ??
      'Europe/Kyiv';

    const startLocal =
      DateTime.fromJSDate(
        first,
      ).setZone(tz);

    const endLocal =
      DateTime.fromJSDate(
        firstEnd,
      ).setZone(tz);

    const created: {
      start: string;
      id: string;
    }[] = [];

    const skipped: {
      start: string;
      reason:
        | 'SLOT_TAKEN'
        | 'TRAINER_BUSY';
    }[] = [];

    for (
      let i = 0;
      i < d.weeks;
      i++
    ) {
      const s =
        startLocal
          .plus({
            weeks: i,
          })
          .toJSDate();

      const e =
        endLocal
          .plus({
            weeks: i,
          })
          .toJSDate();

      if (trainer) {
        const clash =
          await prisma.booking.findFirst({
            where: {
              trainerId:
                trainer.id,
              status: {
                in: [...BUSY],
              },
              startTime: {
                lt: e,
              },
              endTime: {
                gt: s,
              },
            },
            select: {
              id: true,
            },
          });

        if (clash) {
          skipped.push({
            start:
              s.toISOString(),
            reason:
              'TRAINER_BUSY',
          });

          continue;
        }
      }

      try {
        const booking =
          await prisma.booking.create({
            data: {
              clubId,
              courtId:
                court.id,
              customerName:
                d.customerName,
              customerPhone:
                phone?.e164 ?? '',
              customerId:
                customer?.id ??
                null,
              trainerId:
                trainer?.id ??
                null,
              trainerPrice,
              comment:
                d.comment,
              startTime: s,
              endTime: e,
              priceTotal,
              status:
                d.status,
              source:
                'ADMIN',
              seriesId,
            },
            select: {
              id: true,
            },
          });

        created.push({
          start:
            s.toISOString(),
          id: booking.id,
        });
      } catch (err) {
        if (isSlotTakenError(err)) {
          skipped.push({
            start:
              s.toISOString(),
            reason:
              'SLOT_TAKEN',
          });

          continue;
        }

        console.error(
          '[series] create failed',
          err,
        );

        return res.status(500).json({
          error: 'INTERNAL',
          created,
          skipped,
        });
      }
    }

    if (
      created.length === 0
    ) {
      return res.status(409).json({
        error: 'ALL_TAKEN',
        created,
        skipped,
      });
    }

    res.status(201).json({
      seriesId,
      created,
      skipped,
    });
  },
);

adminRouter.post(
  '/series/:seriesId/cancel',
  requireAuth,
  requireLevel(2),
  async (req, res) => {
    const parsed =
      z.string()
        .uuid()
        .safeParse(
          param(
            req,
            'seriesId',
          ),
        );

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const result =
      await prisma.booking.updateMany({
        where: {
          seriesId:
            parsed.data,
          clubId:
            req.auth!.clubId,
          status: {
            in: [...BUSY],
          },
          startTime: {
            gte: new Date(),
          },
        },
        data: {
          status:
            'CANCELLED',
          cancelledAt:
            new Date(),
        },
      });

    res.json({
      ok: true,
      cancelled:
        result.count,
    });
  },
);

/* -------------------------------------------------------------------------- */
/* TRAINERS                                                                   */
/* -------------------------------------------------------------------------- */

adminRouter.get(
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

adminRouter.post(
  '/trainers',
  requireAuth,
  requireLevel(2),
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

adminRouter.patch(
  '/trainers/:id',
  requireAuth,
  requireLevel(2),
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

adminRouter.delete(
  '/trainers/:id',
  requireAuth,
  requireLevel(2),
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

/* -------------------------------------------------------------------------- */
/* COURTS                                                                     */
/* -------------------------------------------------------------------------- */

adminRouter.get(
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

adminRouter.post(
  '/courts',
  requireAuth,
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

adminRouter.patch(
  '/courts/:id',
  requireAuth,
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

adminRouter.delete(
  '/courts/:id',
  requireAuth,
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

/* -------------------------------------------------------------------------- */
/* HOURS                                                                      */
/* -------------------------------------------------------------------------- */

adminRouter.get(
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

adminRouter.put(
  '/hours',
  requireAuth,
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

/* -------------------------------------------------------------------------- */
/* CLUB                                                                       */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/club',
  requireAuth,
  async (req, res) => {
    const club =
      await prisma.club.findUnique({
        where: {
          id: req.auth!.clubId,
        },
      });

    if (!club) {
      return res.status(404).json({
        error: 'NOT_FOUND',
      });
    }

    res.json({
      name: club.name,
      slug: club.slug,
      timezone: club.timezone,
      phone: club.phone,
      address: club.address,
      logoUrl: club.logoUrl,
      brandColor:
        club.brandColor,
      telegramChatId:
        club.telegramChatId,
      slotMinutes:
        club.slotMinutes,
      leadTimeMinutes:
        club.leadTimeMinutes,
      horizonDays:
        club.horizonDays,
      autoConfirm:
        club.autoConfirm,
      prepayEnabled:
        club.prepayEnabled,
      prepayRequired:
        club.prepayRequired,
      paymentProvider:
        club.paymentProvider,
      payHoldMinutes:
        club.payHoldMinutes,

      hasPaymentToken:
        Boolean(
          club.paymentTokenEnc,
        ),

      webhookUrl:
        `${publicBase()}/api/pay/webhook/${club.id}`,

      approvedAt:
        club.approvedAt,

      paidUntil:
        club.paidUntil,

      isActive:
        club.isActive,
    });
  },
);

adminRouter.patch(
  '/club',
  requireAuth,
  requireLevel(2),
  async (req, res) => {
    const parsed = z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .optional(),

        phone:
          z.string()
            .trim()
            .max(30)
            .nullable()
            .optional(),

        address:
          z.string()
            .trim()
            .max(200)
            .nullable()
            .optional(),

        logoUrl:
          z.string()
            .trim()
            .max(500)
            .regex(/^https:\/\/\S+$/)
            .nullable()
            .optional(),

        telegramChatId:
          z.string()
            .trim()
            .max(60)
            .nullable()
            .optional(),

        brandColor:
          z.string()
            .trim()
            .regex(
              /^#[0-9A-Fa-f]{6}$/,
            )
            .nullable()
            .optional(),

        timezone:
          z.string()
            .trim()
            .max(64)
            .optional(),

        slotMinutes:
          z.number()
            .int()
            .min(15)
            .max(180)
            .optional(),

        leadTimeMinutes:
          z.number()
            .int()
            .min(0)
            .max(1440)
            .optional(),

        horizonDays:
          z.number()
            .int()
            .min(1)
            .max(90)
            .optional(),

        autoConfirm:
          z.boolean()
            .optional(),

        billingPeriod:
          z.enum([
            'MONTH',
            'QUARTER',
            'YEAR',
          ])
            .optional(),

        prepayEnabled:
          z.boolean()
            .optional(),

        prepayRequired:
          z.boolean()
            .optional(),

        paymentProvider:
          z.enum(
            KNOWN_PROVIDERS,
          )
            .nullable()
            .optional(),

        payHoldMinutes:
          z.number()
            .int()
            .min(5)
            .max(60)
            .optional(),

        paymentToken:
          z.string()
            .trim()
            .min(10)
            .max(400)
            .nullable()
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
      paymentToken,
      ...rest
    } = parsed.data;

    const paymentFieldsTouched =
      paymentToken !== undefined ||
      rest.prepayEnabled !== undefined ||
      rest.prepayRequired !== undefined ||
      rest.paymentProvider !== undefined ||
      rest.payHoldMinutes !== undefined;

    // Платіжна інтеграція — гроші клубу йдуть повз нас напряму на його
    // еквайринг, тому переприв'язати токен має право тільки LEVEL 3.
    if (paymentFieldsTouched && req.auth!.level < 3) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        requiredLevel: 3,
        currentLevel: req.auth!.level,
      });
    }

    const data: Record<
      string,
      unknown
    > = {
      ...rest,
    };

    if (
      paymentToken !== undefined
    ) {
      if (
        paymentToken === null
      ) {
        data.paymentTokenEnc =
          null;
      } else {
        if (
          !paymentsSecretReady()
        ) {
          return res.status(503).json({
            error:
              'PAYMENTS_SECRET_MISSING',
          });
        }

        data.paymentTokenEnc =
          encryptSecret(
            paymentToken,
          );
      }
    }

    if (rest.timezone) {
      const current =
        await prisma.club.findUnique({
          where: {
            id: req.auth!.clubId,
          },
          select: {
            timezone: true,
          },
        });

      if (
        current &&
        current.timezone !==
          rest.timezone
      ) {
        const bookings =
          await prisma.booking.count({
            where: {
              clubId:
                req.auth!.clubId,
            },
          });

        if (bookings > 0) {
          return res.status(409).json({
            error:
              'TIMEZONE_LOCKED',
          });
        }
      }
    }

    const club =
      await prisma.club.update({
        where: {
          id: req.auth!.clubId,
        },
        data,
      });

    res.json({
      name: club.name,
      slug: club.slug,
      phone: club.phone,
      address:
        club.address,
      logoUrl:
        club.logoUrl,
      brandColor:
        club.brandColor,
      telegramChatId:
        club.telegramChatId,
      prepayEnabled:
        club.prepayEnabled,
      prepayRequired:
        club.prepayRequired,
      paymentProvider:
        club.paymentProvider,
      payHoldMinutes:
        club.payHoldMinutes,
      hasPaymentToken:
        Boolean(
          club.paymentTokenEnc,
        ),
      webhookUrl:
        `${publicBase()}/api/pay/webhook/${club.id}`,
    });
  },
);

/* -------------------------------------------------------------------------- */
/* BILLING                                                                    */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/billing',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const club =
      await prisma.club.findUnique({
        where: {
          id: req.auth!.clubId,
        },
        select: {
          paidUntil: true,
          billingPeriod: true,
          isActive: true,
          createdAt: true,
        },
      });

    if (!club) {
      return res.status(404).json({
        error: 'NOT_FOUND',
      });
    }

    const info =
      clubBilling(club);

    const invoices =
      await prisma.clubInvoice.findMany({
        where: {
          clubId:
            req.auth!.clubId,
        },

        orderBy: {
          periodTo:
            'desc',
        },

        take: 24,

        select: {
          id: true,
          periodFrom: true,
          periodTo: true,
          amount: true,
          status: true,
          method: true,
          issuedAt: true,
          paidAt: true,
        },
      });

    res.json({
      state: info.state,
      online: info.online,
      paidUntil:
        info.paidUntil,
      daysLeft:
        info.daysLeft,
      graceLeft:
        info.graceLeft,
      graceDays:
        GRACE_DAYS,
      period:
        club.billingPeriod,
      prices:
        PERIOD_PRICE,
      since:
        club.createdAt,
      invoices,
    });
  },
);

/* -------------------------------------------------------------------------- */
/* BLOCKS                                                                     */
/* -------------------------------------------------------------------------- */

adminRouter.get(
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

adminRouter.post(
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

adminRouter.delete(
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

/* -------------------------------------------------------------------------- */
/* CUSTOMERS                                                                  */
/* -------------------------------------------------------------------------- */

adminRouter.get(
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

adminRouter.post(
  '/customers/:id/passes',
  requireAuth,
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

adminRouter.post(
  '/bookings/:id/use-pass',
  requireAuth,
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

adminRouter.delete(
  '/bookings/:id/use-pass',
  requireAuth,
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

/* -------------------------------------------------------------------------- */
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
adminRouter.post(
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

/* -------------------------------------------------------------------------- */
/* STAFF                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/admin/staff
 *
 * Список акаунтів клубу. Тільки OWNER/ADMIN — тренер не має бачити,
 * хто ще має доступ до кабінету.
 */
adminRouter.get(
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
adminRouter.post(
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

    const user = await prisma.user.create({
      data: {
        clubId: req.auth!.clubId,
        email: parsed.data.email,
        passwordHash,
        role: parsed.data.role,
        trainerId: parsed.data.trainerId ?? null,
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
adminRouter.delete(
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