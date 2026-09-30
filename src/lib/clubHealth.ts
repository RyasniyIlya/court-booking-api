import { clubBilling } from './billing';

/**
 * Здоровʼя клубу для панелі оператора: одне число 0..100 і кілька слів,
 * ЧОМУ воно таке. Число потрібне, щоб відсортувати сотню клубів і побачити,
 * кому дзвонити першим; слова — щоб дзвінок був про справу («у вас три тижні
 * не було броней»), а не «як справи».
 *
 * Це евристика для черги дзвінків, а не оцінка клубу. Тому чиста функція без
 * бази: метрики приходять готові (lib/platformMetrics.ts), а вагу кожної
 * частини видно й міняється тут, в одному місці.
 *
 * Ваги: використання 40, впровадження 25, оплата 20, залученість 15.
 */

const DAY_MS = 86_400_000;

/** Скільки днів клуб вважається новим: ще налаштовується, а не «не користується» */
export const ONBOARDING_DAYS = 14;

/** Мінімум балів використання для нового клубу — половина ваги (не карати за старт) */
const ONBOARDING_USAGE_FLOOR = 20;

export type ClubHealthInput = {
  isActive: boolean;
  createdAt: Date;
  paidUntil: Date | null;
  trialEndsAt: Date | null;
  bookings30: number;
  bookingsPrev30: number;
  /** 0..1, null — броней немає */
  onlineShare30: number | null;
  lastBookingAt: Date | null;
  lastStaffActivityAt: Date | null;
  tgLinked: boolean;
  features: {
    onlinePayments: boolean;
    passes: boolean;
    trainers: boolean;
    promos: boolean;
    groups: boolean;
  };
};

export type ClubHealth = {
  score: number;
  tone: 'ok' | 'warn' | 'bad';
  reasons: string[];
};

/** Повних діб між двома моментами; майбутнє дає 0 */
function daysSince(date: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS));
}

/** ≤3 доби — повністю, ≤7 — 2/3, ≤14 — 1/3, далі нуль */
function recencyFactor(days: number): number {
  if (days <= 3) return 1;
  if (days <= 7) return 2 / 3;
  if (days <= 14) return 1 / 3;
  return 0;
}

/**
 * Динаміка броней до попередніх 30 днів. Падіння менш ніж на 10% — норма
 * (сезонність, погода), нижче 40% від минулого — повний нуль, між ними лінія.
 */
function trendFactor(current: number, previous: number): number {
  if (previous <= 0) return current > 0 ? 1 : 0;
  const ratio = current / previous;
  if (ratio >= 0.9) return 1;
  if (ratio <= 0.4) return 0;
  return (ratio - 0.4) / 0.5;
}

export function clubHealth(input: ClubHealthInput, now: Date = new Date()): ClubHealth {
  const reasons: string[] = [];

  const ageDays = daysSince(input.createdAt, now);
  const onboarding = ageDays < ONBOARDING_DAYS;

  /* ── Використання, 40: свіжість останньої броні (25) + динаміка (15) ───── */
  const lastBookingDays = input.lastBookingAt ? daysSince(input.lastBookingAt, now) : null;
  const recency = lastBookingDays === null ? 0 : recencyFactor(lastBookingDays);
  const trend = trendFactor(input.bookings30, input.bookingsPrev30);
  let usage = 25 * recency + 15 * trend;

  /* Новий клуб ще вносить корти й ціни: порожній календар у перший тиждень —
     норма, а не ознака відтоку. Стеля знизу — половина ваги. */
  if (onboarding) usage = Math.max(usage, ONBOARDING_USAGE_FLOOR);

  /* ── Впровадження, 25: онлайн-частка 9, Telegram 5, оплата 3, ширина 8 ── */
  const share = input.onlineShare30 ?? 0;
  const f = input.features;
  const breadth = [f.trainers, f.passes, f.promos, f.groups].filter(Boolean).length;
  const adoption =
    9 * Math.min(1, share / 0.5) +
    (input.tgLinked ? 5 : 0) +
    (f.onlinePayments ? 3 : 0) +
    2 * breadth;

  /* ── Оплата, 20 ───────────────────────────────────────────────────────── */
  const billing = clubBilling(
    { paidUntil: input.paidUntil, trialEndsAt: input.trialEndsAt, isActive: input.isActive },
    now,
  );
  let billingScore: number;
  if (billing.state === 'blocked') billingScore = 0;
  else if (billing.state === 'grace') billingScore = 5;
  else if (billing.until === null) billingScore = 10; // ні оплати, ні пробного
  else if (billing.trial) billingScore = 15;
  else billingScore = billing.state === 'due' ? 15 : 20;

  /* ── Залученість, 15: коли востаннє хтось із персоналу щось правив ────── */
  const staffDays = input.lastStaffActivityAt ? daysSince(input.lastStaffActivityAt, now) : null;
  let engagement = 0;
  if (staffDays !== null) {
    if (staffDays <= 3) engagement = 15;
    else if (staffDays <= 7) engagement = 10;
    else if (staffDays <= 10) engagement = 5;
  }

  const score = Math.max(0, Math.min(100, Math.round(usage + adoption + billingScore + engagement)));

  /* ── Причини: тільки те, що справді тягне вниз, і зрозумілою мовою ─────── */
  if (!input.isActive) reasons.push('вимкнено');
  if (onboarding) reasons.push('онбординг');

  if (input.isActive) {
    if (billing.state === 'grace' || billing.state === 'blocked') {
      reasons.push('оплата прострочена');
    } else if (billing.state === 'due' && billing.daysLeft !== null) {
      reasons.push(
        billing.trial
          ? `пробний закінчується через ${billing.daysLeft} дн.`
          : `оплата закінчується через ${billing.daysLeft} дн.`,
      );
    }
  }

  if (!onboarding) {
    if (lastBookingDays === null) reasons.push('броней ще не було');
    else if (lastBookingDays >= 14) reasons.push('немає броней 14+ днів');

    if (input.bookingsPrev30 >= 5 && input.bookings30 < input.bookingsPrev30 * 0.9) {
      const drop = Math.round((1 - input.bookings30 / input.bookingsPrev30) * 100);
      if (drop >= 20) reasons.push(`броней на ${drop}% менше, ніж місяць тому`);
    }

    if (input.onlineShare30 !== null && input.onlineShare30 < 0.1 && input.bookings30 >= 5) {
      reasons.push('онлайн-запис майже не використовують');
    }

    if (staffDays === null) reasons.push('адміністратор ще не заходив');
    else if (staffDays >= 10) reasons.push('адміністратор не заходив 10+ днів');
  }

  const tone: ClubHealth['tone'] = score >= 70 ? 'ok' : score >= 40 ? 'warn' : 'bad';

  /* Вимкнений клуб — не «здоровий, але тихий»: тон червоний незалежно від
     балів, а бал не вищий за межу «bad», щоб сортування не суперечило тону. */
  if (!input.isActive) return { score: Math.min(score, 39), tone: 'bad', reasons };

  return { score, tone, reasons };
}
