import { Router } from 'express';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';

import { prisma } from '../../lib/db';
import { botReady } from '../../lib/telegram';
import { requireFeature, requireAuth, verifyAccountPassword } from './shared';

export const telegramRouter = Router();

/** Скільки живе код прив'язки */
const CODE_MINUTES = 15;

/**
 * Алфавіт без 0/O та 1/I/L: код диктують уголос і набирають з екрана на
 * телефоні, і саме ці пари плутають найчастіше.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode() {
  let s = '';
  for (let i = 0; i < 6; i += 1) {
    s += ALPHABET[randomInt(ALPHABET.length)];
  }
  return s;
}

/**
 * POST /api/admin/telegram/link
 *
 * Видає одноразовий код, який людина надсилає боту. Прив'язка йде до
 * КОНКРЕТНОГО акаунта, а не до клубу: власнику бот шле цифри дня, тренеру —
 * його заняття, і плутати ці два чати не можна.
 *
 * Прив'язка не дає нових прав: бот віддає рівно те, що людина й так
 * бачить у кабінеті своєю роллю.
 */
const linkLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true,
  legacyHeaders: false, message: { error: 'TOO_MANY_ATTEMPTS' } });

telegramRouter.post('/telegram/link', requireAuth, requireFeature('telegram'), linkLimiter, async (req, res) => {
  const parsed = z.object({ currentPassword: z.string().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'CURRENT_PASSWORD_REQUIRED' });
  if (!botReady()) {
    return res.status(503).json({ error: 'BOT_NOT_CONFIGURED' });
  }

  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { passwordHash: true } });
  const check = await verifyAccountPassword(req.auth!.userId, parsed.data.currentPassword);
  if (!check.ok) return res.status(check.reason === 'LOCKED' ? 429 : 403).json({
    error: check.reason === 'LOCKED' ? 'ACCOUNT_LOCKED' : 'INVALID_PASSWORD',
  });
  if (!user) return res.status(401).json({ error: 'UNAUTHORIZED' });

  /* Колізія коду майже неможлива (31^6), але unique-індекс перетворив би її
     на 500. Кілька спроб дешевші за пояснення користувачу, що сталось. */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = makeCode();
    try {
      const issued = await prisma.user.updateMany({
        where: { id: req.auth!.userId, passwordHash: user.passwordHash },
        data: {
          tgLinkCode: code,
          tgLinkUntil: new Date(Date.now() + CODE_MINUTES * 60_000),
        },
      });
      if (issued.count !== 1) return res.status(409).json({ error: 'CREDENTIALS_CHANGED' });

      return res.json({
        code,
        minutes: CODE_MINUTES,
        botUsername: process.env.TELEGRAM_BOT_USERNAME ?? null,
      });
    } catch {
      // код зайнятий — пробуємо інший
    }
  }

  res.status(500).json({ error: 'INTERNAL' });
});

/**
 * GET /api/admin/telegram — чи підключений цей акаунт.
 *
 * Сам chatId назовні не віддаємо: кабінету достатньо факту, а числовий
 * ідентифікатор чужого чату — зайва річ у відповіді API.
 */
telegramRouter.get('/telegram', requireAuth, requireFeature('telegram'), async (req, res) => {
  const me = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: { tgChatId: true },
  });

  res.json({
    connected: Boolean(me?.tgChatId),
    botReady: botReady(),
    botUsername: process.env.TELEGRAM_BOT_USERNAME ?? null,
  });
});

/** DELETE /api/admin/telegram — відв'язати свій чат */
telegramRouter.delete('/telegram', requireAuth, async (req, res) => {
  await prisma.user.update({
    where: { id: req.auth!.userId },
    data: { tgChatId: null, tgLinkCode: null, tgLinkUntil: null },
  });

  res.status(204).end();
});
