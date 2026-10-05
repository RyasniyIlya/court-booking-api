import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createHmac } from 'node:crypto';

import { JWT_SECRET } from './authSecret';
import { prisma } from './db';

/**
 * Партнер (будівельник кортів) — окремий вхід зі своєю таблицею.
 * scope: 'partner' не дає клубному й платформенному requireAuth прийняти цей
 * токен, і навпаки: усі підписані одним JWT_SECRET.
 */
export type PartnerAuth = { scope: 'partner'; partnerId: string };

/** Зміна пароля міняє хеш, а отже гасить усі старі токени. */
export function partnerCredentialVersion(passwordHash: string): string {
  return createHmac('sha256', JWT_SECRET).update(JSON.stringify(['partner', passwordHash])).digest('hex');
}

export function signPartnerToken(partnerId: string, passwordHash: string, expiresIn: jwt.SignOptions['expiresIn'] = '12h') {
  return jwt.sign(
    { scope: 'partner', partnerId, credentialVersion: partnerCredentialVersion(passwordHash) },
    JWT_SECRET,
    { expiresIn },
  );
}

declare global {
  namespace Express {
    interface Request {
      partnerAuth?: PartnerAuth;
    }
  }
}

export async function requirePartnerAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] }) as {
      scope?: string; partnerId?: unknown; credentialVersion?: unknown;
    };
    if (payload.scope !== 'partner' || typeof payload.partnerId !== 'string' || typeof payload.credentialVersion !== 'string') {
      return res.status(401).json({ error: 'INVALID_TOKEN' });
    }
    const partner = await prisma.partner.findUnique({
      where: { id: payload.partnerId },
      select: { id: true, isActive: true, passwordHash: true },
    });
    if (!partner || !partner.isActive || payload.credentialVersion !== partnerCredentialVersion(partner.passwordHash)) {
      return res.status(401).json({ error: 'INVALID_TOKEN' });
    }
    req.partnerAuth = { scope: 'partner', partnerId: partner.id };
    next();
  } catch {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
}
