import { DateTime } from 'luxon';
import type { CellValue, SheetSpec } from './xlsx';

/**
 * Касова книга — гроші, що фактично прийшли й пішли.
 *
 * ── Чому окремо від «виручки» в аналітиці ────────────────────────────────
 *
 * Виручка в звітах — це нарахування: скільки коштували броні, зіграні в
 * періоді. Власнику це правильна цифра («скільки наробили»), бухгалтеру —
 * ні. ФОП на єдиному податку платить з грошей, що надійшли, у день
 * надходження: абонемент, куплений у травні, — травневий дохід, хоч
 * відіграють його в червні; повернення зменшує дохід того місяця, коли
 * гроші повернули. Тому тут інша лінійка — дата руху грошей.
 *
 * ── Звідки рядки ─────────────────────────────────────────────────────────
 *
 *  - журнал розрахунків (BookingLedgerEntry): готівка, термінал, переказ,
 *    бонуси, внесені на ресепшені, і повернення ними ж;
 *  - онлайн-оплати (Payment): надходження в день paidAt, повернення — у
 *    день refundedAt, коли про нього сказав вебхук, а не коли попросили;
 *  - продані абонементи (Pass.price) — у день видачі, зі способом оплати,
 *    записаним на ресепшені. Старі, виданi до цього, — «не вказано».
 *
 * Бонуси показуються, але в гроші й податок не входять: бонус — це знижка
 * клубу власним коштом, а не надходження.
 */

export type CashMethod = 'CASH' | 'CARD' | 'TRANSFER' | 'ONLINE' | 'BONUS' | 'UNSPECIFIED';
export type CashSource = 'BOOKING' | 'SEAT' | 'PASS';

export const CASH_METHODS: CashMethod[] = ['CASH', 'CARD', 'TRANSFER', 'ONLINE', 'BONUS', 'UNSPECIFIED'];

export const METHOD_LABEL: Record<CashMethod, string> = {
  CASH: 'Готівка',
  CARD: 'Термінал',
  TRANSFER: 'Переказ',
  ONLINE: 'Онлайн',
  BONUS: 'Бонуси',
  UNSPECIFIED: 'Не вказано',
};

const SOURCE_LABEL: Record<CashSource, string> = {
  BOOKING: 'Бронь',
  SEAT: 'Місце в групі',
  PASS: 'Абонемент',
};

export type CashRow = {
  id: string;
  at: Date;
  kind: 'PAYMENT' | 'REFUND';
  method: CashMethod;
  account: string;
  /** Копійки, завжди додатні. Знак дає kind. */
  amount: number;
  source: CashSource;
  customer: string | null;
  description: string;
  actor: string | null;
};

const signedAmount = (r: Pick<CashRow, 'kind' | 'amount'>) => (r.kind === 'REFUND' ? -r.amount : r.amount);
const isMoney = (m: CashMethod) => m !== 'BONUS';

/* ── Збирання рядків ───────────────────────────────────────────────────── */

export type LedgerInput = {
  id: string;
  createdAt: Date;
  kind: string;
  method: string;
  amount: number;
  account: string;
  note: string;
  actorEmail: string;
  seatId: string | null;
  booking: { customerName: string | null; title: string | null; startTime: Date; court: { name: string } | null } | null;
  seat: { customerName: string } | null;
};

export function ledgerRows(entries: LedgerInput[], tz: string): CashRow[] {
  return entries.map((e) => {
    const when = e.booking ? DateTime.fromJSDate(e.booking.startTime).setZone(tz).toFormat('dd.MM HH:mm') : '';
    const what = [e.booking?.title || e.booking?.court?.name, when].filter(Boolean).join(', ');
    return {
      id: e.id,
      at: e.createdAt,
      kind: e.kind === 'REFUND' ? 'REFUND' : 'PAYMENT',
      method: (CASH_METHODS.includes(e.method as CashMethod) ? e.method : 'UNSPECIFIED') as CashMethod,
      account: e.account,
      amount: e.amount,
      source: e.seatId ? 'SEAT' : 'BOOKING',
      customer: e.seat?.customerName ?? e.booking?.customerName ?? null,
      description: [what, e.note].filter(Boolean).join(' · '),
      actor: e.actorEmail,
    };
  });
}

