import { DateTime } from 'luxon';

import { prisma } from './db';
import { planFeatures } from './plans';
import { answerCallback, editMessageText, sendMessage, type TgUpdate } from './telegram';
import {
  normalizeBotSettings,
  promoSummary,
  renderClubHome,
  trainersOnShift,
  type HomeView,
} from './clubBot';
import { handlePlayerCommand } from './playerBot';

/**
 * Головна клубу в боті для гравця: завантаження даних, надсилання й кнопки
 * головної та згоди на акції.
 *
 * Сам текст і кнопки малює lib/clubBot.ts (чисті функції, ті самі, що в
 * превʼю кабінету) — тут лише те, що ходить у базу й у Telegram.
 *
 * ── Свій клуб без списку клубів ──────────────────────────────────────────
 *
 * Гравець, який підключив Telegram у профілі клубу, натискає «Start» і має
 * одразу побачити ЦЕЙ клуб. Список усіх клубів платформи для такої людини —
 * не вибір, а чужа реклама й зайвий тап, тому chatClubs() бере тільки ті
 * клуби, де чат уже привʼязаний до картки.
 */

type Club = { id: string; slug: string; name: string };

export type ChatClub = {
  customerId: string;
  customerName: string;
  tgLastActiveAt: Date | null;
  createdAt: Date;
  club: Club;
};

/** Клуби, у яких цей чат привʼязаний до картки гравця й бот доступний за планом */
export async function chatClubs(chatId: string): Promise<ChatClub[]> {
  const cards = await prisma.customer.findMany({
    where: {
      telegramChatId: chatId,
      club: { isActive: true, approvedAt: { not: null } },
    },
    select: {
      id: true,
      name: true,
      tgLastActiveAt: true,
      createdAt: true,
      club: { select: { id: true, slug: true, name: true, plan: true } },
    },
  });

  return cards
    .filter((c) => planFeatures(c.club.plan).telegram)
    .map((c) => ({
      customerId: c.id,
      customerName: c.name,
      tgLastActiveAt: c.tgLastActiveAt,
      createdAt: c.createdAt,
      club: { id: c.club.id, slug: c.club.slug, name: c.club.name },
    }));
}

/**
 * Який клуб відкрити, коли карток кілька: той, де гравець був у боті
 * останнім; якщо ніде — найновіша картка.
 */
export function pickActiveClub(list: ChatClub[]): ChatClub | null {
  if (list.length === 0) return null;
  const at = (c: ChatClub) => c.tgLastActiveAt?.getTime() ?? -1;
  return [...list].sort((a, b) => at(b) - at(a) || b.createdAt.getTime() - a.createdAt.getTime())[0];
}

/** Календарна дата клубу як UTC-північ — так лежать колонки @db.Date */
const dateColumn = (local: DateTime) =>
  new Date(Date.UTC(local.year, local.month - 1, local.day));

/**
 * Усе, що потрібно головній клубу, крім налаштувань власника: контакти,
 * чинні акції й тренери на сьогодні. Спільне для бота і для превʼю в
 * кабінеті, щоб власник бачив рівно те, що побачить гравець.
 */
