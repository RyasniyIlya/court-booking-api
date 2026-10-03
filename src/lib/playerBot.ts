import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';

import { prisma } from './db';
import { planFeatures } from './plans';
import { answerCallback, editMessageText, sendMessage, type TgUpdate } from './telegram';
import { bookingUrl, publicWebBase } from './botBooking';
import { telegramHtml } from './telegramHtml';
import { canReschedule } from './reschedule';
import {
  canCancelNow,
  cancelBookingByCustomer,
  cancelSeatByCustomer,
} from './customerCancel';

/**
 * Бот для гравця: привʼязка чату з профілю у віджеті, картка майбутньої гри
 * з кнопками «Прийду / Скасувати», /my і /stop.
 *
 * ── Чому гравець живе окремо від персоналу ──────────────────────────────
 *
 * Персонал привʼязаний до User і бачить клуб. Гравець привʼязаний до
 * Customer і бачить тільки своє. Одна людина буває і тим, і тим (тренер,
 * який сам грає по неділях), тому розбір гравцевих кнопок і команд іде
 * ДО перевірки «чи це персонал» і нічого в ній не ламає.
 *
 * Один чат може належати кільком карткам: людина ходить у два клуби — це
 * дві картки Customer з одним telegramChatId. /my показує обидва клуби.
 */

/** Скільки живе код привʼязки — як і в персоналу */
export const PLAYER_LINK_MINUTES = 15;

/** Префікс start-параметра: t.me/<bot>?start=p_<код> */
const START_PREFIX = 'p_';

export const html = (value: string) => value
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/* ── Привʼязка ──────────────────────────────────────────────────────────── */

/**
 * Видати код привʼязки для профілю у віджеті.
 *
 * 16 символів base64url, а не шість літер, як у персоналу: той код людина
 * переписує руками, а цей їде всередині посилання, і довжина нікому не
 * заважає — зате перебрати його неможливо.
 */
export async function createPlayerLinkCode(customerId: string): Promise<string> {
  const code = randomBytes(12).toString('base64url');
  await prisma.customer.update({
    where: { id: customerId },
    data: {
      tgLinkCode: code,
      tgLinkUntil: new Date(Date.now() + PLAYER_LINK_MINUTES * 60_000),
    },
  });
  return code;
}

export const playerStartPayload = (code: string) => `${START_PREFIX}${code}`;

export function codeFromStartPayload(payload: string | undefined): string | null {
  if (!payload?.startsWith(START_PREFIX)) return null;
  const code = payload.slice(START_PREFIX.length);
  return /^[A-Za-z0-9_-]{16}$/.test(code) ? code : null;
}

/**
 * Привʼязати чат до картки гравця.
 *
 * Одна дорога для обох входів — посилання з профілю і /profile у боті.
 * Інші картки ЦЬОГО Ж клубу з тим самим чатом відвʼязуємо разом із їхніми
 * чергами: людина, яка перейшла на іншу картку (новий номер), інакше
 * отримувала б два однакові нагадування і стояла б у черзі двічі.
 * Картки інших клубів не чіпаємо — ходити у два клуби нормально.
 */
export async function linkChatToCustomer(chatId: string, clubId: string, customerId: string) {
  const others = await prisma.customer.findMany({
    where: { clubId, telegramChatId: chatId, id: { not: customerId } },
    select: { id: true },
  });
  const otherIds = others.map((c) => c.id);

  await prisma.$transaction([
    prisma.waitlistEntry.updateMany({
      where: { customerId: { in: otherIds }, status: { in: ['WAITING', 'OFFERED'] } },
      data: { status: 'CANCELLED' },
    }),
    prisma.customer.updateMany({
      where: { id: { in: otherIds } },
      data: { telegramChatId: null },
    }),
    prisma.customer.update({
      where: { id: customerId },
      data: { telegramChatId: chatId, tgLinkCode: null, tgLinkUntil: null },
    }),
  ]);
}

/**
 * Один рядок із посиланням на Політику конфіденційності — при першому
 * /start і першій привʼязці. Без кнопок і блокувань.
 *
 * «Вже показували» = у привʼязаної картки заповнено privacyNoticeAt: показ
 * повідомлення фіксуємо окремим полем (це НЕ згода: termsAcceptedAt не чіпаємо), тож повторний /start
 * нічого не дублює. Якщо адреси сайту нема в налаштуваннях — мовчимо:
 * повідомлення без посилання нічого не повідомляє.
 */