export type OnlineInput = {
  id: string;
  amount: number;
  status: string;
  provider: string;
  paidAt: Date | null;
  refundedAt: Date | null;
  seatId: string | null;
  booking: { customerName: string | null; title: string | null; startTime: Date; court: { name: string } | null } | null;
  seat: { customerName: string; booking: { title: string | null; startTime: Date } } | null;
};

/**
 * Онлайн-оплата дає до двох рядків: надходження й повернення, кожне у свій
 * день. Обидва лише якщо потрапляють у період — інакше квітнева оплата,
 * повернена в травні, у травневому звіті зʼявилась би двічі.
 */
export function onlineRows(payments: OnlineInput[], from: Date, to: Date, tz: string): CashRow[] {
  const inRange = (d: Date | null): d is Date => !!d && d >= from && d <= to;
  const rows: CashRow[] = [];

  for (const p of payments) {
    const start = p.booking?.startTime ?? p.seat?.booking.startTime;
    const title = p.booking?.title || p.booking?.court?.name || p.seat?.booking.title || '';
    const when = start ? DateTime.fromJSDate(start).setZone(tz).toFormat('dd.MM HH:mm') : '';
    const base = {
      method: 'ONLINE' as const,
      account: p.provider === 'mono' ? 'monobank' : p.provider,
      amount: p.amount,
      source: (p.seatId ? 'SEAT' : 'BOOKING') as CashSource,
      customer: p.seat?.customerName ?? p.booking?.customerName ?? null,
      description: [title, when].filter(Boolean).join(', '),
      actor: null,
    };
    /* REFUNDED теж колись був PAID — надходження лишається в тому дні. */
    if ((p.status === 'PAID' || p.status === 'REFUNDED') && inRange(p.paidAt)) {
      rows.push({ ...base, id: `${p.id}:in`, at: p.paidAt, kind: 'PAYMENT' });
    }
    if (p.status === 'REFUNDED' && inRange(p.refundedAt)) {
      rows.push({ ...base, id: `${p.id}:out`, at: p.refundedAt, kind: 'REFUND' });
    }
  }
  return rows;
}

export type PassInput = {
  id: string;
  createdAt: Date;
  price: number;
  type: string;
  totalSessions: number | null;
  customer: { name: string | null } | null;
  /** Записується з 2026-09: старі абонементи лишаються «не вказано». */
  payMethod?: string | null;
  payAccount?: string;
};

export function passRows(passes: PassInput[]): CashRow[] {
  return passes
    .filter((p) => p.price > 0)
    .map((p) => ({
      id: `pass:${p.id}`,
      at: p.createdAt,
      kind: 'PAYMENT' as const,
      method: (p.payMethod && CASH_METHODS.includes(p.payMethod as CashMethod) ? p.payMethod : 'UNSPECIFIED') as CashMethod,
      account: p.payAccount ?? '',
      amount: p.price,
      source: 'PASS' as const,
      customer: p.customer?.name ?? null,
      description: p.type === 'UNLIMITED' ? 'Безліміт' : `${p.totalSessions ?? ''} занять`.trim(),
      actor: null,
    }));
}

/* ── Підсумки ──────────────────────────────────────────────────────────── */

export type MethodTotal = { method: CashMethod; received: number; refunded: number; net: number; count: number };

export type CashSummary = {
  /** Гроші (без бонусів): надійшло, повернено, різниця. Це і є дохід ФОП. */
  received: number;
  refunded: number;
  net: number;
  /** Бонусами оплачено мінус повернуто бонусами — окремо, для довідки. */
  bonusNet: number;
  byMethod: MethodTotal[];
  byAccount: { method: CashMethod; account: string; net: number; count: number }[];
  bySource: { source: CashSource; net: number }[];
  /** Кожен день періоду, навіть порожній: порожній день — теж відповідь. */
  byDay: { date: string; net: number }[];
  count: number;
};

