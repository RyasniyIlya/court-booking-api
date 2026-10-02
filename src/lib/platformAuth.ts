import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createHmac } from 'node:crypto';

import { JWT_SECRET } from './authSecret';

/**
 * Оператор платформи — не клуб. User завжди прив'язаний до clubId, тому
 * тут окремий, повністю відірваний від клубної моделі вхід: один акаунт
 * з .env, а не рядок у таблиці User.
 *
 * scope: 'platform' — явна мітка в токені, щоб клубний requireAuth (admin.ts)
 * і цей requirePlatformAuth не переплутали токени одне одного навіть
 * випадково: обидва підписані тим самим JWT_SECRET.
 */
export type PlatformAuth = { scope: 'platform'; email: string };

export function platformCredentialVersion(
  email = process.env.PLATFORM_ADMIN_EMAIL,
  hash = process.env.PLATFORM_ADMIN_PASSWORD_HASH,
): string | null {
  email = email?.trim().toLowerCase();
  if (!email || !hash) return null;
  return createHmac('sha256', JWT_SECRET).update(JSON.stringify([email, hash])).digest('hex');
}

declare global {
  namespace Express {
    interface Request {
      platformAuth?: PlatformAuth;
    }
  }
}

export function requirePlatformAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] }) as Partial<PlatformAuth> & { credentialVersion?: string };
    const currentVersion = platformCredentialVersion();
    if (payload.scope !== 'platform' || typeof payload.email !== 'string' || !currentVersion ||
        payload.credentialVersion !== currentVersion || payload.email !== process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase()) {
      return res.status(401).json({ error: 'INVALID_TOKEN' });
    }
    req.platformAuth = { scope: 'platform', email: payload.email };
    next();
  } catch {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
}
