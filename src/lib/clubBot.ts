import { DateTime } from 'luxon';
import { z } from 'zod';

import { bookingUrl, profileUrl } from './botBooking';
import { validIntervals } from './trainerAvailability';

/**
 * Клубний шар спільного Telegram-бота: налаштування власника й чисті
 * рендерери тексту та кнопок.
 *
 * ── Чому бот один, а клуб «свій» ─────────────────────────────────────────
 *
 * Назву й аватар бота не можна змінити під клуб: токен спільний для всієї
 * платформи. Тому клуб присутній у тексті — першим рядком кожного
 * повідомлення, привітанням, адресою й акціями. Власник керує саме цим.
 *
 * ── Чому без prisma ──────────────────────────────────────────────────────
 *
 * Той самий рендерер малює і повідомлення в боті, і превʼю в кабінеті, тож
 * власник бачить не макет, а справжній текст. Дані (акції, тренери) сюди
 * приходять готовими — читає їх lib/playerHome.ts.
 */

export const WINBACK_AFTER_DAYS = [14, 21, 30, 45, 60, 90] as const;
/** Раз на тиждень / раз на два тижні / раз на місяць */
export const WINBACK_EVERY_DAYS = [7, 14, 30] as const;
export const WINBACK_MAX = [1, 2, 3, 4, 5] as const;

export type WinbackSettings = {
  enabled: boolean;
  afterDays: (typeof WINBACK_AFTER_DAYS)[number];
  everyDays: (typeof WINBACK_EVERY_DAYS)[number];
  maxMessages: (typeof WINBACK_MAX)[number];
  text: string;
  promoId: string | null;
};

export type BotSettings = {
  /** ≤48; null — назва клубу */
  displayName: string | null;
  /** ≤600, плейсхолдери {name} {club} */
  welcome: string;
  showAddress: boolean;
  showPhone: boolean;
  showPromos: boolean;
  /** null — усі активні; інакше тільки ці (≤10) */
  promoIds: string[] | null;
  showTrainers: boolean;
  /** null — усі активні */
  trainerIds: string[] | null;
  winback: WinbackSettings;
  /** Ранкова сводка ІІ-менеджера власнику в Telegram (етап 3). Типово вимкнена: платний виклик моделі. */
  morningBrief: MorningBriefSettings;
  /** Повідомляти власника про нові пропозиції ІІ, що чекають рішення */
  actionAlerts: boolean;
};

export const BRIEF_HOURS = [5, 6, 7, 8, 9, 10, 11, 12] as const;

export type MorningBriefSettings = {
  enabled: boolean;
  /** Година за часом клубу */
  hour: (typeof BRIEF_HOURS)[number];
};

export const DEFAULT_WELCOME =
  'Вітаємо, {name}! Це бот клубу {club}: бронюйте корт, дивіться свої записи й отримуйте нагадування.';
export const DEFAULT_WINBACK =
  '{name}, давно вас не бачили — вже {days} днів! Корт чекає. Оберіть зручний час 👇';

export const MAX_NAME = 48;
export const MAX_TEXT = 600;
export const MAX_PROMO_IDS = 10;
const MAX_TRAINER_IDS = 50;

/** Звернення, коли імені немає (гість без картки): нейтральне за родом */
const GUEST_NAME = 'гостю';

export const defaultBotSettings = (): BotSettings => ({
  displayName: null,
  welcome: DEFAULT_WELCOME,
  showAddress: true,
  showPhone: true,
  showPromos: true,
  promoIds: null,
  showTrainers: true,
  trainerIds: null,
  winback: {
    enabled: false,
    afterDays: 30,
    everyDays: 7,
    maxMessages: 3,
    text: DEFAULT_WINBACK,
    promoId: null,
  },
  /* Вимкнено навмисно: сводка коштує грошей, а несподіване повідомлення вранці
     власник має ввімкнути сам. Сповіщення про пропозиції — навпаки, типово
     вмикаємо: пропозиція без відповіді просто спливає за 48 годин. */
  morningBrief: { enabled: false, hour: 8 },
  actionAlerts: true,
});

/* ── Валідація ─────────────────────────────────────────────────────────── */