export function summarize(rows: CashRow[], tz: string, from: Date, to: Date): CashSummary {
  const methods = new Map<CashMethod, MethodTotal>();
  const accounts = new Map<string, { method: CashMethod; account: string; net: number; count: number }>();
  const sources = new Map<CashSource, number>();
  const days = new Map<string, number>();

  for (let d = DateTime.fromJSDate(from).setZone(tz).startOf('day'); d.toJSDate() <= to; d = d.plus({ days: 1 })) {
    days.set(d.toFormat('yyyy-MM-dd'), 0);
  }

  let received = 0;
  let refunded = 0;
  let bonusNet = 0;

  for (const r of rows) {
    const s = signedAmount(r);
    const m = methods.get(r.method) ?? { method: r.method, received: 0, refunded: 0, net: 0, count: 0 };
    if (r.kind === 'REFUND') m.refunded += r.amount; else m.received += r.amount;
    m.net += s;
    m.count += 1;
    methods.set(r.method, m);

    const key = `${r.method}:${r.account}`;
    const a = accounts.get(key) ?? { method: r.method, account: r.account, net: 0, count: 0 };
    a.net += s;
    a.count += 1;
    accounts.set(key, a);

    if (!isMoney(r.method)) {
      bonusNet += s;
      continue;
    }
    if (r.kind === 'REFUND') refunded += r.amount; else received += r.amount;
    sources.set(r.source, (sources.get(r.source) ?? 0) + s);
    const day = DateTime.fromJSDate(r.at).setZone(tz).toFormat('yyyy-MM-dd');
    if (days.has(day)) days.set(day, days.get(day)! + s);
  }

  return {
    received,
    refunded,
    net: received - refunded,
    bonusNet,
    byMethod: CASH_METHODS.map((m) => methods.get(m)).filter((m): m is MethodTotal => !!m),
    byAccount: [...accounts.values()].sort((a, b) => b.net - a.net),
    bySource: [...sources.entries()].map(([source, net]) => ({ source, net })),
    byDay: [...days.entries()].map(([date, net]) => ({ date, net })),
    count: rows.length,
  };
}

/* ── Податок ФОП ───────────────────────────────────────────────────────── */

/**
 * Річний ліміт доходу ФОП 3 групи, копійки: 1167 мінімальних зарплат на
 * 1 січня року. Рік, якого тут немає, — ліміту не показуємо зовсім, а не
 * підставляємо минулорічний: застарілий ліміт гірший за відсутній.
 */
export const FOP3_LIMIT: Record<number, number> = {
  2026: 1_009_104_900,
};

/** Ставки 3 групи без ПДВ. Оцінка, а не декларація — так і підписано в кабінеті. */
export const FOP3_RATES = { singleTax: 0.05, military: 0.01 };

export function taxEstimate(netIncome: number) {
  const base = Math.max(0, netIncome);
  const singleTax = Math.round(base * FOP3_RATES.singleTax);
  const military = Math.round(base * FOP3_RATES.military);
  return { base, singleTax, military, total: singleTax + military };
}

export function limitUsage(yearIncome: number, year: number) {
  const limit = FOP3_LIMIT[year];
  if (!limit) return null;
  return {
    year,
    limit,
    used: Math.max(0, yearIncome),
    pct: Math.round((Math.max(0, yearIncome) / limit) * 1000) / 10,
  };
}

/* ── Вивантаження для бухгалтера ───────────────────────────────────────── */

export type CashbookMeta = { clubName: string; timezone: string; from: Date; to: Date; now: Date };

const grn = (kop: number) => Math.round(kop) / 100;

