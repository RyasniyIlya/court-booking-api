import { DateTime } from 'luxon';
import { z } from 'zod';

import { prisma } from '../db';
import {
  bookingExportWorkbookSheets, loadBookingExport, type BookingExportMeta, type BookingExportRow,
} from '../bookingExport';
import { loadRoster, rosterWorkbookSheets, type ExportMeta } from '../customerRoster';
import { buildWorkbook, type SheetSpec } from '../xlsx';
import type { EffectivePermissions, ReadScope } from './policy';

/**
 * Файли-звіти ІІ-менеджера (xlsx).
 *
 * Файл НЕ лежить у базі й не вкладається в чат: в AiAction зберігаються лише
 * параметри звіту, а книгу збирає GET /api/admin/ai/actions/:id/file у момент
 * завантаження — на поточних даних і за ПОТОЧНИМИ правами того, хто качає.
 * Так закритий пізніше доступ (власник вимкнув «читати клієнтів») не лишає
 * в журналі готового файла з тим, що вже заборонено.
 *
 * Дані — з тих самих вибірок, що й вивантаження в кабінеті (bookingExport,
 * customerRoster); тут вони лише звужуються за правами й агрегуються.
 * Книга збирається власним записувачем lib/xlsx.ts, як і решта вивантажень.
 */

