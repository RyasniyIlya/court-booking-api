import { DateTime } from 'luxon';
import { csvCell } from './customerRoster';
import { METHOD_LABEL, CASH_METHODS, type CashMethod } from './cashbook';
import { shiftByAccount, shiftTotals, type LedgerLike } from './shift';

/**
 * Каса за період: історія змін і журнал операцій.
 *
 * Розрахунки тут, а не в роутах: межі доби в таймзоні клубу, підсумки
 * змін і зведення журналу — це арифметика, яку треба перевіряти без бази.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Скільки днів дозволено в одному запиті: рік із запасом на високосний. */
export const MAX_RANGE_DAYS = 366;

export type DayRange = {
  /** Початок першого дня, включно. */
  start: Date;
  /** Початок дня ПІСЛЯ останнього — виключно. `to` у запиті включний. */
  endExclusive: Date;
  /** Список локальних дат клубу «yyyy-MM-dd» від from до to. */
  days: string[];
};

/**
 * Діапазон локальних дат клубу -> межі в UTC.
 *
 * Доба — за таймзоною клубу, а не сервера: операція о 00:30 за Києвом — це
 * вже наступний день, хоч у UTC вона ще вчорашня. Верхня межа — початок
 * наступної доби, а не «23:59:59.999»: так нічого не губиться між мілісекундами
 * і переходом на літній час (доба може мати 23 чи 25 годин).
 *
 * null — дати зіпсовані, перевернуті або діапазон довший за MAX_RANGE_DAYS.
 */
export function dayRange(from: string, to: string, timezone: string): DayRange | null {
  if (!DATE_ONLY.test(from) || !DATE_ONLY.test(to)) return null;
  const first = DateTime.fromISO(from, { zone: timezone }).startOf('day');
  const last = DateTime.fromISO(to, { zone: timezone }).startOf('day');
  if (!first.isValid || !last.isValid || last < first) return null;

  const count = Math.round(last.diff(first, 'days').days) + 1;
  if (count > MAX_RANGE_DAYS) return null;

  const days: string[] = [];
  for (let i = 0; i < count; i += 1) days.push(first.plus({ days: i }).toFormat('yyyy-MM-dd'));

  return {
    start: first.toJSDate(),
    endExclusive: last.plus({ days: 1 }).startOf('day').toJSDate(),
    days,
  };
}

/* ── Історія змін ──────────────────────────────────────────────────────── */

export type ShiftCloseRow = {
  id: string;
  expectedCash: number;
  countedCash: number;
  expectedCard: number;
  countedCard: number;
  transferNet: number;
  bonusNet: number;
  entriesCount: number;
};

export type ShiftPeriodTotals = {
  shifts: number;
  expectedCash: number;
  countedCash: number;
  diffCash: number;
  expectedCard: number;
  countedCard: number;
  diffCard: number;
  transferNet: number;
  bonusNet: number;
  entries: number;
  /** Скільки змін закрито з розбіжністю (по готівці або по терміналу). */
  withDiff: number;
};

/** Підсумок закритих змін за період: очікувалось, пораховано, розбіжність. */
export function shiftPeriodTotals(rows: ShiftCloseRow[]): ShiftPeriodTotals {
  const t: ShiftPeriodTotals = {
    shifts: rows.length,
    expectedCash: 0, countedCash: 0, diffCash: 0,
    expectedCard: 0, countedCard: 0, diffCard: 0,
    transferNet: 0, bonusNet: 0, entries: 0, withDiff: 0,
  };

  for (const r of rows) {
    t.expectedCash += r.expectedCash;
    t.countedCash += r.countedCash;
    t.expectedCard += r.expectedCard;
    t.countedCard += r.countedCard;
    t.transferNet += r.transferNet;
    t.bonusNet += r.bonusNet;
    t.entries += r.entriesCount;
    if (r.countedCash !== r.expectedCash || r.countedCard !== r.expectedCard) t.withDiff += 1;
  }
  t.diffCash = t.countedCash - t.expectedCash;
  t.diffCard = t.countedCard - t.expectedCard;

  return t;
}

/**
 * Сторінка зі списку за курсором «id останнього».
 *
 * Весь період уже в памʼяті (для підсумків його однаково читаємо), тож
 * курсор — просто місце в відсортованому списку, а не ще один запит із
 * `cursor/skip`. null — такого id у списку немає (зіпсований або чужий).
 */
