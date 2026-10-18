import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { planFeatures, telegramAnalytics } from '../../lib/plans';
import { botReady } from '../../lib/telegram';
import { clubStartPayload } from '../../lib/botBooking';
import {
  botSettingsSchema,
  describeKeyboard,
  normalizeBotSettings,
  promoSummary,
  renderClubHome,
  renderWinback,
  trainersOnShift,
} from '../../lib/clubBot';
import { loadClubContent } from '../../lib/playerHome';
import { countWinbackEligible } from '../../lib/winback';
import { requireAuth, requireRole } from './shared';

/**
 * /api/admin/bot-settings — що гравець бачить у боті клубу й як часто бот
 * нагадує тим, хто давно не грав.
 *
 * Тільки власник: тексти, які бот надсилає клієнтам від імені клубу, і
 * рішення «писати тим, хто пропав» — не справа модератора, так само як
 * платіжні налаштування.
 *
 * Перегляд відкритий на будь-якому тарифі (кабінет показує замок і
 * пояснення), а зберегти можна лише там, де бот є в тарифі. Бот є на кожному
 * призначеному тарифі; аналітичні розсилки (повернення клієнтів, зведення)
 * — лише на «Аналітика», їх вмикання закрите окремо (`analyticsAllowed`).
 */
export const botSettingsRouter = Router();

botSettingsRouter.use('/bot-settings', requireAuth, requireRole('OWNER'));

const botUsername = () => process.env.TELEGRAM_BOT_USERNAME || null;

/** Акція в кабінеті: те саме правило, що й у боті, щоб підпис збігався */
const promoRow = (p: Parameters<typeof promoSummary>[0] & { id: string; title: string; isActive: boolean }) => ({
  id: p.id, title: p.title, summary: promoSummary(p), isActive: p.isActive,
});

botSettingsRouter.get('/bot-settings', async (req, res) => {
  const clubId = req.auth!.clubId;

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { name: true, slug: true, address: true, phone: true, timezone: true, botSettings: true, plan: true },
  });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

  const today = DateTime.now().setZone(club.timezone);
  const day = new Date(Date.UTC(today.year, today.month - 1, today.day));

  const [promos, trainers, linkedPlayers, marketingOk, winbackEligible] = await Promise.all([
    prisma.promo.findMany({
      where: { clubId },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    }),
    prisma.trainer.findMany({
      where: { clubId },
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        isActive: true,
        hours: { select: { weekday: true, openMinute: true, closeMinute: true, isClosed: true } },
        exceptions: { where: { date: day }, select: { date: true, isClosed: true, kind: true, intervals: true } },
      },
    }),
    prisma.customer.count({ where: { clubId, telegramChatId: { not: null } } }),
    prisma.customer.count({ where: { clubId, telegramChatId: { not: null }, tgMarketingAt: { not: null } } }),
    countWinbackEligible(clubId),
  ]);

  const username = botUsername();

  res.json({
    settings: normalizeBotSettings(club.botSettings),
    planAllows: planFeatures(club.plan).telegram,
    analyticsAllowed: telegramAnalytics(club.plan),
    aiAllowed: planFeatures(club.plan).ai,
    botReady: botReady() && Boolean(username),
    botUsername: username,
    clubLink: username ? `https://t.me/${username}?start=${clubStartPayload(club.slug)}` : null,
    club: { name: club.name, slug: club.slug, address: club.address, phone: club.phone },
    promos: promos.map(promoRow),
    trainers: trainers.map((t) => {
      const shift = t.isActive ? trainersOnShift([t], today)[0] : undefined;
      return { id: t.id, name: t.name, isActive: t.isActive, today: shift ? `${shift.from}–${shift.to}` : null };
    }),
    stats: { linkedPlayers, marketingOk, winbackEligible },
  });
});

