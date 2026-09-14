import { DateTime } from 'luxon';

import { prisma } from './db';
import { planFeatures } from './plans';
import { sendMessage } from './telegram';
import { bookingDayUrl, dayLabel, html, timeRange } from './playerBot';

/**
 * Черга на зайнятий слот корту.
 *
 * ── Як це працює ────────────────────────────────────────────────────────
 *
 * Гравець бачить зайняту годину і тисне «Повідомити, якщо звільниться».
 * Раз на хвилину тік дивиться на всі активні черги: якщо корт у цей час
 * звільнився, першому в черзі пишемо в Telegram. Наступні 15 хвилин про
 * цей час більше нікому не пишемо — це його фора. Не забронював — фора
 * згорає, пишемо наступному.
 *
 * ── Чому опитування, а не гачок на скасування ───────────────────────────
 *
 * Час звільняється з пʼяти різних місць: гравець у віджеті, кнопка в
 * Telegram, адміністратор у кабінеті, протухла оплата, скасування серії, а
 * ще перенесення броні на інший корт. Гачок у кожному з них — пʼять місць,
 * де його колись забудуть. Тік дивиться на результат, а не на шлях до
 * нього, і пропустити звільнення не може.
 *
 * ── Чесно про фору ──────────────────────────────────────────────────────
 *
 * Слот на ці 15 хвилин НЕ блокується: віджет показує його вільним усім.
 * Тримати його за гравцем означало б окремий «резерв» у логіці створення
 * броні з цінами, передоплатою й акціями. Фора — це пріоритет сповіщення:
 * першому ми пишемо раніше за всіх, а не забираємо час в інших.
 */

export const OFFER_MINUTES = 15;
/** Скільки черг одночасно може тримати один гравець */
export const MAX_ACTIVE_PER_CUSTOMER = 5;

const ACTIVE = ['WAITING', 'OFFERED'] as const;
const BUSY = ['PENDING', 'CONFIRMED'] as const;

export type JoinError =
  | 'COURT_NOT_FOUND'
  | 'BAD_SLOT'
  | 'TOO_LATE'
  | 'SLOT_FREE'
  | 'ALREADY_MINE'
  | 'TELEGRAM_REQUIRED'
  | 'TELEGRAM_UNAVAILABLE'
  | 'TOO_MANY'
  | 'CUSTOMER_BLOCKED';

type Club = { id: string; slug: string; name: string; timezone: string; leadTimeMinutes: number };

/** Що займає корт у цей проміжок: броні (з власником) і блокування */
async function occupancy(clubId: string, courtId: string, start: Date, end: Date) {
  const [bookings, blocks] = await Promise.all([
    prisma.booking.findMany({
      where: {
        courtId,
        status: { in: [...BUSY] },
        startTime: { lt: end },
        endTime: { gt: start },
      },
      select: { customerId: true },
    }),
    prisma.block.findMany({
      where: {
        clubId,
        OR: [{ courtId: null }, { courtId }],
        startTime: { lt: end },
        endTime: { gt: start },
      },
      select: { id: true },
    }),
  ]);
  return { bookings, blocked: blocks.length > 0 };
}