export async function sendPrivacyNoticeOnce(chatId: string): Promise<boolean> {
  const base = publicWebBase();
  if (!base) return false;
  const fresh = await prisma.customer.findMany({
    where: { telegramChatId: chatId, privacyNoticeAt: null },
    select: { id: true },
  });
  if (fresh.length === 0) return false;
  await prisma.customer.updateMany({
    where: { id: { in: fresh.map((c) => c.id) }, privacyNoticeAt: null },
    data: { privacyNoticeAt: new Date() },
  });
  const url = telegramHtml(`${base}/legal/privacy`);
  await sendMessage(
    chatId,
    `Продовжуючи, ви погоджуєтеся з <a href="${url}">Політикою конфіденційності</a> клубу.`,
  );
  return true;
}

/* Код із профілю привʼязує чат лише після підтвердження номера кнопкою
   Telegram — див. startLinkByCode у lib/playerLogin.ts. */

/* ── Картка гри ─────────────────────────────────────────────────────────── */

export type PlayerItemKind = 'b' | 's';

export type PlayerItem = {
  kind: PlayerItemKind;
  id: string;
  chatId: string | null;
  clubName: string;
  clubSlug?: string;
  clubPhone: string | null;
  timezone: string;
  start: Date;
  end: Date;
  courtName: string;
  title: string | null;
  trainerName: string | null;
  cutoffMinutes: number;
  /** Ще в силі: не скасоване, не протухле */
  active: boolean;
  confirmedAt: Date | null;
};

/**
 * Прочитати бронь або місце разом з усім, що треба картці.
 *
 * Бронь групи сюди не потрапляє: контейнер групового заняття нікому не
 * належить — гравець записаний у нього місцем.
 */
export async function loadPlayerItem(kind: PlayerItemKind, id: string): Promise<PlayerItem | null> {
  if (kind === 'b') {
    const b = await prisma.booking.findUnique({
      where: { id },
      select: {
        id: true, status: true, capacity: true, title: true, startTime: true, endTime: true,
        playerConfirmedAt: true,
        court: { select: { name: true } },
        trainer: { select: { name: true } },
        customer: { select: { telegramChatId: true } },
        club: { select: { slug: true, name: true, phone: true, timezone: true, cancelCutoffMinutes: true } },
      },
    });
    if (!b || b.capacity != null) return null;
    return {
      kind, id: b.id,
      chatId: b.customer?.telegramChatId ?? null,
      clubName: b.club.name, clubPhone: b.club.phone, timezone: b.club.timezone,
      clubSlug: b.club.slug,
      start: b.startTime, end: b.endTime,
      courtName: b.court.name, title: b.title, trainerName: b.trainer?.name ?? null,
      cutoffMinutes: b.club.cancelCutoffMinutes,
      active: b.status === 'CONFIRMED' || b.status === 'PENDING',
      confirmedAt: b.playerConfirmedAt,
    };
  }

  const s = await prisma.bookingSeat.findUnique({
    where: { id },
    select: {
      id: true, status: true, playerConfirmedAt: true,
      customer: { select: { telegramChatId: true } },
      booking: {
        select: {
          status: true, title: true, startTime: true, endTime: true,
          court: { select: { name: true } },
          trainer: { select: { name: true } },
          club: { select: { name: true, phone: true, timezone: true, cancelCutoffMinutes: true } },
        },
      },
    },
  });
  if (!s) return null;
  return {
    kind, id: s.id,
    chatId: s.customer?.telegramChatId ?? null,
    clubName: s.booking.club.name, clubPhone: s.booking.club.phone, timezone: s.booking.club.timezone,
    start: s.booking.startTime, end: s.booking.endTime,
    courtName: s.booking.court.name, title: s.booking.title, trainerName: s.booking.trainer?.name ?? null,
    cutoffMinutes: s.booking.club.cancelCutoffMinutes,
    active: s.status === 'BOOKED' && (s.booking.status === 'CONFIRMED' || s.booking.status === 'PENDING'),
    confirmedAt: s.playerConfirmedAt,
  };
}