export async function loadClubContent(clubId: string, opts: { anyState?: boolean } = {}) {
  /* Бот бачить лише активні схвалені клуби. Кабінет — і клуб, що ще чекає
     схвалення: власник має налаштувати бота до запуску. */
  const club = await prisma.club.findFirst({
    where: { id: clubId, ...(opts.anyState ? {} : { isActive: true, approvedAt: { not: null } }) },
    select: {
      id: true, slug: true, name: true, address: true, phone: true, timezone: true, botSettings: true, plan: true,
    },
  });
  if (!club) return null;

  const today = DateTime.now().setZone(club.timezone);
  const day = dateColumn(today);

  const [promos, trainers] = await Promise.all([
    prisma.promo.findMany({
      where: {
        clubId,
        isActive: true,
        /* Акція на дати, що вже минула, — не акція. Тижневі й «до дня
           народження» не мають кінця. */
        OR: [{ kind: { in: ['WEEKLY', 'BIRTHDAY'] } }, { kind: 'DATES', dateTo: { gte: day } }],
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    }),
    prisma.trainer.findMany({
      where: { clubId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        hours: { select: { weekday: true, openMinute: true, closeMinute: true, isClosed: true } },
        exceptions: { where: { date: day }, select: { date: true, isClosed: true, kind: true, intervals: true } },
      },
    }),
  ]);

  return {
    club,
    promos: promos.map((p) => ({ id: p.id, title: p.title, summary: promoSummary(p) })),
    trainers: trainersOnShift(trainers, today),
  };
}

/**
 * Головна клубу для гравця (або гостя, коли customerId = null).
 *
 * Налаштування власника діють лише на тарифі з Telegram: після пониження
 * плану клуб не має «застрягти» з кастомним текстом, який уже не може
 * змінити, — показуємо типовий.
 */
export async function loadClubHome(clubId: string, customerId: string | null): Promise<(HomeView & { club: Club }) | null> {
  const content = await loadClubContent(clubId);
  if (!content) return null;
  const { club } = content;

  const settings = planFeatures(club.plan).telegram
    ? normalizeBotSettings(club.botSettings)
    : normalizeBotSettings({});

  let playerName: string | null = null;
  let otherClubs = 0;

  if (customerId) {
    const me = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { name: true, telegramChatId: true },
    });
    if (me) {
      playerName = me.name;
      if (me.telegramChatId) {
        otherClubs = (await chatClubs(me.telegramChatId)).filter((c) => c.club.id !== clubId).length;
      }
      /* Відкрив головну — це і є «був у боті»: за цією міткою /start
         вибирає клуб, коли карток кілька. */
      await prisma.customer.update({ where: { id: customerId }, data: { tgLastActiveAt: new Date() } });
    }
  }

  const view = renderClubHome({
    club,
    settings,
    playerName,
    promos: content.promos,
    trainers: content.trainers,
    otherClubs,
  });

  return { ...view, club: { id: club.id, slug: club.slug, name: club.name } };
}

/** Надіслати головну клубу. false — клуб недоступний, нічого не надіслано */
export async function sendClubHome(chatId: string, clubId: string, customerId: string | null): Promise<boolean> {
  const view = await loadClubHome(clubId, customerId);
  if (!view) {
    await sendMessage(chatId, 'Цей клуб зараз недоступний.');
    return false;
  }
  await sendMessage(chatId, view.text, view.keyboard.length ? { inline_keyboard: view.keyboard } : undefined);
  return true;
}

/** Відкрити головну «свого» клубу чату, якщо він є. false — чат ні до якої картки не привʼязаний */
export async function sendOwnClubHome(chatId: string): Promise<boolean> {
  const pick = pickActiveClub(await chatClubs(chatId));
  if (!pick) return false;
  return sendClubHome(chatId, pick.club.id, pick.customerId);
}

/* ── Згода на акції ────────────────────────────────────────────────────── */

export const consentKeyboard = (customerId: string) => ({
  inline_keyboard: [[
    { text: 'Так, надсилати', callback_data: `mk:yes:${customerId}` },
    { text: 'Ні, дякую', callback_data: `mk:no:${customerId}` },
  ]],
});

export const CONSENT_TEXT =
  'Надсилати вам акції клубу й нагадування, якщо ви давно не грали? Не частіше, ніж налаштував клуб; вимкнути — одним натисканням.';

/** Спитати про згоду один раз за картку */
export async function askMarketingConsent(chatId: string, customerId: string): Promise<void> {
  const card = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { tgMarketingAskedAt: true },
  });
  if (card?.tgMarketingAskedAt) return;

  await sendMessage(chatId, CONSENT_TEXT, consentKeyboard(customerId));
  await prisma.customer.update({ where: { id: customerId }, data: { tgMarketingAskedAt: new Date() } });
}

