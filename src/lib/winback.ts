import { withSendSummary } from './telegramSafety';
import { DateTime } from 'luxon';

import { prisma } from './db';
import { planFeatures } from './plans';
import { botReady, sendReminderMessage } from './telegram';
import { playerSchedulerEnabled } from './playerRemind';
import {
  normalizeBotSettings,
  promoSummary,
  renderWinback,
  type BotSettings,
  type WinbackSettings,
} from './clubBot';

/**
 * Повернення тих, хто давно не грав: один лист у Telegram від клубу.
 *
 * ── Межі, за які ми не виходимо ──────────────────────────────────────────
 *
 * Це маркетинг, а не нагадування про гру, тому кожна умова тут — на боці
 * гравця:
 *   • тільки за згодою (Customer.tgMarketingAt) — її дає кнопка в боті,
 *     знімає «Не надсилати таке» під листом або /stop;
 *   • тільки вдень — 11:00–19:59 за часом клубу, не о шостій ранку;
 *   • не частіше, ніж налаштував клуб, і не більше N листів поспіль;
 *   • лічильник скидається, коли людина повернулась: новий візит — нова
 *     «історія», і наступна пауза знову починається з першого листа;
 *   • хто ніколи не грав — не чіпаємо: «давно не бачили» тому, кого ми
 *     взагалі не бачили, — неправда.
 */

/** Денне вікно відправки, година за часом клубу: з 11:00 до 19:59 */
export const SEND_FROM_HOUR = 11;
export const SEND_TO_HOUR = 20;
/** Скільки листів на клуб за один тік — щоб налаштування «вмикаю» не стало розсилкою на тисячу людей за секунду */
export const MAX_PER_TICK = 25;

const DAY_MS = 86_400_000;

export function inSendWindow(now: Date, timezone: string): boolean {
  const hour = DateTime.fromJSDate(now).setZone(timezone).hour;
  return hour >= SEND_FROM_HOUR && hour < SEND_TO_HOUR;
}

export type EligibilityInput = {
  now: Date;
  hasChat: boolean;
  marketingOk: boolean;
  blocked: boolean;
  /** Кінець останнього відвіданого заняття; null — ніколи не грав */
  lastVisit: Date | null;
  /** Є майбутня бронь чи місце */
  hasUpcoming: boolean;
  winbackCount: number;
  winbackLastAt: Date | null;
  settings: Pick<WinbackSettings, 'afterDays' | 'everyDays' | 'maxMessages'>;
};

export type Eligibility =
  | { ok: true; count: number; days: number }
  | { ok: false; reason: 'no_chat' | 'no_consent' | 'blocked' | 'never_played' | 'upcoming' | 'recent' | 'too_soon' | 'max_reached' };

/**
 * Чи належить людині лист зараз. Чиста функція: усе, що вона вирішує, —
 * правила, і їх видно в тестах без бази.
 */
export function winbackEligibility(i: EligibilityInput): Eligibility {
  if (!i.hasChat) return { ok: false, reason: 'no_chat' };
  if (!i.marketingOk) return { ok: false, reason: 'no_consent' };
  if (i.blocked) return { ok: false, reason: 'blocked' };
  if (!i.lastVisit) return { ok: false, reason: 'never_played' };
  if (i.hasUpcoming) return { ok: false, reason: 'upcoming' };

  const days = Math.floor((i.now.getTime() - i.lastVisit.getTime()) / DAY_MS);
  if (days < i.settings.afterDays) return { ok: false, reason: 'recent' };

  /* Останній лист був ДО останнього візиту — людина поверталась, лічильник
     почався заново. */
  const count = i.winbackLastAt && i.winbackLastAt < i.lastVisit ? 0 : i.winbackCount;
  if (count >= i.settings.maxMessages) return { ok: false, reason: 'max_reached' };

  const lastSent = count === 0 ? null : i.winbackLastAt;
  if (lastSent && i.now.getTime() - lastSent.getTime() < i.settings.everyDays * DAY_MS) {
    return { ok: false, reason: 'too_soon' };
  }

  return { ok: true, count, days };
}

type Pool = {
  id: string;
  name: string;
  chatId: string;
  storedCount: number;
  storedLastAt: Date | null;
  count: number;
  days: number;
};

/**
 * Кому клуб може написати просто зараз (без урахування денного вікна).
 *
 * Спершу відсікаємо базою все, що відсікається без історії візитів —
 * згода, чат, блокування, — і лише для решти читаємо візити й майбутні
 * записи двома запитами на всіх разом, а не по одному на людину.
 */