/** «сьогодні», «завтра» або «пт, 18.09» — у таймзоні клубу */
export function dayLabel(d: Date, tz: string, now: Date = new Date()): string {
  const at = DateTime.fromJSDate(d).setZone(tz);
  const today = DateTime.fromJSDate(now).setZone(tz).startOf('day');
  const diff = Math.round(at.startOf('day').diff(today, 'days').days);
  if (diff === 0) return 'Сьогодні';
  if (diff === 1) return 'Завтра';
  return at.setLocale('uk').toFormat('ccc, dd.MM');
}

export const timeRange = (start: Date, end: Date, tz: string) =>
  `${DateTime.fromJSDate(start).setZone(tz).toFormat('HH:mm')}–${DateTime.fromJSDate(end).setZone(tz).toFormat('HH:mm')}`;

export type CardState = 'remind' | 'confirmed' | 'ask-cancel' | 'cancelled' | 'gone';

export function playerCardText(item: PlayerItem, state: CardState, now: Date = new Date()): string {
  const head: Record<CardState, string> = {
    remind: '⏰ <b>Нагадування про гру</b>',
    confirmed: '✅ <b>Чекаємо вас!</b>',
    'ask-cancel': '❓ <b>Точно скасувати?</b>',
    cancelled: '🗑 <b>Скасовано</b>',
    gone: 'ℹ️ <b>Цього запису вже немає</b>',
  };

  const what = item.kind === 's'
    ? (item.title ? html(item.title) : 'Групове заняття')
    : item.courtName;

  const lines = [
    head[state],
    '',
    `<b>${dayLabel(item.start, item.timezone, now)}, ${timeRange(item.start, item.end, item.timezone)}</b>`,
    `${html(what)}${item.kind === 's' ? ` · ${html(item.courtName)}` : ''}`,
    item.trainerName ? `Тренер: ${html(item.trainerName)}` : '',
    html(item.clubName),
  ].filter(Boolean);

  if (state === 'remind') {
    lines.push('', 'Ви прийдете?');
    if (!canCancelNow(item.start, item.cutoffMinutes)) {
      lines.push(cancelClosedHint(item));
    }
  }
  if (state === 'ask-cancel') {
    lines.push('', 'Час повернеться в розклад, і його зможе забронювати хтось інший.');
  }
  if (state === 'cancelled') {
    lines.push('', 'Час повернувся в розклад. Дякуємо, що попередили!');
  }

  return lines.join('\n');
}

function cancelClosedHint(item: PlayerItem) {
  const phone = item.clubPhone ? ` — ${html(item.clubPhone)}` : '';
  return `<i>Скасувати онлайн уже пізно. Якщо не встигаєте, зателефонуйте в клуб${phone}.</i>`;
}

const cb = (action: string, item: { kind: PlayerItemKind; id: string }) =>
  `pl:${action}:${item.kind}:${item.id}`;

export function playerCardKeyboard(item: PlayerItem, state: CardState) {
  if (state === 'ask-cancel') {
    return {
      inline_keyboard: [[
        { text: 'Так, скасувати', callback_data: cb('yes', item) },
        { text: 'Ні, я прийду', callback_data: cb('ok', item) },
      ]],
    };
  }
  if (state === 'remind' || state === 'confirmed') {
    const row = [];
    if (state === 'remind') row.push({ text: '✅ Прийду', callback_data: cb('ok', item) });
    if (canCancelNow(item.start, item.cutoffMinutes)) {
      row.push({ text: '❌ Скасувати', callback_data: cb('ask', item) });
    }
    const base = item.clubSlug ? bookingUrl(item.clubSlug) : null;
    if (item.kind === 'b' && base && canReschedule(item.start)) {
      const url = `${base}?cbMove=${encodeURIComponent(item.id)}`;
      row.push({ text: '↪️ Перенести', ...(url.startsWith('https://') ? { web_app: { url } } : { url }) });
    }
    return row.length ? { inline_keyboard: [row] } : undefined;
  }
  return undefined;
}

type Action = { action: 'ok' | 'ask' | 'yes'; kind: PlayerItemKind; id: string };