export async function joinWaitlist(input: {
  club: Club & { plan: Parameters<typeof planFeatures>[0] };
  customerId: string;
  courtId: string;
  start: Date;
  end: Date;
  now?: Date;
}): Promise<{ ok: true; id: string } | { ok: false; code: JoinError }> {
  const { club, customerId, courtId, start, end, now = new Date() } = input;

  if (!planFeatures(club.plan).telegram) return { ok: false, code: 'TELEGRAM_UNAVAILABLE' };

  const minutes = (end.getTime() - start.getTime()) / 60_000;
  if (!(minutes >= 15 && minutes <= 240)) return { ok: false, code: 'BAD_SLOT' };
  if (start.getTime() < now.getTime() + club.leadTimeMinutes * 60_000) return { ok: false, code: 'TOO_LATE' };

  const court = await prisma.court.findFirst({
    where: { id: courtId, clubId: club.id, isActive: true },
    select: { id: true, name: true },
  });
  if (!court) return { ok: false, code: 'COURT_NOT_FOUND' };

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { telegramChatId: true, isBlocked: true },
  });
  /* Чорний список клубу: забронювати онлайн він однаково не зможе, і
     повідомлення «час звільнився» було б обіцянкою, яку віджет не виконає. */
  if (customer?.isBlocked) return { ok: false, code: 'CUSTOMER_BLOCKED' };
  /* Без Telegram черга мовчить: сповістити про звільнений час нікуди.
     Краще сказати про це зараз, ніж гравцю чекати листа, якого не буде. */
  if (!customer?.telegramChatId) return { ok: false, code: 'TELEGRAM_REQUIRED' };

  const occ = await occupancy(club.id, courtId, start, end);
  if (occ.bookings.some((b) => b.customerId === customerId)) return { ok: false, code: 'ALREADY_MINE' };
  /* Чекати можна тільки на чужу бронь. Вільний час бронюють, а блокування
     клубу (турнір, ремонт) — не те, що «звільниться» від чиєїсь відмови. */
  if (occ.bookings.length === 0) return { ok: false, code: 'SLOT_FREE' };

  const existing = await prisma.waitlistEntry.findFirst({
    where: { customerId, courtId, startTime: start, endTime: end, status: { in: [...ACTIVE] } },
    select: { id: true },
  });
  if (existing) return { ok: true, id: existing.id };

  const active = await prisma.waitlistEntry.count({
    where: { customerId, status: { in: [...ACTIVE] }, startTime: { gt: now } },
  });
  if (active >= MAX_ACTIVE_PER_CUSTOMER) return { ok: false, code: 'TOO_MANY' };

  const entry = await prisma.waitlistEntry.create({
    data: { clubId: club.id, courtId, customerId, startTime: start, endTime: end },
    select: { id: true },
  });

  const ahead = await prisma.waitlistEntry.count({
    where: {
      courtId, startTime: start, endTime: end,
      status: { in: [...ACTIVE] },
      id: { not: entry.id },
    },
  });

  void sendMessage(
    customer.telegramChatId,
    [
      '📝 <b>Ви в черзі</b>',
      '',
      `<b>${dayLabel(start, club.timezone, now)}, ${timeRange(start, end, club.timezone)}</b>`,
      `${html(court.name)} · ${html(club.name)}`,
      '',
      ahead > 0 ? `Перед вами в черзі: ${ahead}.` : 'Ви перші в черзі.',
      'Напишу, щойно цей час звільниться.',
    ].join('\n'),
    { inline_keyboard: [[{ text: 'Вийти з черги', callback_data: `wl:leave:${entry.id}` }]] },
  ).catch((e) => console.error('[waitlist] підтвердження не надіслано', e));

  return { ok: true, id: entry.id };
}

/* ── Тік ────────────────────────────────────────────────────────────────── */

type Entry = {
  id: string;
  clubId: string;
  courtId: string;
  customerId: string;
  startTime: Date;
  endTime: Date;
  status: 'WAITING' | 'OFFERED' | 'DONE' | 'CANCELLED' | 'EXPIRED';
  offerUntil: Date | null;
  createdAt: Date;
  court: { name: string; isActive: boolean };
  customer: { telegramChatId: string | null; isBlocked: boolean };
  club: Club & { plan: Parameters<typeof planFeatures>[0] };
};