botSettingsRouter.put('/bot-settings', async (req, res) => {
  const clubId = req.auth!.clubId;

  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { plan: true, botSettings: true } });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

  if (!planFeatures(club.plan).telegram) {
    return res.status(403).json({ error: 'PLAN_REQUIRED', feature: 'telegram' });
  }

  const parsed = botSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const input = parsed.data;

  /* Повернення клієнтів — аналітичний шар. Заборонено саме ВМИКАТИ (було
     вимкнено, стало ввімкнено): клуб, що зійшов з «Аналітики» з уже
     ввімкненим поверненням, усе одно зможе зберегти решту налаштувань. */
  if (
    input.winback.enabled
    && !normalizeBotSettings(club.botSettings).winback.enabled
    && !telegramAnalytics(club.plan)
  ) {
    return res.status(403).json({ error: 'PLAN_REQUIRED', feature: 'analytics' });
  }

  /* Сводка ІІ — лише там, де ІІ є в тарифі. Забороняємо саме ВМИКАТИ, як і
     повернення клієнтів вище: клуб, що зійшов з тарифу, зберігає решту. */
  const stored = normalizeBotSettings(club.botSettings);
  if (input.morningBrief?.enabled && !stored.morningBrief.enabled && !planFeatures(club.plan).ai) {
    return res.status(403).json({ error: 'PLAN_REQUIRED', feature: 'ai' });
  }

  /* Ідентифікатори приходять від клієнта. Акція чи тренер чужого клубу
     в списку «показувати» не повинні ні зберегтись, ні вплинути на те, що
     бачать гравці, — тому лишаємо тільки ті, що справді належать цьому
     клубу, зберігши порядок, у якому їх вибрав власник. */
  const [ownPromos, ownTrainers] = await Promise.all([
    input.promoIds?.length || input.winback.promoId
      ? prisma.promo.findMany({
        where: { clubId, id: { in: [...(input.promoIds ?? []), ...(input.winback.promoId ? [input.winback.promoId] : [])] } },
        select: { id: true },
      })
      : [],
    input.trainerIds?.length
      ? prisma.trainer.findMany({ where: { clubId, id: { in: input.trainerIds } }, select: { id: true } })
      : [],
  ]);
  const promoOk = new Set(ownPromos.map((p) => p.id));
  const trainerOk = new Set(ownTrainers.map((t) => t.id));

  const settings = normalizeBotSettings({
    ...input,
    promoIds: input.promoIds && input.promoIds.filter((id) => promoOk.has(id)),
    trainerIds: input.trainerIds && input.trainerIds.filter((id) => trainerOk.has(id)),
    winback: {
      ...input.winback,
      promoId: input.winback.promoId && promoOk.has(input.winback.promoId) ? input.winback.promoId : null,
    },
    /* Старий кабінет цих полів не шле — лишаємо збережене, а не скидаємо у типове. */
    morningBrief: input.morningBrief ?? stored.morningBrief,
    actionAlerts: input.actionAlerts ?? stored.actionAlerts,
  });

  /* briefSentOn — службова позначка «сводку за цей день уже надіслано» (див.
     lib/morningBrief.ts). Нормалізація її відкидає, тож без перенесення кожне
     збереження форми стирало б її й давало друге повідомлення того ж ранку. */
  const sentOn = (club.botSettings as { briefSentOn?: unknown } | null)?.briefSentOn;
  await prisma.club.update({
    where: { id: clubId },
    data: { botSettings: typeof sentOn === 'string' ? { ...settings, briefSentOn: sentOn } : settings },
  });

  res.json({ settings });
});

const previewSchema = z.object({
  settings: botSettingsSchema,
  kind: z.enum(['home', 'winback']),
});

/** Ім'я й лист повернення в превʼю — умовні: справжнього гравця тут нема */
const PREVIEW_PLAYER = 'Олена';
const PREVIEW_CUSTOMER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * POST /api/admin/bot-settings/preview
 *
 * Малює повідомлення тими самими функціями, що й бот, з ще не збереженими
 * налаштуваннями з форми, але зі справжніми акціями й тренерами клубу.
 * Кнопки віддаємо без посилань — кабінету потрібен лише підпис і тип.
 */
botSettingsRouter.post('/bot-settings/preview', async (req, res) => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const { settings: input, kind } = parsed.data;
  const settings = normalizeBotSettings(input);

  const content = await loadClubContent(req.auth!.clubId, { anyState: true });
  if (!content) return res.status(404).json({ error: 'NOT_FOUND' });

  const view = kind === 'home'
    ? renderClubHome({
      club: content.club,
      settings,
      playerName: PREVIEW_PLAYER,
      promos: content.promos,
      trainers: content.trainers,
      otherClubs: 0,
    })
    : renderWinback({
      club: content.club,
      settings,
      playerName: PREVIEW_PLAYER,
      days: settings.winback.afterDays,
      promo: content.promos.find((p) => p.id === settings.winback.promoId) ?? null,
      customerId: PREVIEW_CUSTOMER_ID,
    });

  res.json({ text: view.text, keyboard: describeKeyboard(view.keyboard) });
});