export function parsePlayerAction(data: string | undefined): Action | null {
  const m = /^pl:(ok|ask|yes):([bs]):([0-9a-f-]{36})$/.exec(data ?? '');
  return m ? { action: m[1] as Action['action'], kind: m[2] as PlayerItemKind, id: m[3] } : null;
}

/* ── Кнопки й команди ───────────────────────────────────────────────────── */

/**
 * Натиснута гравцева кнопка. Повертає false, якщо кнопка не гравцева, —
 * тоді її розбирає решта обробника.
 */
export async function handlePlayerCallback(q: NonNullable<TgUpdate['callback_query']>): Promise<boolean> {
  const act = parsePlayerAction(q.data);
  if (!act) {
    if (q.data?.startsWith('wl:')) return handleWaitlistCallback(q);
    return false;
  }

  const chatId = String(q.message?.chat.id ?? q.from?.id ?? '');
  const item = await loadPlayerItem(act.kind, act.id);

  /* Чужий запис або кнопка з чату, від якого гравець уже відвʼязався.
     Відповідаємо однаково — не підказуємо, що такий id існує. */
  if (!item || !chatId || item.chatId !== chatId) {
    await answerCallback(q.id, 'Цей запис вам недоступний');
    return true;
  }

  const redraw = async (state: CardState) => {
    if (q.message) {
      await editMessageText(chatId, q.message.message_id, playerCardText(item, state), playerCardKeyboard(item, state));
    }
  };

  if (!item.active || item.start.getTime() <= Date.now()) {
    await redraw('gone');
    await answerCallback(q.id);
    return true;
  }

  if (act.action === 'ok') {
    const data = { playerConfirmedAt: item.confirmedAt ?? new Date() };
    if (item.kind === 'b') await prisma.booking.update({ where: { id: item.id }, data });
    else await prisma.bookingSeat.update({ where: { id: item.id }, data });
    await redraw('confirmed');
    await answerCallback(q.id, 'Записали: ви прийдете');
    return true;
  }

  if (act.action === 'ask') {
    if (!canCancelNow(item.start, item.cutoffMinutes)) {
      await redraw('remind');
      await answerCallback(q.id, 'Скасувати онлайн уже пізно — зателефонуйте в клуб');
      return true;
    }
    await redraw('ask-cancel');
    await answerCallback(q.id);
    return true;
  }

  /* yes — скасовуємо тими самими правилами, що й кнопка у віджеті. */
  const result = item.kind === 'b'
    ? await cancelBookingByCustomer(item.id)
    : await cancelSeatByCustomer(item.id, (seat) => seat.customerId != null);

  if (!result.ok) {
    await redraw('remind');
    await answerCallback(
      q.id,
      result.code === 'NOT_FOUND' ? 'Запис не знайдено' : 'Скасувати онлайн уже пізно — зателефонуйте в клуб',
    );
    return true;
  }

  await redraw('cancelled');
  await answerCallback(q.id, 'Скасовано');
  return true;
}

async function handleWaitlistCallback(q: NonNullable<TgUpdate['callback_query']>): Promise<boolean> {
  const m = /^wl:leave:([0-9a-f-]{36})$/.exec(q.data ?? '');
  if (!m) return false;

  const chatId = String(q.message?.chat.id ?? q.from?.id ?? '');
  const entry = await prisma.waitlistEntry.findUnique({
    where: { id: m[1] },
    select: { id: true, status: true, customer: { select: { telegramChatId: true } } },
  });
  if (!entry || !chatId || entry.customer.telegramChatId !== chatId) {
    await answerCallback(q.id, 'Цей запис вам недоступний');
    return true;
  }

  if (entry.status === 'WAITING' || entry.status === 'OFFERED') {
    await prisma.waitlistEntry.update({ where: { id: entry.id }, data: { status: 'CANCELLED' } });
  }
  if (q.message) {
    await editMessageText(chatId, q.message.message_id, 'Ви вийшли з черги на цей час.');
  }
  await answerCallback(q.id, 'Готово');
  return true;
}