export function pageAfter<T extends { id: string }>(
  rows: T[],
  cursor: string | undefined,
  limit: number,
): { items: T[]; nextCursor: string | null } | null {
  let start = 0;
  if (cursor) {
    const at = rows.findIndex((r) => r.id === cursor);
    if (at < 0) return null;
    start = at + 1;
  }
  const items = rows.slice(start, start + limit);
  const more = start + limit < rows.length;
  return { items, nextCursor: more && items.length ? items[items.length - 1].id : null };
}

/* ── Журнал операцій ───────────────────────────────────────────────────── */

export type LedgerAggRow = LedgerLike & {
  actorEmail: string;
  actorRole: string;
  createdAt: Date;
};

/** Знак операції: повернення віднімається. */
const signed = (e: LedgerLike) => (e.kind === 'REFUND' ? -e.amount : e.amount);

/** Гроші в касі: бонуси — не гроші, їх у «чисте» не кладемо (як у касовій книзі). */
const isMoney = (method: string) => method !== 'BONUS';

export type LedgerSummary = {
  totals: ReturnType<typeof shiftTotals>;
  byAccount: ReturnType<typeof shiftByAccount>;
  byMethod: { method: string; in: number; out: number; net: number; count: number }[];
  byActor: { actorEmail: string; actorRole: string; count: number; net: number }[];
  byDay: { date: string; cash: number; card: number; transfer: number; bonus: number; net: number }[];
};

/**
 * Зведення всіх відфільтрованих операцій періоду.
 *
 * byDay містить КОЖЕН день діапазону, навіть порожній: графік зі
 * стовпчиків без пропусків читається як календар, а з пропущеними днями —
 * як неправда про тривалість.
 *
 * `net` у byDay і byActor — гроші без бонусів (готівка + термінал + переказ
 * й інші грошові способи); бонуси показані окремою колонкою/рядком.
 */
export function ledgerSummary(rows: LedgerAggRow[], timezone: string, days: string[]): LedgerSummary {
  const methods = new Map<string, { method: string; in: number; out: number; net: number; count: number }>();
  const actors = new Map<string, { actorEmail: string; actorRole: string; count: number; net: number }>();
  const perDay = new Map(days.map((date) => [
    date, { date, cash: 0, card: 0, transfer: 0, bonus: 0, net: 0 },
  ]));
  const dayKey: Record<string, 'cash' | 'card' | 'transfer' | 'bonus'> = {
    CASH: 'cash', CARD: 'card', TRANSFER: 'transfer', BONUS: 'bonus',
  };

  for (const e of rows) {
    const m = methods.get(e.method) ?? { method: e.method, in: 0, out: 0, net: 0, count: 0 };
    if (e.kind === 'REFUND') m.out += e.amount; else m.in += e.amount;
    m.net = m.in - m.out;
    m.count += 1;
    methods.set(e.method, m);

    const a = actors.get(e.actorEmail) ?? { actorEmail: e.actorEmail, actorRole: e.actorRole, count: 0, net: 0 };
    a.count += 1;
    if (isMoney(e.method)) a.net += signed(e);
    actors.set(e.actorEmail, a);

    const date = DateTime.fromJSDate(e.createdAt).setZone(timezone).toFormat('yyyy-MM-dd');
    const d = perDay.get(date);
    if (d) {
      const key = dayKey[e.method];
      if (key) d[key] += signed(e);
      if (isMoney(e.method)) d.net += signed(e);
    }
  }

  return {
    totals: shiftTotals(rows),
    byAccount: shiftByAccount(rows),
    byMethod: [...methods.values()].sort((x, y) => y.count - x.count),
    byActor: [...actors.values()].sort((x, y) => y.count - x.count),
    byDay: [...perDay.values()],
  };
}

export type LedgerFacetRow = { method: string; kind: string; account: string; actorEmail: string };

/** Варіанти для випадайок фільтрів: що взагалі було за період, без поточних фільтрів. */
export function ledgerFacets(rows: LedgerFacetRow[]) {
  const uniq = (pick: (r: LedgerFacetRow) => string) => [...new Set(rows.map(pick))].sort((a, b) => a.localeCompare(b, 'uk'));
  return {
    methods: uniq((r) => r.method),
    kinds: uniq((r) => r.kind),
    accounts: uniq((r) => r.account),
    actors: uniq((r) => r.actorEmail),
  };
}

/* ── CSV ───────────────────────────────────────────────────────────────── */