/* ── Кнопки головної ───────────────────────────────────────────────────── */

const UUID = '[0-9a-f-]{36}';

type Query = NonNullable<TgUpdate['callback_query']>;

/** Картка, що належить САМЕ цьому чату: інакше чужий id у кнопці змінив би чужу згоду */
async function ownCard(chatId: string, customerId: string) {
  const card = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, telegramChatId: true },
  });
  return card && card.telegramChatId === chatId ? card : null;
}

/**
 * home:my, home:clubs, homeclub:<slug>, mk:yes|no:<id>, wb:off:<id>.
 * false — кнопка не з цього екрана.
 */
export async function handleHomeCallback(q: Query): Promise<boolean> {
  const data = q.data ?? '';
  const chatId = String(q.message?.chat.id ?? q.from?.id ?? '');

  if (data === 'home:my') {
    await answerCallback(q.id);
    if (!chatId || !await handlePlayerCommand(chatId, '/my', [])) {
      await sendMessage(chatId, 'Спершу підключіть Telegram у профілі гравця.');
    }
    return true;
  }

  if (data === 'home:clubs') {
    const list = chatId ? await chatClubs(chatId) : [];
    if (list.length === 0) {
      await answerCallback(q.id, 'Клубів немає');
      return true;
    }
    await answerCallback(q.id);
    await sendMessage(chatId, 'Оберіть клуб:', {
      inline_keyboard: list.map((c) => [{ text: `🎾 ${c.club.name}`, callback_data: `homeclub:${c.club.slug}` }]),
    });
    return true;
  }

  if (data.startsWith('homeclub:')) {
    const slug = data.slice('homeclub:'.length);
    const mine = chatId ? (await chatClubs(chatId)).find((c) => c.club.slug === slug) : null;
    if (!mine) {
      await answerCallback(q.id, 'Цей клуб вам недоступний');
      return true;
    }
    await answerCallback(q.id);
    await sendClubHome(chatId, mine.club.id, mine.customerId);
    return true;
  }

  const consent = new RegExp(`^mk:(yes|no):(${UUID})$`).exec(data);
  const off = new RegExp(`^wb:off:(${UUID})$`).exec(data);
  if (!consent && !off) return false;

  const customerId = (consent ?? off)![consent ? 2 : 1];
  if (!chatId || !await ownCard(chatId, customerId)) {
    /* Однакова відповідь для чужого й неіснуючого id: не підказуємо, що
       така картка є. */
    await answerCallback(q.id, 'Цей запис вам недоступний');
    return true;
  }

  const edit = async (text: string) => {
    if (q.message) await editMessageText(chatId, q.message.message_id, text);
  };

  if (off) {
    await prisma.customer.update({ where: { id: customerId }, data: { tgMarketingAt: null } });
    await edit('🔕 Готово — таких повідомлень більше не буде. Нагадування про ваші ігри приходитимуть як раніше.');
    await answerCallback(q.id, 'Вимкнено');
    return true;
  }

  if (consent![1] === 'yes') {
    await prisma.customer.update({
      where: { id: customerId },
      data: { tgMarketingAt: new Date(), tgMarketingAskedAt: new Date() },
    });
    await edit('✅ Дякуємо! Надсилатимемо акції клубу й нагадування. Вимкнути можна під будь-яким таким повідомленням — кнопка «Не надсилати таке».');
    await answerCallback(q.id, 'Готово');
  } else {
    await prisma.customer.update({
      where: { id: customerId },
      data: { tgMarketingAt: null, tgMarketingAskedAt: new Date() },
    });
    await edit('Добре, акцій не буде. Нагадування про ваші ігри приходитимуть як і раніше.');
    await answerCallback(q.id, 'Готово');
  }
  return true;
}
