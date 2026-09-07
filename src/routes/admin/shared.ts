import {
  type Request,
  type Response,
  type NextFunction,
} from 'express';

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '../../lib/authSecret';
import { prisma } from '../../lib/db';
import { planFeatures, type PlanFeatures } from '../../lib/plans';

/* -------------------------------------------------------------------------- */
/* AUTH                                                                       */
/* -------------------------------------------------------------------------- */
//
// Спільне для всіх /api/admin роутів: перевірка JWT, рівня доступу (1–3)
// і step-up PIN. Розрізане з колишнього монолітного admin.ts (3500+ рядків
// на все підряд) на файли по доменах — цей лишається єдиним, бо кожен домен
// (bookings, courts, trainers, ...) потребує requireAuth/requireLevel.

export type AccessLevel = 1 | 2 | 3;

export type Auth = {
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

export function param(req: Request, name: string): string {
  const value = (
    req.params as Record<string, string | string[] | undefined>
  )[name];

  return Array.isArray(value)
    ? (value[0] ?? '')
    : (value ?? '');
}

export function signToken(auth: Auth, expiresIn: string) {
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

export function requireLevel(level: AccessLevel) {
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
export async function verifyStepUpPin(
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

/**
 * Персонал клубу: OWNER або ADMIN. Тренера відсікає незалежно від рівня.
 *
 * Раніше цього не було потрібно: тренер фізично не міг взяти LEVEL 2, і
 * requireLevel(2) сам по собі означав "не тренер". Тепер тренер має свій
 * PIN і піднімається до рівня 2 — щоб закрити власне заняття, а не щоб
 * правити корти, години й чужі броні. Рівень і роль перестали бути
 * взаємозамінними: рівень каже "щойно підтвердив, що це справді він",
 * роль — "що йому взагалі можна".
 */
export function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.auth) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
    });
  }

  if (req.auth.role === 'TRAINER') {
    return res.status(403).json({
      error: 'FORBIDDEN',
      requiredRole: ['OWNER', 'ADMIN'],
    });
  }

  next();
}

/**
 * Вартовий плану: чи відкрита клубу ця можливість.
 *
 * План читається з бази НА КОЖЕН запит, а не кладеться в токен. Токен живе
 * до семи днів, і якби права їхали в ньому, підвищення рівня доходило б до
 * клуба лише після повторного входу — оператор натиснув «Аналітика», клуб
 * дзвонить і каже, що нічого не змінилось. Один індексований запит по
 * clubId дешевший за цю розмову.
 *
 * Без призначеного плану платні можливості закриті.
 *
 * 402 PAYMENT_REQUIRED, а не 403: 403 означає «тобі не можна за роллю», і
 * кабінет уже показує на нього «недостатньо прав». Тут інша природа —
 * можна, але не оплачено, і повідомлення має бути іншим.
 */
export function requireFeature(feature: keyof PlanFeatures) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (!req.auth) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
      });
    }

    const club = await prisma.club.findUnique({
      where: {
        id: req.auth.clubId,
      },
      select: {
        plan: {
          select: {
            featTrainers: true,
            featGroups: true,
            featAnalytics: true,
            tier: true,
          },
        },
      },
    });

    if (!planFeatures(club?.plan)[feature]) {
      return res.status(402).json({
        error: 'PLAN_REQUIRED',
        feature,
      });
    }

    next();
  };
}

/**
 * Те саме, що requireFeature, але для перевірки ВСЕРЕДИНІ обробника.
 *
 * Потрібне там, де можливість визначається не адресою роута, а тілом
 * запиту: групове заняття створюється тим самим POST /bookings, що й
 * звичайна бронь, і відрізняється лише наявністю capacity. Повісити
 * middleware на весь роут означало б закрити всі броні разом із групами.
 */
export async function hasFeature(
  clubId: string,
  feature: keyof PlanFeatures,
): Promise<boolean> {
  const club = await prisma.club.findUnique({
    where: {
      id: clubId,
    },
    select: {
      plan: {
        select: {
          featTrainers: true,
          featGroups: true,
          featAnalytics: true,
            tier: true,
        },
      },
    },
  });

  return planFeatures(club?.plan)[feature];
}