export const REPORT_TYPES = ['bookings', 'revenue', 'customers', 'trainers', 'courts'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_LABELS: Record<ReportType, string> = {
  bookings: 'Бронювання',
  revenue: 'Виручка',
  customers: 'Клієнти',
  trainers: 'Тренери',
  courts: 'Корти',
};

/**
 * Яке читання потрібне звіту ЦІЛКОМ. null — звіт можна збудувати для всіх, а закриті
 * колонки просто знімаються (бронювання, корти). Звіт, який складається з закритої
 * області (виручка, клієнти, тренери), без права відхиляється, а не віддається порожнім.
 */
export const REPORT_NEEDS: Record<ReportType, ReadScope | null> = {
  bookings: null,
  courts: null,
  revenue: 'readFinance',
  customers: 'readCustomers',
  trainers: 'readStaff',
};

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MAX_DAYS = 366;

export const reportParamsSchema = z.object({
  type: z.enum(REPORT_TYPES),
  from: dateOnly,
  to: dateOnly,
}).strict().superRefine((d, ctx) => {
  const a = DateTime.fromISO(d.from, { zone: 'utc' });
  const b = DateTime.fromISO(d.to, { zone: 'utc' });
  if (!a.isValid || !b.isValid || b < a) ctx.addIssue({ code: 'custom', path: ['to'], message: 'period' });
  else if (b.diff(a, 'days').days > MAX_DAYS) ctx.addIssue({ code: 'custom', path: ['to'], message: 'too long' });
});
export type ReportParams = z.infer<typeof reportParamsSchema>;

/** Причина відмови для цього запитувача або null. Одне місце і для інструмента моделі, і для маршруту файла. */
export function reportRefusal(type: ReportType, perms: EffectivePermissions): string | null {
  if (!perms.access || !perms.reports) return 'Файли-звіти для вашої ролі вимкнено власником клубу.';
  const need = REPORT_NEEDS[type];
  if (need && !perms[need]) {
    const what = need === 'readFinance' ? 'фінанси' : need === 'readCustomers' ? 'клієнтів' : 'персонал';
    return `Звіт «${REPORT_LABELS[type]}» потребує доступу до даних про ${what}, який закрито власником.`;
  }
  return null;
}

/* ── Зняття закритих колонок ──────────────────────────────────────────── */

const isMoney = (h: string) => /грн/.test(h) || ['Спосіб оплати', 'Акції', 'Абонемент'].includes(h);
const isPersonal = (h: string) => ['Клієнт / заняття', 'Клієнт', 'Телефон', 'Імʼя', 'Email', 'День народження', 'Днів до дня народження', 'Нотатка', 'Мітки'].includes(h);
const isStaffData = (h: string) => h === 'Скасував';

function stripColumns(sheet: SheetSpec, drop: (header: string) => boolean): SheetSpec {
  const keep = sheet.headers.map((h, i) => (drop(h) ? -1 : i)).filter((i) => i >= 0);
  return {
    ...sheet,
    headers: keep.map((i) => sheet.headers[i]),
    widths: sheet.widths ? keep.map((i) => sheet.widths![i]) : undefined,
    rows: sheet.rows.map((row) => keep.map((i) => row[i])),
  };
}

function restrict(sheets: SheetSpec[], perms: EffectivePermissions): SheetSpec[] {
  const drop = (h: string) => (!perms.readFinance && isMoney(h)) || (!perms.readCustomers && isPersonal(h)) || (!perms.readStaff && isStaffData(h));
  return sheets.map((s) => stripColumns(s, drop));
}

/* ── Побудова ─────────────────────────────────────────────────────────── */

const money = (kop: number) => Math.round(kop) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

type Bounds = { from: Date; to: Date; tz: string };

function aboutSheet(club: { name: string; timezone: string }, params: ReportParams, perms: EffectivePermissions, extra: string[] = []): SheetSpec {
  const hidden = [
    !perms.readFinance ? 'фінансові колонки' : null,
    !perms.readCustomers ? 'дані клієнтів' : null,
    !perms.readStaff ? 'дані персоналу' : null,
  ].filter(Boolean);
  return {
    name: 'Про звіт',
    headers: ['Показник', 'Значення'],
    widths: [30, 80],
    rows: [
      ['Клуб', club.name],
      ['Звіт', REPORT_LABELS[params.type]],
      ['Період', `${params.from} — ${params.to}`],
      ['Часовий пояс', club.timezone],
      ['Сформовано', DateTime.now().setZone(club.timezone).toFormat('dd.LL.yyyy HH:mm')],
      ['Сформовано ІІ-менеджером', 'Дані — з кабінету клубу на момент завантаження файла.'],
      ...(hidden.length ? [['Приховано за правами', hidden.join(', ')]] : []),
      ...extra.map((t) => ['Примітка', t]),
    ],
  };
}

function courtsSheets(rows: BookingExportRow[]): SheetSpec[] {
  const by = new Map<string, { active: number; cancelled: number; hours: number; court: number }>();
  for (const r of rows) {
    const c = by.get(r.courtName) ?? { active: 0, cancelled: 0, hours: 0, court: 0 };
    if (r.status === 'CANCELLED' || r.status === 'EXPIRED') c.cancelled += 1;
    else {
      c.active += 1;
      c.hours += (r.endTime.getTime() - r.startTime.getTime()) / 3_600_000;
      if (r.status === 'CONFIRMED') c.court += r.priceTotal - r.trainerPrice - r.rentalTotal;
    }
    by.set(r.courtName, c);
  }
  return [{
    name: 'Корти',
    headers: ['Корт', 'Броней', 'Скасовано', 'Годин', 'Виручка корту, грн'],
    widths: [24, 10, 12, 10, 20],
    rows: [...by.entries()].sort(([a], [b]) => a.localeCompare(b, 'uk')).map(([name, c]) => [name, c.active, c.cancelled, round1(c.hours), money(c.court)]),
  }];
}

function revenueSheets(rows: BookingExportRow[], tz: string): SheetSpec[] {
  const day = new Map<string, { bookings: number; court: number; trainer: number; rental: number; paid: number; refunded: number }>();
  const court = new Map<string, { bookings: number; total: number }>();
  for (const r of rows) {
    if (r.status !== 'CONFIRMED') continue;
    const key = DateTime.fromJSDate(r.startTime).setZone(tz).toFormat('yyyy-LL-dd');
    const d = day.get(key) ?? { bookings: 0, court: 0, trainer: 0, rental: 0, paid: 0, refunded: 0 };
    d.bookings += 1;
    d.court += r.priceTotal - r.trainerPrice - r.rentalTotal;
    d.trainer += r.trainerPrice;
    d.rental += r.rentalTotal;
    d.paid += r.paid;
    d.refunded += r.refunded;
    day.set(key, d);
    const c = court.get(r.courtName) ?? { bookings: 0, total: 0 };
    c.bookings += 1;
    c.total += r.priceTotal;
    court.set(r.courtName, c);
  }
  return [
    {
      name: 'По днях',
      headers: ['Дата', 'Броней', 'Корт, грн', 'Тренер, грн', 'Прокат, грн', 'Разом, грн', 'Сплачено, грн', 'Повернено, грн'],
      widths: [12, 9, 13, 13, 13, 13, 15, 16],
      rows: [...day.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, d]) => [
        k, d.bookings, money(d.court), money(d.trainer), money(d.rental), money(d.court + d.trainer + d.rental), money(d.paid), money(d.refunded),
      ]),
    },
    {
      name: 'По кортах',
      headers: ['Корт', 'Броней', 'Надано послуг, грн'],
      widths: [24, 9, 20],
      rows: [...court.entries()].sort(([a], [b]) => a.localeCompare(b, 'uk')).map(([name, c]) => [name, c.bookings, money(c.total)]),
    },
  ];
}

