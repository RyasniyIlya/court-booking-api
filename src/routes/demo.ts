import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db';
import { makeLimiter } from '../lib/rateLimits';
import { signFederationToken } from '../lib/federationAuth';
import {
  DEMO_CLUB_EMAIL, DEMO_CLUB_REDIRECT, DEMO_CLUB_SLUG, DEMO_FEDERATION_CODE, DEMO_FEDERATION_EMAIL,
  DEMO_FEDERATION_REDIRECT, DEMO_TTL, demoLoginEnabled,
} from '../lib/demo';
import { signToken } from './admin/shared';

/**
 * POST /api/demo/session  { kind: 'club' | 'federation' }
 *
 * Демо «в один клік» з лендингу: без пароля на сторінці. Токен отримують
 * лише фіксовані вигадані акаунти (owner@demo.test клубу demo-squash-kyiv,
 * federation@demo.test федерації squash-demo), живе 2 години і несе demo:true —
 * див. lib/demo.ts про те, що з таким токеном заборонено.
 *
 * Без DEMO_LOGIN=true маршрут вдає, що його немає (404): на проді вмикається
 * вручну в Render.
 */
export const demoRouter = Router();

// Багато людей можуть сидіти за одним NAT (захід, конференція): ліміт м'якший за вхід у кабінет.
const demoLimiter = makeLimiter({ windowMs: 10 * 60_000, limit: 30 });

demoRouter.post('/session', demoLimiter, async (req, res) => {
  if (!demoLoginEnabled()) return res.status(404).json({ error: 'NOT_FOUND' });

  const parsed = z.object({ kind: z.enum(['club', 'federation']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  try {
    if (parsed.data.kind === 'club') {
      const user = await prisma.user.findUnique({
        where: { email: DEMO_CLUB_EMAIL },
        select: { id: true, email: true, role: true, clubId: true, trainerId: true, passwordHash: true,
          club: { select: { slug: true } } },
      });
      // Подвійна перевірка: і пошта, і slug мають бути демо, і це власник.
      if (!user || !user.email.endsWith('@demo.test') || !user.club?.slug.startsWith('demo-')
          || user.club.slug !== DEMO_CLUB_SLUG || user.role !== 'OWNER') {
        return res.status(503).json({ error: 'DEMO_UNAVAILABLE' });
      }
      const token = signToken({ userId: user.id, clubId: user.clubId, role: user.role, trainerId: user.trainerId, demo: true },
        DEMO_TTL, user.passwordHash);
      return res.json({ token, scope: 'club', redirect: DEMO_CLUB_REDIRECT });
    }

    const account = await prisma.federationAccount.findUnique({
      where: { email: DEMO_FEDERATION_EMAIL },
      select: { id: true, federationId: true, email: true, passwordHash: true, active: true, federation: { select: { code: true } } },
    });
    if (!account || !account.active || !account.email.endsWith('@demo.test')
        || account.federation.code !== DEMO_FEDERATION_CODE) {
      return res.status(503).json({ error: 'DEMO_UNAVAILABLE' });
    }
    const token = signFederationToken(account, { demo: true, expiresIn: DEMO_TTL });
    return res.json({ token, scope: 'federation', redirect: DEMO_FEDERATION_REDIRECT });
  } catch (error) {
    // База недоступна/спить — для відвідувача це те саме «демо зараз недоступне».
    console.error('[demo] session failed', error instanceof Error ? error.message : 'unknown');
    return res.status(503).json({ error: 'DEMO_UNAVAILABLE' });
  }
});