async function eligiblePool(clubId: string, settings: WinbackSettings, now: Date, limit: number): Promise<Pool[]> {
  const people = await prisma.customer.findMany({
    where: {
      clubId,
      telegramChatId: { not: null },
      tgMarketingAt: { not: null },
      isBlocked: false,
    },
    select: { id: true, name: true, telegramChatId: true, winbackCount: true, winbackLastAt: true },
    take: 5000,
  });
  if (people.length === 0) return [];

  const ids = people.map((p) => p.id);
  const live = ['PENDING', 'CONFIRMED'] as const;

  const [bookingVisits, seatVisits, upBookings, upSeats] = await Promise.all([
    prisma.booking.groupBy({
      by: ['customerId'],
      where: { clubId, customerId: { in: ids }, status: 'CONFIRMED', endTime: { lt: now } },
      _max: { endTime: true },
    }),
    prisma.bookingSeat.findMany({
      where: {
        customerId: { in: ids },
        status: 'BOOKED',
        /* clubId саме тут, через контейнер: у місця свого немає. */
        booking: { clubId, status: 'CONFIRMED', endTime: { lt: now } },
      },
      select: { customerId: true, booking: { select: { endTime: true } } },
      orderBy: { booking: { endTime: 'desc' } },
      distinct: ['customerId'],
    }),
    prisma.booking.findMany({
      where: { clubId, customerId: { in: ids }, status: { in: [...live] }, startTime: { gt: now } },
      select: { customerId: true },
      distinct: ['customerId'],
    }),
    prisma.bookingSeat.findMany({
      where: {
        customerId: { in: ids },
        status: 'BOOKED',
        booking: { clubId, status: { in: [...live] }, startTime: { gt: now } },
      },
      select: { customerId: true },
      distinct: ['customerId'],
    }),
  ]);

  const lastVisit = new Map<string, Date>();
  const bump = (id: string | null, when: Date | null | undefined) => {
    if (!id || !when) return;
    const prev = lastVisit.get(id);
    if (!prev || when > prev) lastVisit.set(id, when);
  };
  for (const v of bookingVisits) bump(v.customerId, v._max.endTime);
  for (const v of seatVisits) bump(v.customerId, v.booking.endTime);

  const upcoming = new Set<string>();
  for (const u of [...upBookings, ...upSeats]) if (u.customerId) upcoming.add(u.customerId);

  const out: Pool[] = [];
  for (const p of people) {
    const verdict = winbackEligibility({
      now,
      hasChat: Boolean(p.telegramChatId),
      marketingOk: true,
      blocked: false,
      lastVisit: lastVisit.get(p.id) ?? null,
      hasUpcoming: upcoming.has(p.id),
      winbackCount: p.winbackCount,
      winbackLastAt: p.winbackLastAt,
      settings,
    });
    if (!verdict.ok) continue;
    out.push({
      id: p.id,
      name: p.name,
      chatId: p.telegramChatId!,
      storedCount: p.winbackCount,
      storedLastAt: p.winbackLastAt,
      count: verdict.count,
      days: verdict.days,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Скільки гравців клуб отримає в листі повернення — для екрана налаштувань */
export async function countWinbackEligible(clubId: string, now: Date = new Date()): Promise<number> {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { botSettings: true } });
  const settings: BotSettings = normalizeBotSettings(club?.botSettings);
  return (await eligiblePool(clubId, settings.winback, now, Number.MAX_SAFE_INTEGER)).length;
}

/**
 * Один прохід: по кожному клубу з увімкненим поверненням — не більше
 * MAX_PER_TICK листів. Повертає, скільки доставлено.
 */
export const runWinbackTick = (now?: Date) => withSendSummary('winback', () => runWinbackTickInner(now));
async function runWinbackTickInner(now: Date = new Date()): Promise<number> {
  const clubs = await prisma.club.findMany({
    where: { isActive: true, approvedAt: { not: null } },
    select: { id: true, name: true, slug: true, timezone: true, botSettings: true, plan: true },
  });

  let delivered = 0;

  for (const club of clubs) {
    if (!planFeatures(club.plan).telegram) continue;
    const settings = normalizeBotSettings(club.botSettings);
    if (!settings.winback.enabled) continue;
    if (!inSendWindow(now, club.timezone)) continue;

    const pool = await eligiblePool(club.id, settings.winback, now, MAX_PER_TICK);
    if (pool.length === 0) continue;

    const promo = settings.winback.promoId
      ? await prisma.promo.findFirst({ where: { id: settings.winback.promoId, clubId: club.id, isActive: true } })
      : null;
    const promoView = promo ? { title: promo.title, summary: promoSummary(promo) } : null;

    for (const p of pool) {
      /* Займаємо слот ДО відправки умовним оновленням: другий процес, що
         дійшов до тієї ж людини, бачить уже нову мітку й пропускає її.
         Дубль маркетингового листа гірший за один непотрапивший. */
      const claim = await prisma.customer.updateMany({
        where: { id: p.id, tgMarketingAt: { not: null }, winbackLastAt: p.storedLastAt, winbackCount: p.storedCount },
        data: { winbackCount: p.count + 1, winbackLastAt: now },
      });
      if (claim.count === 0) continue;

      const view = renderWinback({
        club, settings, playerName: p.name, days: p.days, promo: promoView, customerId: p.id,
      });
      const result = await sendReminderMessage(p.chatId, view.text, { inline_keyboard: view.keyboard });

      if (result === 'sent') {
        delivered += 1;
      } else if (result === 'permanent') {
        /* Бота заблоковано — надалі писати нікуди й нема сенсу. */
        await prisma.customer.update({ where: { id: p.id }, data: { tgMarketingAt: null } });
      } else {
        /* Тимчасова помилка: повертаємо мітку, спробуємо наступного тіку. */
        await prisma.customer.updateMany({
          where: { id: p.id, winbackLastAt: now },
          data: { winbackCount: p.storedCount, winbackLastAt: p.storedLastAt },
        });
      }
    }
  }

  return delivered;
}

/* ── Планувальник ──────────────────────────────────────────────────────── */

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Щогодини. Умови вмикання ті самі, що в нагадувань гравцям
 * (playerSchedulerEnabled): локальний API ходить у ту саму базу й з тим
 * самим токеном, і маркетинг із ноутбука розробника — найгірше, що можна
 * отримати від локального запуску.
 */
export function startWinbackScheduler() {
  if (timer) return;
  if (!playerSchedulerEnabled() || !botReady()) return;

  timer = setInterval(() => {
    if (running) return;
    running = true;
    void runWinbackTick()
      .catch(() => console.error('[winback] тік упав'))
      .finally(() => { running = false; });
  }, 60 * 60_000);
  timer.unref?.();

  console.log('[winback] повернення тих, хто давно не грав, увімкнене (щогодини, 11:00–20:00 за часом клубу)');
}
