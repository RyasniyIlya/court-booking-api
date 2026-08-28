import { Router } from 'express';

import { prisma } from '../../lib/db';
import { botReady } from '../../lib/telegram';
import { requireAuth } from './shared';

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
    s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
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
 * requireLevel тут навмисно НЕ стоїть. Прив'язка не дає нових прав: бот
 * віддає рівно те, що людина й так бачить у кабінеті своєю роллю. Вимагати
 * PIN означало б, що тренер, у якого його ще не задали, не підключиться
 * взагалі — а саме тренеру бот потрібен найбільше.
 */
telegramRouter.post('/telegram/link', requireAuth, async (req, res) => {
  if (!botReady()) {
    return res.status(503).json({ error: 'BOT_NOT_CONFIGURED' });
  }

  /* Колізія коду майже неможлива (31^6), але unique-індекс перетворив би її
     на 500. Кілька спроб дешевші за пояснення користувачу, що сталось. */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = makeCode();
    try {
      await prisma.user.update({
        where: { id: req.auth!.userId },
        data: {
          tgLinkCode: code,
          tgLinkUntil: new Date(Date.now() + CODE_MINUTES * 60_000),
        },
      });

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
telegramRouter.get('/telegram', requireAuth, async (req, res) => {
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