export function cashbookFileName(meta: CashbookMeta) {
  const f = (d: Date) => DateTime.fromJSDate(d).setZone(meta.timezone).toFormat('yyyy-MM-dd');
  return `Каса ${meta.clubName} ${f(meta.from)}—${f(meta.to)}.xlsx`;
}

/**
 * Три вкладки: реєстр операцій (для книги обліку доходів), підсумок по днях
 * і розбивка по касах. Суми — числами в гривнях, щоб Excel їх сумував.
 */
export function cashbookSheets(rows: CashRow[], summary: CashSummary, meta: CashbookMeta): SheetSpec[] {
  const tzDate = (d: Date) => DateTime.fromJSDate(d).setZone(meta.timezone);
  /* Excel не знає таймзон: віддаємо «настінний» час клубу як локальну дату. */
  const local = (d: Date) => {
    const z = tzDate(d);
    return new Date(Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second));
  };

  const register: CellValue[][] = [...rows]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((r) => [
      local(r.at),
      r.kind === 'REFUND' ? 'Повернення' : 'Надходження',
      METHOD_LABEL[r.method],
      r.account,
      grn(signedAmount(r)),
      isMoney(r.method) ? 'так' : 'ні',
      SOURCE_LABEL[r.source],
      r.customer ?? '',
      r.description,
      r.actor ?? '',
    ]);

  const days: CellValue[][] = summary.byDay.map((d) => [d.date, grn(d.net)]);
  days.push(['Разом', grn(summary.net)]);

  const accounts: CellValue[][] = summary.byAccount.map((a) => [
    METHOD_LABEL[a.method], a.account, a.count, grn(a.net),
  ]);

  return [
    {
      name: 'Реєстр',
      headers: ['Дата', 'Операція', 'Спосіб', 'Каса / рахунок', 'Сума, грн', 'Дохід ФОП', 'За що', 'Клієнт', 'Опис', 'Хто вніс'],
      rows: register,
      widths: [18, 14, 12, 20, 12, 10, 14, 24, 40, 26],
    },
    {
      name: 'По днях',
      headers: ['День', 'Грошей за день, грн'],
      rows: days,
      widths: [14, 20],
    },
    {
      name: 'По касах',
      headers: ['Спосіб', 'Каса / рахунок', 'Операцій', 'Разом, грн'],
      rows: accounts,
      widths: [14, 24, 10, 14],
    },
  ];
}

/* ── Боржники ──────────────────────────────────────────────────────────── */

export type DebtInput = {
  kind: 'BOOKING' | 'SEAT';
  id: string;
  bookingId: string;
  startTime: Date;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  title: string;
  price: number;
  ledger: { kind: string; amount: number }[];
  onlinePaid: number;
};

export type Debt = Omit<DebtInput, 'ledger' | 'onlinePaid'> & { paid: number; due: number };

/** Зіграно, а сплачено менше за ціну. Переплату боргом не рахуємо. */
export function findDebts(items: DebtInput[]): Debt[] {
  const out: Debt[] = [];
  for (const { ledger, onlinePaid, ...rest } of items) {
    const paid = ledger.reduce((s, e) => s + (e.kind === 'REFUND' ? -e.amount : e.amount), 0) + onlinePaid;
    const due = rest.price - paid;
    if (due > 0) out.push({ ...rest, paid, due });
  }
  return out.sort((a, b) => b.due - a.due || a.startTime.getTime() - b.startTime.getTime());
}

/** Згортає борги по людині: на дзвінок іде одна людина, а не шість броней. */
export function groupDebtors(debts: Debt[]) {
  const map = new Map<string, { key: string; customerId: string | null; name: string; phone: string | null; due: number; items: Debt[] }>();
  for (const d of debts) {
    const key = d.customerId ?? d.customerPhone ?? `anon:${d.id}`;
    const row = map.get(key) ?? {
      key, customerId: d.customerId, name: d.customerName || 'Без імені', phone: d.customerPhone, due: 0, items: [],
    };
    row.due += d.due;
    row.items.push(d);
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.due - a.due);
}
