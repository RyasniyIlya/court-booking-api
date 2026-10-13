import {
  type Request,
  type Response,
  type NextFunction,
} from 'express';

import { createHmac } from 'node:crypto';
import { checkPassword } from '../../lib/passwordCheck';
import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '../../lib/authSecret';
import { prisma } from '../../lib/db';
import { planFeatures, type PlanFeatures } from '../../lib/plans';
import { demoGuard } from '../../lib/demo';

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
  /// true лише для токена з /api/demo/session: його можна обмежувати (lib/demo.ts).
  demo?: boolean;
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

const credentialVersion = (hash: string) => createHmac('sha256', SECRET).update(hash).digest('hex');

export function signToken(auth: Auth, expiresIn: string, passwordHash: string) {
  return jwt.sign({ ...auth, credentialVersion: credentialVersion(passwordHash) }, SECRET, {
    expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
  });
}

export async function requireAuth(
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
      { algorithms: ['HS256'] },
    ) as Partial<Auth> & { credentialVersion?: string };
    const isDemo = payload.demo === true;

    if (
      typeof payload.userId !== 'string' ||
      typeof payload.clubId !== 'string' ||
      typeof payload.role !== 'string'
    ) {
      return res.status(401).json({
        error: 'INVALID_TOKEN',
      });
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId },
      select: { id: true, clubId: true, role: true, trainerId: true, passwordHash: true, email: true } });
    if (!user || user.clubId !== payload.clubId || !payload.credentialVersion ||
        payload.credentialVersion !== credentialVersion(user.passwordHash)) {
      return res.status(401).json({ error: 'SESSION_REVOKED' });
    }
    /* demo:true у токені довіряємо лише для вигаданих акаунтів: навіть якщо
       такий токен якось видали б справжньому користувачу, він не пройде. */
    if (isDemo && !String(user.email ?? '').toLowerCase().endsWith('@demo.test')) {
      return res.status(401).json({ error: 'INVALID_TOKEN' });
    }
    req.auth = { userId: user.id, clubId: user.clubId, role: user.role, trainerId: user.trainerId, ...(isDemo ? { demo: true } : {}) };

    if (isDemo) return demoGuard(req, res, next);
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
  const result = await checkPassword('user', userId, password);
  return !result.ok && result.reason === 'INVALID' ? { ok: false, reason: 'INVALID_PASSWORD' } : result;
}

/**
 * Персонал клубу: OWNER або ADMIN. Тренера й бухгалтера відсікає роль
 * акаунта — обидва мають вужчий, окремо визначений доступ (свій розклад
 * і фінанси відповідно), а не «усе, крім явно забороненого».
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

  if (req.auth.role === 'TRAINER' || req.auth.role === 'ACCOUNTANT') {
    return res.status(403).json({
      error: 'FORBIDDEN',
      requiredRole: ['OWNER', 'ADMIN'],
    });
  }

  next();
}

/**
 * Бухгалтеру закрито все під /api/admin/*, крім фінансів
 * (окремий роутер, /api/admin/finance) і самообслуговування з authRouter
 * (/me, /password, /login, /register).
 *
 * Один вартовий на весь роутер, а не позначка на кожному ендпоінті:
 * половина роутів тут не проходить через requireStaff узагалі (вони
 * читають дані і при TRAINER, звужуючи вибірку по trainerId в коді
 * ендпоінта, а не вартовим) — і кожен такий роут довелось би окремо
 * навчати нової ролі. Один пропущений рядок серед десятків файлів — це
 * рівно та розмита логіка, від якої lib/access.js на фронтенді
 * застерігає у власному коментарі; тут те саме застереження, але для бека.
 */
export function blockAccountant(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (req.auth?.role === 'ACCOUNTANT') {
    return res.status(403).json({
      error: 'FORBIDDEN',
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