async function trainersSheets(clubId: string, b: Bounds): Promise<SheetSpec[]> {
  const rows = await prisma.booking.findMany({
    where: { clubId, trainerId: { not: null }, status: 'CONFIRMED', startTime: { gte: b.from, lt: b.to } },
    select: { trainerPrice: true, startTime: true, endTime: true, trainer: { select: { name: true } } },
  });
  const by = new Map<string, { sessions: number; hours: number; price: number }>();
  for (const r of rows) {
    const name = r.trainer?.name ?? '—';
    const t = by.get(name) ?? { sessions: 0, hours: 0, price: 0 };
    t.sessions += 1;
    t.hours += (r.endTime.getTime() - r.startTime.getTime()) / 3_600_000;
    t.price += r.trainerPrice;
    by.set(name, t);
  }
  return [{
    name: 'Тренери',
    headers: ['Тренер', 'Занять', 'Годин', 'Нараховано тренеру, грн'],
    widths: [26, 10, 10, 24],
    rows: [...by.entries()].sort(([a], [b]) => a.localeCompare(b, 'uk')).map(([name, t]) => [name, t.sessions, round1(t.hours), money(t.price)]),
  }];
}

/** Дати звіту в часі клубу: [from 00:00, to+1 00:00). */
function boundsOf(params: ReportParams, tz: string): Bounds {
  return {
    from: DateTime.fromISO(params.from, { zone: tz }).startOf('day').toJSDate(),
    to: DateTime.fromISO(params.to, { zone: tz }).endOf('day').toJSDate(),
    tz,
  };
}

export class ReportRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportRefused';
  }
}

export async function buildReportFile(
  clubId: string,
  params: ReportParams,
  perms: EffectivePermissions,
): Promise<{ fileName: string; buffer: Buffer }> {
  const refusal = reportRefusal(params.type, perms);
  if (refusal) throw new ReportRefused(refusal);

  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { name: true, timezone: true } });
  if (!club) throw new ReportRefused('Клуб не знайдено.');
  const bounds = boundsOf(params, club.timezone);
  const now = new Date();

  let sheets: SheetSpec[];
  let extra: string[] = [];
  switch (params.type) {
    case 'bookings': {
      const data = await loadBookingExport(clubId, { from: bounds.from, to: bounds.to });
      const meta: BookingExportMeta = { clubName: club.name, timezone: club.timezone, now, from: bounds.from, to: bounds.to };
      /* Аркуш «Як читати» несе загальні суми оплат: замість нього — власний «Про звіт», звужений за правами. */
      const all = bookingExportWorkbookSheets(data, meta).filter((s) => s.name !== 'Як читати');
      /* Місця групових — це по рядку на кожну людину: без права на клієнтів аркуш не віддається. */
      sheets = restrict(perms.readCustomers ? all : all.filter((s) => s.name !== 'Місця в групових заняттях'), perms);
      break;
    }
    case 'courts':
      sheets = restrict(courtsSheets((await loadBookingExport(clubId, { from: bounds.from, to: bounds.to })).bookings), perms);
      break;
    case 'revenue':
      sheets = revenueSheets((await loadBookingExport(clubId, { from: bounds.from, to: bounds.to })).bookings, club.timezone);
      extra = ['Нарахування підтверджених броней за датою гри, не каса.'];
      break;
    case 'trainers':
      sheets = restrict(await trainersSheets(clubId, bounds), perms);
      break;
    case 'customers': {
      const roster = await loadRoster(clubId, {}, now);
      const meta: ExportMeta = { clubName: club.name, timezone: club.timezone, now, filter: {} };
      sheets = restrict(rosterWorkbookSheets(roster, meta).slice(0, 1), perms);
      extra = ['Картотека клієнтів — на дату формування; період звіту до неї не застосовується.'];
      break;
    }
  }

  sheets.push(aboutSheet(club, params, perms, extra));
  const buffer = buildWorkbook(sheets);
  return { fileName: `Звіт-${REPORT_LABELS[params.type]}-${params.from}_${params.to}.xlsx`, buffer };
}