const SEP = ';';
/* Окремою константою з коду символу: літерал BOM у рядку невидимий і його легко втратити при правці. */
const BOM = String.fromCharCode(0xfeff);
/** Колонка «Сума грн»: від'ємне число — не формула, тож захисний апостроф csvCell тут ламав би його. */
const MONEY_COLUMN = 5;
const moneyCell = (value: string) => (/[;,"\r\n]/.test(value) ? `"${value}"` : value);
const KIND_LABEL: Record<string, string> = { PAYMENT: 'Оплата', REFUND: 'Повернення' };

export type LedgerCsvRow = {
  kind: string;
  method: string;
  amount: number;
  account: string;
  note: string;
  actorEmail: string;
  actorRole: string;
  createdAt: Date;
  booking: {
    customerName: string | null;
    title: string | null;
    startTime: Date;
    court: { name: string } | null;
  } | null;
  seat: { customerName: string | null } | null;
  customer: { name: string } | null;
};

const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Власник', ADMIN: 'Модератор', TRAINER: 'Тренер', ACCOUNTANT: 'Бухгалтер',
};

/** Кома як десятковий роздільник: Excel в українській локалі інакше бачить текст. */
const grn = (kop: number) => (kop / 100).toFixed(2).replace('.', ',');

/** Імʼя клієнта операції: місце в групі, картка, бронь — у цьому порядку. */
export function ledgerCustomer(r: Pick<LedgerCsvRow, 'seat' | 'customer' | 'booking'>): string {
  return r.seat?.customerName || r.customer?.name || r.booking?.customerName || r.booking?.title || '';
}

/** «Корт 2 · 14.09 18:00 · Ранкова йога» — до якої броні належить операція. */
function bookingText(r: LedgerCsvRow, tz: string): string {
  const b = r.booking;
  if (!b) return '';
  const when = DateTime.fromJSDate(b.startTime).setZone(tz).toFormat('dd.MM HH:mm');
  return [b.court?.name, when, b.title].filter(Boolean).join(' · ');
}

/**
 * Журнал у CSV: UTF-8 з BOM і `;` — так само, як решта вивантажень кабінету.
 * Повернення йдуть зі знаком «−»: у файлі сума має сходитись із підсумком
 * екрана без ручної арифметики.
 */
export function ledgerCsv(rows: LedgerCsvRow[], timezone: string): string {
  const head = ['Дата', 'Час', 'Тип', 'Спосіб', 'Рахунок', 'Сума грн', 'Клієнт', 'Бронь/корт', 'Нотатка', 'Хто провів', 'Роль'];
  const body = rows.map((r) => {
    const at = DateTime.fromJSDate(r.createdAt).setZone(timezone);
    const method = CASH_METHODS.includes(r.method as CashMethod) ? METHOD_LABEL[r.method as CashMethod] : r.method;
    return [
      at.toFormat('dd.MM.yyyy'),
      at.toFormat('HH:mm'),
      KIND_LABEL[r.kind] ?? r.kind,
      method,
      r.account,
      grn(r.kind === 'REFUND' ? -r.amount : r.amount),
      ledgerCustomer(r),
      bookingText(r, timezone),
      r.note,
      r.actorEmail,
      ROLE_LABEL[r.actorRole] ?? r.actorRole,
    ];
  });
  /* BOM: без нього Excel читає кирилицю системною кодовою сторінкою. */
  return BOM + [head, ...body].map((row) => row.map((cell, k) => (k === MONEY_COLUMN ? moneyCell(cell) : csvCell(cell))).join(SEP)).join('\r\n');
}

/** Назва файла: клуб і період — щоб кілька вивантажень не злиплися. */
export function ledgerFileName(clubName: string, from: string, to: string): string {
  const slug = clubName.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `каса-${[slug, from, to].filter(Boolean).join('-')}.csv`;
}

/**
 * Що читаємо про кожну операцію для екрана й файла. Той самий набір, що в
 * «поточній зміні» (routes/admin/shift.ts), плюс картка клієнта й посилання
 * на оригінал повернення — щоб «повернення від 12.09 14:30» не шукали руками.
 */
export const LEDGER_ENTRY_SELECT = {
  id: true, kind: true, method: true, amount: true, account: true, note: true,
  actorEmail: true, actorRole: true, createdAt: true, bookingId: true, seatId: true,
  booking: { select: { customerName: true, title: true, startTime: true, court: { select: { name: true } } } },
  seat: { select: { customerName: true } },
  customer: { select: { name: true, phone: true } },
  original: { select: { id: true, createdAt: true } },
} as const;
