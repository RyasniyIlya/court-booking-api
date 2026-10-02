import { DateTime } from 'luxon';

import { prisma } from './db';
import { barChart } from './charts';
import { header, hrn, kopShort, periodBounds, periodSub } from './digest';
import { BOOKINGS, count, SESSIONS } from './plural';
import { telegramHtml } from './telegramHtml';

/**
 * Два розділи бота поверх тих самих броней: хто заробив і звідки гроші.
 *
 * Окремо від digest.ts навмисно. Там — «як минув день» і «як минув
 * тиждень», тобто рух у часі. Тут інше питання: не КОЛИ прийшли гроші, а
 * ВІД КОГО і ЗА ЩО, і час у ньому лише рамка.
 *
 * Числа рахуються так само, як у зведеннях: тільки CONFIRMED і тільки
 * priceTotal. Друга правда про виручку в тому самому боті гірша за
 * відсутність розділу — власник побачив би два різні числа за той самий
 * тиждень і перестав би вірити обом.
 */

/* ── Персонал ────────────────────────────────────────────────────────── */

export type TrainerRow = { name: string; sessions: number; revenue: number };

export type StaffReport = {
  rows: TrainerRow[];
  sessions: number;
  revenue: number;
};

/**
 * Скільки кожен тренер провів занять і скільки це принесло.
 *
 * Гроші тренера — trainerPrice, а не priceTotal: у ціні заняття лежить ще
 * й корт, і записати всю суму на тренера означало б показати власнику
 * зарплатню, якої той не платив.
 */
export async function staffReport(
  clubId: string,
  timezone: string,
  days = 7,
  now?: DateTime,
): Promise<StaffReport> {
  const { from, to } = periodBounds(days, timezone, now);

  const bookings = await prisma.booking.findMany({
    where: {
      clubId,
      status: 'CONFIRMED',
      trainerId: { not: null },
      startTime: { gte: from, lte: to },
    },
    select: { trainerId: true, trainerPrice: true, trainer: { select: { name: true } } },
  });

  const byTrainer = new Map<string, TrainerRow>();
  let sessions = 0;
  let revenue = 0;

  for (const b of bookings) {
    const id = b.trainerId!;
    /* Імʼя беремо звʼязком, а не другим запитом: воно вже приїхало.
       Звільнений тренер лишається в історії з SetNull на картці, тому
       підпис «—» тут не теорія. */
    const row = byTrainer.get(id) ?? { name: b.trainer?.name ?? '—', sessions: 0, revenue: 0 };
    row.sessions += 1;
    row.revenue += b.trainerPrice;
    byTrainer.set(id, row);

    sessions += 1;
    revenue += b.trainerPrice;
  }

  const rows = [...byTrainer.values()].sort((a, b) => b.revenue - a.revenue);

  return { rows, sessions, revenue };
}

export function staffText(clubName: string, r: StaffReport, days: number, timezone: string): string {
  const head = header(clubName, `тренери · ${periodSub(days, timezone)}`);

  if (r.rows.length === 0) {
    return `${head}\n\nЗа цей час занять із тренером не було.`;
  }

  const chart = barChart(
    r.rows.map((t) => ({ label: t.name, value: t.revenue })),
    { format: kopShort },
  );

  /* Найзавантаженіший — не завжди той, хто вгорі: графік упорядкований за
     грошима, а занять більше може бути в дешевшого тренера. Саме тому
     рядок написаний окремо, а не читається з першого стовпчика. */
  const busiest = r.rows.reduce((a, b) => (b.sessions > a.sessions ? b : a), r.rows[0]);

  return [
    head,
    '',
    `<pre>${telegramHtml(chart)}</pre>`,
    `Разом <b>${hrn(r.revenue)}</b> · ${count(r.sessions, SESSIONS)}`,
    /* Імʼя лишається в називному відмінку: «у Іван» різало б око, а
       відмінювати імена бот не вміє й не має — на прізвищах і жіночих
       іменах будь-яке правило рано чи пізно помиляється. */
    r.rows.length > 1
      ? `Найбільше занять: ${telegramHtml(busiest.name)} — ${count(busiest.sessions, SESSIONS)}`
      : '',
  ].filter(Boolean).join('\n');
}

