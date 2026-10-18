import { withSendSummary } from './telegramSafety';
import { DateTime } from 'luxon';

import { prisma } from './db';
import { telegramAnalytics } from './plans';
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
/** Вікно «одного тіку» для стелі: довше за інтервал черги ІІ (10 хв), щоб два проходи поспіль не давали 50 */
export const TICK_WINDOW_MS = 10 * 60_000;

/**
 * Скільки листів повернення клуб надіслав відтоді (шаблонних і ІІ разом).
 * Стелі «за тік» і «за добу» рахуємо з бази, а не з памʼяті виклику: їх ділять
 * шаблонний тік, кілька затверджених кампаній і кілька інстансів.
 */
export async function lettersSentSince(clubId: string, since: Date): Promise<number> {
  return prisma.customer.count({ where: { clubId, winbackLastAt: { gte: since } } });
}

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
 * Останній візит і наявність майбутнього запису для набору людей: чотири запити
 * на всіх разом. Спільне для шаблонного повернення й листів ІІ — «давно не
 * грав» і «має запис» рахуються в обох випадках однаково.
 */
export async function loadVisitFacts(clubId: string, ids: string[], now: Date): Promise<{ lastVisit: Map<string, Date>; upcoming: Set<string> }> {
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

  return { lastVisit, upcoming };
}

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

  const { lastVisit, upcoming } = await loadVisitFacts(clubId, people.map((p) => p.id), now);

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

export type Judged = {
  id: string;
  name: string;
  chatId: string | null;
  storedCount: number;
  storedLastAt: Date | null;
  createdAt: Date;
  lastVisit: Date | null;
  verdict: Eligibility;
};

/**
 * Те саме правило winbackEligibility, але для конкретних людей і з причиною
 * відмови — для листів ІІ: і при пропозиції, і в момент відправки. Клієнт з
 * іншого клубу (чи неіснуючий id) просто не знайдеться — запит завжди в межах
 * clubId, тому «чужого» в мапі нема.
 *
 * Згоду, чат і блокування читаємо з картки як є (на відміну від eligiblePool,
 * який відсікає їх у where): ІІ має сказати власнику, ЧОМУ людині не написали.
 */
export async function judgeCustomers(
  clubId: string,
  ids: string[],
  settings: Pick<WinbackSettings, 'afterDays' | 'everyDays' | 'maxMessages'>,
  now: Date,
): Promise<Map<string, Judged>> {
  const out = new Map<string, Judged>();
  if (ids.length === 0) return out;

  const people = await prisma.customer.findMany({
    where: { clubId, id: { in: ids } },
    select: { id: true, name: true, createdAt: true, telegramChatId: true, tgMarketingAt: true, isBlocked: true, winbackCount: true, winbackLastAt: true },
  });
  const { lastVisit, upcoming } = await loadVisitFacts(clubId, people.map((p) => p.id), now);

  for (const p of people) {
    const last = lastVisit.get(p.id) ?? null;
    out.set(p.id, {
      id: p.id,
      name: p.name,
      chatId: p.telegramChatId,
      storedCount: p.winbackCount,
      storedLastAt: p.winbackLastAt,
      createdAt: p.createdAt,
      lastVisit: last,
      verdict: winbackEligibility({
        now,
        hasChat: Boolean(p.telegramChatId),
        marketingOk: p.tgMarketingAt !== null,
        blocked: p.isBlocked,
        lastVisit: last,
        hasUpcoming: upcoming.has(p.id),
        winbackCount: p.winbackCount,
        winbackLastAt: p.winbackLastAt,
        settings,
      }),
    });
  }
  return out;
}

/** Людина, якій збираємось писати: усе, що потрібно, щоб зайняти слот лічильника й надіслати. */
export type Claimable = {
  id: string;
  chatId: string;
  /** Що лежало в Customer.winbackCount / winbackLastAt, коли ми вирішували */
  storedCount: number;
  storedLastAt: Date | null;
  /** Скільки листів «в історії» після скидання при новому візиті */
  count: number;
};

/**
 * Один лист повернення: зайняти слот лічильника → надіслати → при помилці
 * розібратись з міткою. ЄДИНЕ місце, де росте winbackCount, і для шаблонного
 * тіку, і для листів ІІ: тому клієнт не отримає двох листів поспіль, а ліміти
 * (інтервал, «N листів») діють на обидва канали як на один.
 *
 *   sent      — доставлено, лічильник виріс;
 *   raced     — слот уже зайняв інший процес або людина зняла згоду між
 *               перевіркою та відправкою: нічого не шлемо;
 *   permanent — бот заблоковано, згоду знято;
 *   retry     — тимчасова помилка, мітку повернуто.
 */
export async function sendClaimed(
  p: Claimable,
  now: Date,
  buildView: () => { text: string; keyboard: unknown },
): Promise<'sent' | 'raced' | 'permanent' | 'retry'> {
  /* Займаємо слот ДО відправки умовним оновленням: другий процес, що
     дійшов до тієї ж людини, бачить уже нову мітку й пропускає її.
     Дубль маркетингового листа гірший за один непотрапивший. */
  const claim = await prisma.customer.updateMany({
    where: { id: p.id, tgMarketingAt: { not: null }, winbackLastAt: p.storedLastAt, winbackCount: p.storedCount },
    data: { winbackCount: p.count + 1, winbackLastAt: now },
  });
  if (claim.count === 0) return 'raced';

  const view = buildView();
  const result = await sendReminderMessage(p.chatId, view.text, { inline_keyboard: view.keyboard });

  if (result === 'sent') return 'sent';
  if (result === 'permanent') {
    /* Бота заблоковано — надалі писати нікуди й нема сенсу. */
    await prisma.customer.update({ where: { id: p.id }, data: { tgMarketingAt: null } });
    return 'permanent';
  }
  /* Тимчасова помилка: повертаємо мітку, спробуємо наступного разу. */
  await prisma.customer.updateMany({
    where: { id: p.id, winbackLastAt: now },
    data: { winbackCount: p.storedCount, winbackLastAt: p.storedLastAt },
  });
  return 'retry';
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
    /* Повернення клієнтів — сегментна автоматизація, шар «Аналітики». */
    if (!telegramAnalytics(club.plan)) continue;
    const settings = normalizeBotSettings(club.botSettings);
    /* Шаблонне повернення керується ЛИШЕ winback.enabled — політика ІІ (messaging) його не вмикає й не вимикає.
       Листи ІІ, навпаки, не залежать від winback.enabled (див. ai/winbackCampaign.ts). */
    if (!settings.winback.enabled) continue;
    if (!inSendWindow(now, club.timezone)) continue;

    /* Стеля тіку — на клуб: листи ІІ, надіслані щойно, зменшують квоту шаблонного тіку. */
    const room = MAX_PER_TICK - await lettersSentSince(club.id, new Date(now.getTime() - TICK_WINDOW_MS));
    if (room <= 0) continue;
    const pool = await eligiblePool(club.id, settings.winback, now, room);
    if (pool.length === 0) continue;

    const promo = settings.winback.promoId
      ? await prisma.promo.findFirst({ where: { id: settings.winback.promoId, clubId: club.id, isActive: true } })
      : null;
    const promoView = promo ? { title: promo.title, summary: promoSummary(promo) } : null;

    for (const p of pool) {
      const result = await sendClaimed(p, now, () => renderWinback({
        club, settings, playerName: p.name, days: p.days, promo: promoView, customerId: p.id,
      }));
      if (result === 'sent') delivered += 1;
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