export async function runWaitlistTick(now: Date = new Date()): Promise<number> {
  /* Минуле більше нікому не потрібне. */
  await prisma.waitlistEntry.updateMany({
    where: { status: { in: [...ACTIVE] }, startTime: { lte: now } },
    data: { status: 'EXPIRED' },
  });

  const entries = await prisma.waitlistEntry.findMany({
    where: { status: { in: [...ACTIVE] } },
    select: {
      id: true, clubId: true, courtId: true, customerId: true,
      startTime: true, endTime: true, status: true, offerUntil: true, createdAt: true,
      court: { select: { name: true, isActive: true } },
      customer: { select: { telegramChatId: true, isBlocked: true } },
      club: { select: { id: true, slug: true, name: true, timezone: true, leadTimeMinutes: true, plan: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  }) as Entry[];

  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = `${e.courtId}|${e.startTime.getTime()}|${e.endTime.getTime()}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }

  let offered = 0;
  for (const list of groups.values()) {
    try {
      offered += await tickGroup(list, now);
    } catch (e) {
      /* Одна зламана черга не має зупиняти решту. */
      console.error('[waitlist] черга впала', list[0]?.id, e);
    }
  }
  return offered;
}

const setStatus = (ids: string[], data: Record<string, unknown>) =>
  ids.length ? prisma.waitlistEntry.updateMany({ where: { id: { in: ids } }, data }) : null;

async function tickGroup(list: Entry[], now: Date): Promise<number> {
  const { club, clubId, courtId, startTime, endTime } = list[0];

  /* Онлайн уже не забронювати — сповіщення було б дражнилкою. Так само з
     кортом, який клуб вимкнув: у віджеті його більше немає. */
  if (startTime.getTime() < now.getTime() + club.leadTimeMinutes * 60_000 || !list[0].court.isActive) {
    await setStatus(list.map((e) => e.id), { status: 'EXPIRED' });
    return 0;
  }

  const occ = await occupancy(clubId, courtId, startTime, endTime);

  /* Хто вже забронював цей час сам — у черзі йому робити нічого. */
  const owners = new Set(occ.bookings.map((b) => b.customerId).filter(Boolean));
  const done = list.filter((e) => owners.has(e.customerId));
  await setStatus(done.map((e) => e.id), { status: 'DONE' });
  let rest = list.filter((e) => !owners.has(e.customerId));

  const free = occ.bookings.length === 0 && !occ.blocked;

  if (!free) {
    /* Час знову зайняли (або не звільняли). Фора згоріла не з вини
       гравця — повертаємо його на його ж місце в черзі. */
    const back = rest.filter((e) => e.status === 'OFFERED');
    await setStatus(back.map((e) => e.id), { status: 'WAITING', offeredAt: null, offerUntil: null });
    return 0;
  }

  /* Вільно. Фора, що вже згоріла, — гравець не встиг або передумав. */
  const missed = rest.filter((e) => e.status === 'OFFERED' && (!e.offerUntil || e.offerUntil <= now));
  await setStatus(missed.map((e) => e.id), { status: 'EXPIRED' });
  rest = rest.filter((e) => !missed.includes(e));

  if (rest.some((e) => e.status === 'OFFERED')) return 0;
  if (!planFeatures(club.plan).telegram) return 0;

  for (const next of rest) {
    const chatId = next.customer.telegramChatId;
    /* Відвʼязав Telegram або потрапив у чорний список, поки чекав. */
    if (!chatId || next.customer.isBlocked) {
      await setStatus([next.id], { status: 'CANCELLED' });
      continue;
    }

    const offerUntil = new Date(now.getTime() + OFFER_MINUTES * 60_000);
    /* Умовний запис: паралельний тік, який дійшов сюди ж, отримає count 0
       і не напише другий раз. */
    const claim = await prisma.waitlistEntry.updateMany({
      where: { id: next.id, status: 'WAITING' },
      data: { status: 'OFFERED', offeredAt: now, offerUntil },
    });
    if (claim.count === 0) return 0;

    await sendMessage(chatId, offerText(next, now), offerKeyboard(next)).catch((e) => {
      console.error('[waitlist] пропозиція не надіслана', next.id, e);
    });
    return 1;
  }
  return 0;
}

export function offerText(e: Pick<Entry, 'startTime' | 'endTime' | 'court' | 'club'>, now: Date = new Date()) {
  const tz = e.club.timezone;
  return [
    '🔔 <b>Звільнився час, на який ви чекали!</b>',
    '',
    `<b>${dayLabel(e.startTime, tz, now)}, ${timeRange(e.startTime, e.endTime, tz)}</b>`,
    `${html(e.court.name)} · ${html(e.club.name)}`,
    '',
    `Ви перші в черзі: наступні ${OFFER_MINUTES} хвилин ми нікому більше про цей час не пишемо.`,
    '<i>Час не закріплений за вами — у розкладі його бачать усі, тож краще не зволікати.</i>',
  ].join('\n');
}

function offerKeyboard(e: Pick<Entry, 'id' | 'startTime' | 'club'>) {
  const date = DateTime.fromJSDate(e.startTime).setZone(e.club.timezone).toFormat('yyyy-MM-dd');
  const url = bookingDayUrl(e.club.slug, date);
  const rows: unknown[][] = [];
  if (url) {
    rows.push([url.startsWith('https://')
      ? { text: 'Забронювати', web_app: { url } }
      : { text: 'Забронювати', url }]);
  }
  rows.push([{ text: 'Вже не треба', callback_data: `wl:leave:${e.id}` }]);
  return { inline_keyboard: rows };
}
