import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createHmac } from 'node:crypto';
import { prisma } from './db';
import { JWT_SECRET } from './authSecret';

export type FederationAuth = { accountId: string; federationId: string; email: string };
declare global { namespace Express { interface Request { federationAuth?: FederationAuth } } }
const version = (hash: string) => createHmac('sha256', JWT_SECRET).update(hash).digest('hex');
export function signFederationToken(account: { id: string; federationId: string; email: string; passwordHash: string }) {
  return jwt.sign({ scope: 'federation', accountId: account.id, federationId: account.federationId,
    credentialVersion: version(account.passwordHash) }, JWT_SECRET, { expiresIn: '8h' });
}
export async function requireFederationAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'UNAUTHORIZED' });
  try {
    const p = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (p.scope !== 'federation' || typeof p.accountId !== 'string' || typeof p.federationId !== 'string') {
      return res.status(401).json({ error: 'INVALID_TOKEN' });
    }
    const a = await prisma.federationAccount.findUnique({ where: { id: p.accountId } });
    if (!a?.active || a.federationId !== p.federationId || version(a.passwordHash) !== p.credentialVersion) {
      return res.status(401).json({ error: 'SESSION_REVOKED' });
    }
    req.federationAuth = { accountId: a.id, federationId: a.federationId, email: a.email };
    next();
  } catch { return res.status(401).json({ error: 'UNAUTHORIZED' }); }
}