/** Допустимі значення — рівно ті, що є кнопками в кабінеті */
const afterDaysSchema = z.union([z.literal(14), z.literal(21), z.literal(30), z.literal(45), z.literal(60), z.literal(90)]);
const everyDaysSchema = z.union([z.literal(7), z.literal(14), z.literal(30)]);
const maxSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);

/**
 * Тіло PUT. strict: невідоме поле — це або одруківка фронтенду, або спроба
 * покласти в базу те, чого бот не вміє читати; тихо відкинути гірше за 400.
 */
export const botSettingsSchema = z.strictObject({
  displayName: z.string().trim().max(MAX_NAME).nullable(),
  welcome: z.string().trim().max(MAX_TEXT),
  showAddress: z.boolean(),
  showPhone: z.boolean(),
  showPromos: z.boolean(),
  promoIds: z.array(z.string().uuid()).max(MAX_PROMO_IDS).nullable(),
  showTrainers: z.boolean(),
  trainerIds: z.array(z.string().uuid()).max(MAX_TRAINER_IDS).nullable(),
  winback: z.strictObject({
    enabled: z.boolean(),
    afterDays: afterDaysSchema,
    everyDays: everyDaysSchema,
    maxMessages: maxSchema,
    text: z.string().trim().max(MAX_TEXT),
    promoId: z.string().uuid().nullable(),
  }),
  /* Необовʼязкові: старий кабінет (без цих полів) не має отримувати 400 —
     відсутнє поле означає «лишити як було», це робить роут. */
  morningBrief: z.strictObject({
    enabled: z.boolean(),
    hour: z.number().int().min(BRIEF_HOURS[0]).max(BRIEF_HOURS[BRIEF_HOURS.length - 1]),
  }).optional(),
  actionAlerts: z.boolean().optional(),
});

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);

function text(v: unknown, max: number, def: string): string {
  if (typeof v !== 'string') return def;
  const t = v.trim().slice(0, max);
  return t || def;
}

function pick<T extends number>(v: unknown, list: readonly T[], def: T): T {
  return list.find((n) => n === v) ?? def;
}

function ids(v: unknown, max: number): string[] | null {
  if (!Array.isArray(v)) return null;
  const list = [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  return list.slice(0, max);
}

/**
 * Будь-що з бази → валідні налаштування.
 *
 * Не кидає ніколи: у Club.botSettings лежить Json, і там може бути `{}` (усі
 * клуби після міграції), обрізок зі старої версії або сміття. Кожне поле
 * перевіряється окремо й при невдачі отримує типове значення — одне зіпсоване
 * поле не має відключати бота цілому клубу.
 */
export function normalizeBotSettings(raw: unknown): BotSettings {
  const def = defaultBotSettings();
  const r = isObj(raw) ? raw : {};
  const w = isObj(r.winback) ? r.winback : {};
  const mb = isObj(r.morningBrief) ? r.morningBrief : {};

  const name = typeof r.displayName === 'string' ? r.displayName.trim().slice(0, MAX_NAME) : '';

  return {
    displayName: name || null,
    welcome: text(r.welcome, MAX_TEXT, def.welcome),
    showAddress: bool(r.showAddress, def.showAddress),
    showPhone: bool(r.showPhone, def.showPhone),
    showPromos: bool(r.showPromos, def.showPromos),
    promoIds: ids(r.promoIds, MAX_PROMO_IDS),
    showTrainers: bool(r.showTrainers, def.showTrainers),
    trainerIds: ids(r.trainerIds, MAX_TRAINER_IDS),
    winback: {
      enabled: bool(w.enabled, def.winback.enabled),
      afterDays: pick(w.afterDays, WINBACK_AFTER_DAYS, def.winback.afterDays),
      everyDays: pick(w.everyDays, WINBACK_EVERY_DAYS, def.winback.everyDays),
      maxMessages: pick(w.maxMessages, WINBACK_MAX, def.winback.maxMessages),
      text: text(w.text, MAX_TEXT, def.winback.text),
      promoId: typeof w.promoId === 'string' && w.promoId ? w.promoId : null,
    },
    morningBrief: {
      enabled: bool(mb.enabled, def.morningBrief.enabled),
      hour: pick(mb.hour, BRIEF_HOURS, def.morningBrief.hour),
    },
    actionAlerts: bool(r.actionAlerts, def.actionAlerts),
  };
}

/* ── Текст ─────────────────────────────────────────────────────────────── */

export const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * Підставити {name} {club} {days} у текст власника.
 *
 * Екрануємо І шаблон, І значення: текст пише власник, імʼя — гравець, а
 * Telegram у режимі HTML відхиляє все повідомлення цілком через один
 * незакритий «<». Підстановка одним проходом: значення з «{club}» усередині
 * імені не розкриється вдруге.
 */
export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return escapeHtml(tpl).replace(/\{(\w+)\}/g, (whole, key: string) =>
    (Object.hasOwn(vars, key) ? escapeHtml(vars[key]) : whole));
}

