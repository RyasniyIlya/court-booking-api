import { DateTime } from 'luxon';
import type { CashRow } from './cashbook';

/**
 * Фінансові звіти поверх каси: що клуб ще винен абонементами, скільки
 * заробили тренери, прибуток по місяцях і скільки годин треба продати,
 * щоб вийти в нуль.
 *
 * Тут лише чисті функції — запити до бази живуть у routes/finance.ts.
 */

const DAY = 86_400_000;

/* ── Невідіграні абонементи ────────────────────────────────────────────── */

export type PassLike = {
  id: string;
  type: string;
  totalSessions: number | null;
  usedSessions: number;
  validFrom: Date;
  validUntil: Date;
  price: number;
  revokedAt: Date | null;
  customer: { id: string; name: string | null; phone: string | null } | null;
};

/**
 * Скільки з ціни абонемента ще не відпрацьовано.
 *
 * Пакет — пропорційно невикористаним заняттям: 8 занять за 2 400 грн,
 * використано 3 — клуб «винен» 5 × 300 = 1 500 грн. Безліміт — пропорційно
 * часу, що лишився: інакше його вартість не зменшувалась би ніколи.
 */
export function unearned(p: PassLike, now: Date): { value: number; left: number | null } {
  if (p.price <= 0 || p.revokedAt || p.validUntil <= now) return { value: 0, left: 0 };

  if (p.type === 'PACKAGE' && p.totalSessions) {
    const left = Math.max(0, p.totalSessions - p.usedSessions);
    return { value: Math.round((p.price * left) / p.totalSessions), left };
  }

  const span = p.validUntil.getTime() - p.validFrom.getTime();
  if (span <= 0) return { value: 0, left: null };
  const from = Math.max(now.getTime(), p.validFrom.getTime());
  const frac = Math.min(1, Math.max(0, (p.validUntil.getTime() - from) / span));
  return { value: Math.round(p.price * frac), left: null };
}

export function passLiability(passes: PassLike[], now: Date, soonDays = 14) {
  let total = 0;
  let sessionsLeft = 0;
  let count = 0;
  const soon: {
    passId: string; customerId: string | null; name: string; phone: string | null;
    left: number | null; daysLeft: number; value: number;
  }[] = [];

  /* «Згоріло» — пакети, що скінчились за останні 30 днів із невикористаними
     заняттями. Гроші клуб отримав, послугу не надав: для бухгалтера це вже
     дохід, для власника — привід подзвонити й продати наступний. */
  const burnedFrom = new Date(now.getTime() - 30 * DAY);
  let burned = 0;
  let burnedCount = 0;

  for (const p of passes) {
    if (p.revokedAt || p.price <= 0) continue;

    if (p.validUntil <= now) {
      if (p.validUntil > burnedFrom && p.type === 'PACKAGE' && p.totalSessions) {
        const left = p.totalSessions - p.usedSessions;
        if (left > 0) {
          burned += Math.round((p.price * left) / p.totalSessions);
          burnedCount += 1;
        }
      }
      continue;
    }

    const u = unearned(p, now);
    if (u.value <= 0) continue;
    total += u.value;
    count += 1;
    if (u.left) sessionsLeft += u.left;

    const daysLeft = Math.ceil((p.validUntil.getTime() - now.getTime()) / DAY);
    if (daysLeft <= soonDays && (u.left === null || u.left > 0)) {
      soon.push({
        passId: p.id,
        customerId: p.customer?.id ?? null,
        name: p.customer?.name || 'Без імені',
        phone: p.customer?.phone ?? null,
        left: u.left,
        daysLeft,
        value: u.value,
      });
    }
  }

  soon.sort((a, b) => a.daysLeft - b.daysLeft || b.value - a.value);
  return { total, count, sessionsLeft, expiringSoon: soon, burned30: { value: burned, count: burnedCount } };
}

/* ── Тренери ───────────────────────────────────────────────────────────── */

export type TrainerSession = {
  trainerId: string;
  trainerName: string;
  pricePerHour: number;
  trainerPrice: number;
  startTime: Date;
  endTime: Date;
  attendance: string;
};

/**
 * Нараховано тренерам за період.
 *
 * Основа — trainerPrice, зафіксований у броні на момент запису: ставку
 * тренера можуть змінити, а заплатити треба за ту, що діяла. Ставку з
 * картки показуємо поруч як довідку — якщо суми розходяться, частина
 * занять записана без тренерської ціни, і це видно одразу.
 */