/* ── Виручка ─────────────────────────────────────────────────────────── */

export type RevenueBreakdown = {
  total: number;
  bookings: number;
  byCourt: { name: string; revenue: number }[];
  /** Частка, що є роботою тренерів */
  trainerPart: number;
  /** Групові заняття: скільки їх і на яку суму */
  group: { bookings: number; revenue: number };
};

/**
 * Звідки взялися гроші за період.
 *
 * Три різні розрізи однієї суми, а не три різні суми: по кортах, оренда
 * проти роботи тренерів, приватні проти групових. Тому все рахується з
 * одного запиту — інакше розрізи почали б розходитись між собою.
 */
export async function revenueBreakdown(
  clubId: string,
  timezone: string,
  days = 7,
  now?: DateTime,
): Promise<RevenueBreakdown> {
  const { from, to } = periodBounds(days, timezone, now);

  const bookings = await prisma.booking.findMany({
    where: {
      clubId,
      status: 'CONFIRMED',
      startTime: { gte: from, lte: to },
    },
    select: {
      priceTotal: true,
      trainerPrice: true,
      capacity: true,
      court: { select: { name: true } },
    },
  });

  const perCourt = new Map<string, number>();
  let total = 0;
  let trainerPart = 0;
  const group = { bookings: 0, revenue: 0 };

  for (const b of bookings) {
    total += b.priceTotal;
    trainerPart += b.trainerPrice;

    const name = b.court?.name;
    if (name) perCourt.set(name, (perCourt.get(name) ?? 0) + b.priceTotal);

    /* capacity != null — контейнер групового заняття. Ознака саме така, а
       не окремий прапорець: так її визначає й сама схема. */
    if (b.capacity !== null) {
      group.bookings += 1;
      group.revenue += b.priceTotal;
    }
  }

  const byCourt = [...perCourt.entries()]
    .map(([name, revenue]) => ({ name, revenue }))
    .sort((a, b) => b.revenue - a.revenue);

  return { total, bookings: bookings.length, byCourt, trainerPart, group };
}

/** «8 269 грн (22%)» — частка без відсотка нічого не каже про масштаб */
const share = (part: number, total: number) =>
  `${hrn(part)} <i>(${total > 0 ? Math.round((part / total) * 100) : 0}%)</i>`;

export function revenueText(
  clubName: string,
  r: RevenueBreakdown,
  days: number,
  timezone: string,
): string {
  const head = header(clubName, `звідки гроші · ${periodSub(days, timezone)}`);

  if (r.bookings === 0) {
    return `${head}\n\nПідтверджених броней за цей час не було.`;
  }

  const chart = barChart(
    r.byCourt.map((c) => ({ label: c.name, value: c.revenue })),
    { format: kopShort },
  );

  /* Оренда — це решта після роботи тренерів, а не окреме поле в базі.
     Рахуємо відніманням, щоб дві частки завжди складались у ціле. */
  const courtsPart = r.total - r.trainerPart;

  return [
    head,
    '',
    `<pre>${telegramHtml(chart)}</pre>`,
    `💰 Разом <b>${hrn(r.total)}</b> · ${count(r.bookings, BOOKINGS)}`,
    `🎾 Оренда кортів ${share(courtsPart, r.total)}`,
    r.trainerPart > 0 ? `🧑‍🏫 Робота тренерів ${share(r.trainerPart, r.total)}` : '',
    /* «З них» — бо це інший розріз тієї самої суми, а не третій шматок
       поруч із орендою і тренерами: ті двоє складаються в 100%, групові
       ж перетинаються з обома.

       Порожнє заняття, на яке ніхто не записався, сюди не потрапляє:
       рядок «0 грн (0%)» у розділі про гроші — шум, а не інформація. */
    r.group.revenue > 0
      ? `👥 З них групові ${share(r.group.revenue, r.total)} · ${count(r.group.bookings, SESSIONS)}`
      : '',
  ].filter(Boolean).join('\n');
}