/* ── Акції й тренери ───────────────────────────────────────────────────── */

/** Порядок днів у підписі — з понеділка; у базі 0 = неділя */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_SHORT: Record<number, string> = { 1: 'пн', 2: 'вт', 3: 'ср', 4: 'чт', 5: 'пт', 6: 'сб', 0: 'нд' };

/** «пн–пт», «пн, ср, сб», «щодня» */
function weekdaysLabel(days: number[]): string {
  const set = new Set(days);
  if (WEEK_ORDER.every((d) => set.has(d))) return 'щодня';

  const parts: string[] = [];
  let i = 0;
  while (i < WEEK_ORDER.length) {
    if (!set.has(WEEK_ORDER[i])) { i += 1; continue; }
    let j = i;
    while (j + 1 < WEEK_ORDER.length && set.has(WEEK_ORDER[j + 1])) j += 1;
    /* Серія з двох днів — це «пн, вт», а не «пн–вт»: тире читається як
       «усе між ними», і на двох днях воно нічого не скорочує. */
    if (j - i >= 2) parts.push(`${DAY_SHORT[WEEK_ORDER[i]]}–${DAY_SHORT[WEEK_ORDER[j]]}`);
    else for (let k = i; k <= j; k += 1) parts.push(DAY_SHORT[WEEK_ORDER[k]]);
    i = j + 1;
  }
  return parts.join(', ');
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Хвилини від опівночі → «07:00»; зміна після півночі (>1440) заходить на наступну добу */
export const clock = (minute: number) => `${pad(Math.floor(minute / 60) % 24)}:${pad(minute % 60)}`;

const utcDay = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const dt = d instanceof Date ? DateTime.fromJSDate(d, { zone: 'utc' }) : DateTime.fromISO(d, { zone: 'utc' });
  return dt.isValid ? dt.toFormat('dd.MM') : null;
};

export type PromoLike = {
  kind: 'WEEKLY' | 'DATES' | 'BIRTHDAY';
  weekdays?: number[];
  dateFrom?: Date | string | null;
  dateTo?: Date | string | null;
  startMinute: number;
  endMinute: number;
  discountType: 'PERCENT' | 'PRICE';
  discountValue: number;
};

/**
 * Коротко про умови акції: «−20% · пн–пт · 07:00–12:00».
 *
 * Дати акції — календарні (@db.Date), тому читаємо їх у UTC: зсув у
 * часовий пояс клубу зробив би з 15 жовтня 14-те.
 */
export function promoSummary(p: PromoLike): string {
  const parts: string[] = [];

  if (p.discountType === 'PERCENT') {
    parts.push(`−${p.discountValue}%`);
  } else {
    const uah = p.discountValue / 100;
    parts.push(`${Number.isInteger(uah) ? uah : uah.toFixed(2).replace('.', ',')} грн/год`);
  }

  if (p.kind === 'WEEKLY') {
    const label = weekdaysLabel(p.weekdays ?? []);
    if (label) parts.push(label);
  } else if (p.kind === 'DATES') {
    const from = utcDay(p.dateFrom);
    const to = utcDay(p.dateTo);
    if (from && to) parts.push(from === to ? from : `${from}–${to}`);
  } else {
    parts.push('до дня народження');
  }

  if (p.startMinute > 0 || p.endMinute < 1440) {
    parts.push(`${clock(p.startMinute)}–${p.endMinute >= 1440 ? '24:00' : clock(p.endMinute)}`);
  }

  return parts.join(' · ');
}

