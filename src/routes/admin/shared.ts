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
// Спільне для всіх /api/admin роутів: перевірка JWT і ролі акаунта.
// Розрізане з колишнього монолітного admin.ts (3500+ рядків
// на все підряд) на файли по доменах — цей лишається єдиним, бо кожен домен
// (bookings, courts, trainers, ...) потребує requireAuth/requireRole.

export type Auth = {
  userId: string;
  clubId: string;
  role: string;
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
      typeof payload.role !== 'string'
    ) {
      return res.status(401).json({
        error: 'INVALID_TOKEN',
      });
    }

    req.auth = {
      userId: payload.userId,
      clubId: payload.clubId,
      role: payload.role,
      trainerId: payload.trainerId ?? null,
    };

    next();
  } catch {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
    });
  }
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

const MAX_PASSWORD_FAILS = 5;
const PASSWORD_LOCK_MINUTES = 15;

/**
 * Перевіряє єдиний пароль акаунта з блокуванням після невдалих спроб.
 */
export async function verifyAccountPassword(
  userId: string,
  password: string,
): Promise<
  | { ok: true }
  | { ok: false; reason: 'LOCKED' | 'NOT_SET' | 'INVALID_PASSWORD' }
> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      passwordHash: true,
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

  const valid = await bcrypt.compare(password, user.passwordHash);

  if (!valid) {
    const fails = user.pinFails + 1;
    const locked = fails >= MAX_PASSWORD_FAILS;

    await prisma.user.update({
      where: { id: userId },
      data: {
        pinFails: fails,
        pinLockedUntil: locked
          ? new Date(Date.now() + PASSWORD_LOCK_MINUTES * 60000)
          : undefined,
      },
    });

    return { ok: false, reason: 'INVALID_PASSWORD' };
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
 * Персонал клубу: OWNER або ADMIN. Тренера відсікає роль акаунта.
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