/** Гравцеві команди. Повертає false, якщо команда не про гравця. */
export async function handlePlayerCommand(chatId: string, cmd: string, args: string[]): Promise<boolean> {
  if (cmd === '/my') {
    const customers = await prisma.customer.findMany({
      where: { telegramChatId: chatId },
      select: { id: true },
    });
    if (customers.length === 0) return false;
    await sendMyRecords(chatId, customers.map((c) => c.id));
    return true;
  }

  /* Підбір партнерів. Живе в чаті, а не у віджеті: пошук «з ким зіграти»
     тягнеться днями, і перевіряти вкладку заради нього ніхто не буде. */
  if (cmd === '/games') {
    const customers = await prisma.customer.findMany({
      where: { telegramChatId: chatId },
      select: { id: true },
    });
    if (customers.length === 0) return false;
    /* Імпорт на місці, а не зверху: openMatchBot бере звідси підписи часу
       й посилання на день, тож статичний імпорт замкнув би коло. */
    const { sendMatches } = await import('./openMatchBot.js');
    await sendMatches(chatId);
    return true;
  }

  if (cmd === '/stop') {
    const customers = await prisma.customer.findMany({
      where: { telegramChatId: chatId },
      select: { id: true },
    });
    if (customers.length === 0) return false;
    await unlinkPlayers(customers.map((c) => c.id));
    await sendMessage(
      chatId,
      'Готово — більше нічого не надсилатиму. Підключити знову можна в профілі гравця на сторінці клубу.',
      { keyboard: [[{ text: '👤 Увійти в профіль' }, { text: '🎾 Забронювати' }]], resize_keyboard: true },
    );
    return true;
  }

  return false;
}

/**
 * Відвʼязати чат від карток гравця разом із чергою.
 *
 * Черга без Telegram нічого не варта: сповістити про звільнений час більше
 * нікуди, а стояти першим і мовчки тримати чергу перед іншими — гірше, ніж
 * не стояти.
 */
export async function unlinkPlayers(customerIds: string[]) {
  await prisma.$transaction([
    prisma.waitlistEntry.updateMany({
      where: { customerId: { in: customerIds }, status: { in: ['WAITING', 'OFFERED'] } },
      data: { status: 'CANCELLED' },
    }),
    prisma.customer.updateMany({
      where: { id: { in: customerIds } },
      /* Разом із чатом іде й згода на акції: без Telegram її нікуди слати,
         а після повторного підключення людину спитають заново (тому
         скидаємо й мітку «питали»). */
      data: {
        telegramChatId: null, tgLinkCode: null, tgLinkUntil: null,
        tgMarketingAt: null, tgMarketingAskedAt: null,
      },
    }),
  ]);
}

async function sendMyRecords(chatId: string, customerIds: string[]) {
  const now = new Date();
  const horizon = new Date(now.getTime() + 14 * 86_400_000);

  const [bookings, seats] = await Promise.all([
    prisma.booking.findMany({
      where: {
        customerId: { in: customerIds },
        capacity: null,
        status: { in: ['PENDING', 'CONFIRMED'] },
        startTime: { gt: now, lte: horizon },
      },
      select: { id: true },
      orderBy: { startTime: 'asc' },
      take: 5,
    }),
    prisma.bookingSeat.findMany({
      where: {
        customerId: { in: customerIds },
        status: 'BOOKED',
        booking: { status: { in: ['PENDING', 'CONFIRMED'] }, startTime: { gt: now, lte: horizon } },
      },
      select: { id: true },
      orderBy: { booking: { startTime: 'asc' } },
      take: 5,
    }),
  ]);

  const items = (await Promise.all([
    ...bookings.map((b) => loadPlayerItem('b', b.id)),
    ...seats.map((s) => loadPlayerItem('s', s.id)),
  ])).filter((i): i is PlayerItem => Boolean(i))
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, 5);

  if (items.length === 0) {
    await sendMessage(chatId, 'На найближчі два тижні записів немає.');
    return;
  }

  /* Кожен запис окремим повідомленням: у кожного свої кнопки, і
     скасування одного не має перемальовувати список цілком. */
  for (const item of items) {
    const state: CardState = item.confirmedAt ? 'confirmed' : 'remind';
    await sendMessage(chatId, playerCardText(item, state, now), playerCardKeyboard(item, state));
  }
}

/** Посилання на розклад клубу одразу на потрібний день */
export function bookingDayUrl(slug: string, date: string): string | null {
  const base = bookingUrl(slug);
  return base ? `${base}?cbDate=${date}` : null;
}