export type TrainerShiftInput = {
  id?: string;
  name: string;
  hours: { weekday: number; openMinute: number; closeMinute: number; isClosed: boolean }[];
  exceptions: {
    date: Date;
    isClosed: boolean;
    kind?: 'WORKING' | 'UNAVAILABLE' | 'DAY_OFF' | 'VACATION';
    intervals: unknown;
  }[];
};

export type TrainerOnShift = { id?: string; name: string; from: string; to: string };

/**
 * Хто з тренерів сьогодні на зміні і в які години.
 *
 * Виняток на дату ПЕРЕКРИВАЄ тижневий графік — так само, як у
 * isTrainerAvailable, за якою віджет відмовляє в записі: бот не має
 * обіцяти тренера, якого запис уже не дасть.
 *   • DAY_OFF / VACATION / isClosed — на зміні нікого;
 *   • WORKING — години з винятку;
 *   • UNAVAILABLE — тижневі години мінус недоступні проміжки.
 * Тренер без налаштованого графіка не показується: годин, які можна
 * назвати, у нього немає.
 *
 * Кілька проміжків за день згортаємо в один «від першого до останнього»:
 * для рядка в привітанні цього досить, а деталі — у розкладі.
 */
export function trainersOnShift(trainers: TrainerShiftInput[], date: DateTime): TrainerOnShift[] {
  const localDate = date.toFormat('yyyy-MM-dd');
  const weekday = date.weekday % 7;
  const rows: { id?: string; name: string; from: number; to: number }[] = [];

  for (const t of trainers) {
    const exception = t.exceptions.find((e) =>
      DateTime.fromJSDate(e.date, { zone: 'utc' }).toFormat('yyyy-MM-dd') === localDate);
    const week = t.hours.find((h) => h.weekday === weekday);
    const weekSpan = week && !week.isClosed ? { from: week.openMinute, to: week.closeMinute } : null;

    let segments: { from: number; to: number }[] = [];

    if (exception) {
      if (exception.isClosed || exception.kind === 'DAY_OFF' || exception.kind === 'VACATION') continue;
      const intervals = validIntervals(exception.intervals);
      if (exception.kind === 'UNAVAILABLE') {
        if (!weekSpan) continue;
        segments = [weekSpan];
        for (const gap of intervals) {
          segments = segments.flatMap((s) => {
            if (gap.endMinute <= s.from || gap.startMinute >= s.to) return [s];
            const out: { from: number; to: number }[] = [];
            if (gap.startMinute > s.from) out.push({ from: s.from, to: gap.startMinute });
            if (gap.endMinute < s.to) out.push({ from: gap.endMinute, to: s.to });
            return out;
          });
        }
      } else {
        segments = intervals.map((i) => ({ from: i.startMinute, to: i.endMinute }));
      }
    } else if (weekSpan) {
      segments = [weekSpan];
    }

    if (segments.length === 0) continue;
    rows.push({
      id: t.id,
      name: t.name,
      from: Math.min(...segments.map((s) => s.from)),
      to: Math.max(...segments.map((s) => s.to)),
    });
  }

  return rows
    .sort((a, b) => a.from - b.from || a.name.localeCompare(b.name, 'uk'))
    .map((r) => ({ ...(r.id ? { id: r.id } : {}), name: r.name, from: clock(r.from), to: clock(r.to) }));
}

/* ── Кнопки ────────────────────────────────────────────────────────────── */

export type InlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
};

export type HomeView = { text: string; keyboard: InlineButton[][] };

/** https → Mini App усередині Telegram; http (локальна розробка) — звичайне посилання */
const linkButton = (text: string, url: string): InlineButton =>
  (url.startsWith('https://') ? { text, web_app: { url } } : { text, url });

/** Для превʼю в кабінеті: як саме кнопка поводиться в Telegram */
export function describeKeyboard(keyboard: InlineButton[][]) {
  return keyboard.map((row) => row.map((b) => ({
    text: b.text,
    kind: b.web_app ? 'webapp' as const : b.url ? 'url' as const : 'callback' as const,
  })));
}

/* ── Рендерери ─────────────────────────────────────────────────────────── */

const MAX_PROMO_LINES = 3;

type ClubLine = { name: string; slug: string; address?: string | null; phone?: string | null };