export function trainerPayouts(sessions: TrainerSession[]) {
  const map = new Map<string, {
    trainerId: string; name: string; sessions: number; hours: number;
    amount: number; byRate: number; noShows: number; unpriced: number;
  }>();

  for (const s of sessions) {
    const hours = Math.max(0, (s.endTime.getTime() - s.startTime.getTime()) / 3_600_000);
    const row = map.get(s.trainerId) ?? {
      trainerId: s.trainerId, name: s.trainerName, sessions: 0, hours: 0,
      amount: 0, byRate: 0, noShows: 0, unpriced: 0,
    };
    row.sessions += 1;
    row.hours += hours;
    row.amount += s.trainerPrice;
    row.byRate += Math.round(hours * s.pricePerHour);
    if (s.attendance === 'NO_SHOW') row.noShows += 1;
    if (s.trainerPrice <= 0) row.unpriced += 1;
    map.set(s.trainerId, row);
  }

  const rows = [...map.values()]
    .map((r) => ({ ...r, hours: Math.round(r.hours * 10) / 10 }))
    .sort((a, b) => b.amount - a.amount);
  return { rows, total: rows.reduce((s, r) => s + r.amount, 0) };
}

/* ── Прибуток по місяцях ───────────────────────────────────────────────── */

export type ExpenseLike = { month: Date; category: string; amount: number };

/**
 * Каса мінус витрати, місяць за місяцем. Каса — а не нарахована виручка:
 * витрати теж рахуються тим, що заплатили, і обидві сторони мають стояти
 * на одній лінійці.
 */
export function monthlyPnl(rows: CashRow[], expenses: ExpenseLike[], months: string[], tz: string) {
  const income = new Map<string, number>(months.map((m) => [m, 0]));
  for (const r of rows) {
    if (r.method === 'BONUS') continue;
    const m = DateTime.fromJSDate(r.at).setZone(tz).toFormat('yyyy-MM');
    if (!income.has(m)) continue;
    income.set(m, income.get(m)! + (r.kind === 'REFUND' ? -r.amount : r.amount));
  }

  const spent = new Map<string, { total: number; byCategory: Record<string, number> }>(
    months.map((m) => [m, { total: 0, byCategory: {} }]),
  );
  for (const e of expenses) {
    /* month — дата без часу (@db.Date), Prisma віддає її як UTC-північ. */
    const m = DateTime.fromJSDate(e.month, { zone: 'utc' }).toFormat('yyyy-MM');
    const row = spent.get(m);
    if (!row) continue;
    row.total += e.amount;
    row.byCategory[e.category] = (row.byCategory[e.category] ?? 0) + e.amount;
  }

  return months.map((month) => {
    const inc = income.get(month)!;
    const exp = spent.get(month)!;
    return {
      month,
      income: inc,
      expenses: exp.total,
      byCategory: exp.byCategory,
      profit: inc - exp.total,
      /* Місяць без жодної витрати — не «прибуток 100%», а незаповнені
         витрати. Кабінет має це сказати, а не хвалити клуб. */
      expensesMissing: exp.total === 0,
    };
  });
}

/**
 * Точка беззбитковості місяця в годинах корту.
 *
 * Витрати місяця ділимо на середню ціну проданої години за останні 90
 * днів. Якщо за поточний місяць витрат ще не внесено — беремо середнє трьох
 * попередніх місяців, де вони є, і прямо це позначаємо.
 */
export function breakEven(args: {
  monthExpenses: number;
  fallbackExpenses: number[];
  soldHours90: number;
  revenue90: number;
  soldHoursMonth: number;
}) {
  const { monthExpenses, fallbackExpenses, soldHours90, revenue90, soldHoursMonth } = args;
  const avgHour = soldHours90 > 0 ? Math.round(revenue90 / soldHours90) : 0;

  let expenses = monthExpenses;
  let estimated = false;
  if (expenses <= 0) {
    const known = fallbackExpenses.filter((x) => x > 0);
    if (known.length) {
      expenses = Math.round(known.reduce((s, x) => s + x, 0) / known.length);
      estimated = true;
    }
  }

  if (expenses <= 0 || avgHour <= 0) {
    return { available: false as const, expenses, avgHour };
  }

  const hoursNeeded = Math.ceil(expenses / avgHour);
  const sold = Math.round(soldHoursMonth * 10) / 10;
  return {
    available: true as const,
    expenses,
    estimated,
    avgHour,
    hoursNeeded,
    hoursSold: sold,
    hoursLeft: Math.max(0, Math.ceil(hoursNeeded - sold)),
    pct: Math.min(100, Math.round((sold / hoursNeeded) * 1000) / 10),
  };
}