const shownName = (club: { name: string }, settings: BotSettings) => settings.displayName || club.name;

export function renderClubHome(input: {
  club: ClubLine;
  settings: BotSettings;
  playerName: string | null;
  promos: { id: string; title: string; summary: string }[];
  trainers: TrainerOnShift[];
  /** Скільки ще клубів привʼязано до цього чату */
  otherClubs: number;
  env?: NodeJS.ProcessEnv;
}): HomeView {
  const { club, settings, playerName, otherClubs, env } = input;
  const name = shownName(club, settings);

  const lines = [
    `🎾 <b>${escapeHtml(name)}</b>`,
    '',
    fillTemplate(settings.welcome, { name: playerName ?? GUEST_NAME, club: name }),
  ];

  const contacts = [
    settings.showAddress && club.address ? `📍 ${escapeHtml(club.address)}` : '',
    settings.showPhone && club.phone ? `☎️ ${escapeHtml(club.phone)}` : '',
  ].filter(Boolean);
  if (contacts.length) lines.push('', ...contacts);

  /* Неактивна чи чужа акція з promoIds просто не знайдеться серед `promos`
     (туди loadClubHome кладе лише активні акції клубу) — окремо чистити
     список не треба. */
  const promos = !settings.showPromos ? [] : settings.promoIds
    ? input.promos.filter((p) => settings.promoIds!.includes(p.id))
    : input.promos;
  if (promos.length) {
    lines.push('', '🔥 <b>Акції</b>');
    for (const p of promos.slice(0, MAX_PROMO_LINES)) {
      lines.push(`• ${escapeHtml(p.title)} — ${escapeHtml(p.summary)}`);
    }
    if (promos.length > MAX_PROMO_LINES) lines.push(`…ще ${promos.length - MAX_PROMO_LINES}`);
  }

  const trainers = !settings.showTrainers ? [] : settings.trainerIds
    ? input.trainers.filter((t) => t.id && settings.trainerIds!.includes(t.id))
    : input.trainers;
  if (trainers.length) {
    lines.push('', '🧑‍🏫 <b>Сьогодні на зміні</b>');
    for (const t of trainers) lines.push(`• ${escapeHtml(t.name)} · ${t.from}–${t.to}`);
  }

  const book = bookingUrl(club.slug, env);
  const profile = playerName != null ? profileUrl(club.slug, env) : null;

  const keyboard: InlineButton[][] = [];
  if (book) keyboard.push([linkButton('🎾 Забронювати', book)]);
  const second: InlineButton[] = [{ text: '📋 Мої записи', callback_data: 'home:my' }];
  if (profile) second.push(linkButton('👤 Мій профіль', profile));
  keyboard.push(second);
  if (otherClubs > 0) keyboard.push([{ text: '🔁 Інший клуб', callback_data: 'home:clubs' }]);

  return { text: lines.join('\n'), keyboard };
}

/**
 * Лист тому, хто давно не грав.
 *
 * «Не надсилати таке» — обовʼязкова кнопка: відписка одним натисканням
 * під самим листом — умова, за якої ми взагалі маємо право його слати.
 */
export function renderWinback(input: {
  club: { name: string; slug: string };
  settings: BotSettings;
  playerName: string | null;
  days: number;
  promo: { title: string; summary: string } | null;
  customerId: string;
  env?: NodeJS.ProcessEnv;
}): HomeView {
  const { club, settings, env } = input;
  const name = shownName(club, settings);

  const body = fillTemplate(settings.winback.text, {
    name: input.playerName ?? GUEST_NAME,
    club: name,
    days: String(input.days),
  });
  const promo = input.promo
    ? `\n\n🔥 ${escapeHtml(input.promo.title)} — ${escapeHtml(input.promo.summary)}`
    : '';

  const book = bookingUrl(club.slug, env);
  const keyboard: InlineButton[][] = [];
  if (book) keyboard.push([linkButton('🎾 Обрати час', book)]);
  keyboard.push([{ text: '🔕 Не надсилати таке', callback_data: `wb:off:${input.customerId}` }]);

  return { text: `🎾 <b>${escapeHtml(name)}</b>\n\n${body}${promo}`, keyboard };
}
