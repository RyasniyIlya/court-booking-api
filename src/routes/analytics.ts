import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { prisma } from '../lib/db';
import { requireAuth, requireRole, requireFeature } from './admin';
import { buildLoadProfile } from '../lib/loadProfile';
import { courtValueOf, loadPassSessionValues } from '../lib/serviceValue';
import { loadClubLoadProfile } from '../lib/clubLoad';
import { accrualTotal, cashNet, loadAccrualBookings, otherBasis, type Basis } from '../lib/pnlBasis';
import { loadCashRows } from './finance';
import { bookingFunnel, retentionFromVisits, roundPct, type FunnelBooking } from '../lib/deepAnalytics';
import { dateOnly, daysUntilBirthday } from '../lib/birthday';
import { recordChanges } from '../lib/changeLog';
import {
  loadRoster,
  rosterCsv,
  rosterFileName,
  rosterWorkbookSheets,
  tierCounts,
  TIER_ACTIVE_DAYS,
  TIER_FADING_DAYS,
  type ExportMeta,
  type RosterRow,
} from '../lib/customerRoster';
import { buildWorkbook, XLSX_CONTENT_TYPE } from '../lib/xlsx';
import {
  loadBookingExport,
  bookingExportCsv,
  bookingExportWorkbookSheets,
  bookingsFileName,
  type BookingExportMeta,
} from '../lib/bookingExport';

/**
 * CRM-аналітика кабінету. Окремий файл, а не ще один розділ
 * у admin.ts (той і так росте з кожною фічею) — увесь модуль про читання
 * даних, жодного запису.
 *
 * OWNER і ADMIN. Тренер — ні: виручка клубу й список найчастіших клієнтів
 * не мають стосунку до його розкладу. Модератор веде клуб щодня і без цифр
 * не веде його взагалі, тому дані тут ті самі, що й у власника.
 * Це той самий перегляд, що список броней, просто звужений за роллю.
 */
export const analyticsRouter = Router();

/*
 * Тут вартовий плану стоїть на ЧИТАННІ, а не на записі — на відміну від
 * тренерів і групових. Причина в природі можливості: аналітика і є перегляд
 * цифр, закривати в ній «створення» нема чого. Тренери ж — керування
 * людьми, там план закриває зміни, а вже заведені картки клуб бачить далі.
 *
 * Пошук клієнта за телефоном на ресепшені сюди НЕ входить: він живе в
 * customersRouter і лишається відкритим на всіх рівнях. Інакше клуб на
 * першому рівні не зміг би прийняти бронь від постійного гравця — це вже
 * не «недоплатив за аналітику», а зламаний основний сценарій.
 */
/*
 * Рішення власника 2026-09-28: модератор зміни бачить лише свою касу, без
 * прибутку, витрат, виплат тренерам і аналітики. Тому для ADMIN відкрито
 * ТІЛЬКИ картку клієнта (список і історія візитів) — це робота ресепшена,
 * а не звіт. Решта — default-deny: новий ендпоінт аналітики закритий для
 * модератора, поки його явно не додано в цей список.
 */
const ADMIN_ALLOWED = [/^\/customers\/?$/, /^\/customers\/[^/]+\/visits\/?$/];
function denyAdminExceptCustomerCards(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.role === 'ADMIN' && !ADMIN_ALLOWED.some((re) => re.test(req.path))) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  next();
}

analyticsRouter.use(requireAuth, requireRole('OWNER', 'ADMIN'), denyAdminExceptCustomerCards, requireFeature('analytics'));

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Період звіту: готовий (тиждень/місяць) або заданий руками.
 *
 * `custom` зʼявився тому, що готових двох не вистачає рівно там, де звіт
 * найпотрібніший: «покажи за час, поки йшла акція», «зведи травневий
 * турнірний тиждень». Дати приходять як YYYY-MM-DD — без часу: години в
 * такому запиті нічого не уточнюють, а плутанину з таймзонами дають.
 */
const periodQuery = z.object({
  period: z.enum(['week', 'month', 'custom']).default('week'),
  from: z.string().regex(DATE_ONLY).optional(),
  to: z.string().regex(DATE_ONLY).optional(),
});

type PeriodQuery = z.infer<typeof periodQuery>;

/**
 * Скільки максимум можна замовити одним запитом.
 *
 * Межа не формальна: без неї «з 2000-01-01 по сьогодні» перетворюється на
 * скан усієї таблиці броней клубу заради одного числа, і кабінет висне на
 * запиті, який ніхто не мав на увазі.
 */
const MAX_CUSTOM_DAYS = 366;

/**
 * Межі періоду в таймзоні клубу, повернуті як UTC-момент для запиту в базу.
 *
 * null означає «такий період прочитати не можна» — викликач віддає 400.
 * Порівняння з попереднім періодом для власного діапазону рахується тією
 * самою тривалістю, що стоїть безпосередньо перед ним: інакше «−12%» було
 * б відсотком від невідомо чого.
 */
export function periodBounds(q: PeriodQuery, tz: string, anchor: DateTime) {
  if (q.period === 'custom') {
    if (!q.from || !q.to) return null;

    const start = DateTime.fromISO(q.from, { zone: tz }).startOf('day');
    const end = DateTime.fromISO(q.to, { zone: tz }).endOf('day');
    if (!start.isValid || !end.isValid || end < start) return null;

    const span = end.toMillis() - start.toMillis();
    if (span > MAX_CUSTOM_DAYS * 86_400_000) return null;

    return {
      current: { start: start.toJSDate(), end: end.toJSDate() },
      previous: {
        start: new Date(start.toMillis() - span - 1),
        end: new Date(start.toMillis() - 1),
      },
    };
  }

  const unit = q.period === 'week' ? 'week' : 'month';
  const currentStart = anchor.setZone(tz).startOf(unit);
  const currentEnd = anchor.setZone(tz).endOf(unit);
  const previousStart = currentStart.minus({ [unit]: 1 } as Record<string, number>);
  const previousEnd = currentEnd.minus({ [unit]: 1 } as Record<string, number>);
  return {
    current: { start: currentStart.toJSDate(), end: currentEnd.toJSDate() },
    previous: { start: previousStart.toJSDate(), end: previousEnd.toJSDate() },
  };
}

/**
 * Візити клубу за період: ті самі два джерела, що в картотеці
 * (`loadRoster`) і в Deep (`retentionFromVisits`).
 *
 * Людина в груповому занятті — це BookingSeat, а не Booking.customerId
 * (у контейнера групи він порожній), тому раніше «різні клієнти» і топ
 * її не бачили. Рішення, як у картотеці: місце зі статусом BOOKED у
 * підтвердженій броні — це один візит на ціну місця (`seat.price`); бронь
 * корту — один візит на `priceTotal`. Дубля однієї людини немає: різних
 * клієнтів рахуємо за Set по customerId, а візити й гроші складаються.
 */
export async function loadPeriodVisits(clubId: string, start: Date, end: Date) {
  const [bookings, seats] = await Promise.all([
    prisma.booking.findMany({
      where: {
        clubId,
        status: 'CONFIRMED',
        startTime: { gte: start, lte: end },
        customerId: { not: null },
      },
      select: { customerId: true, priceTotal: true },
    }),
    prisma.bookingSeat.findMany({
      where: {
        status: 'BOOKED',
        customerId: { not: null },
        /* clubId через контейнер: у місця свого немає. */
        booking: { clubId, status: 'CONFIRMED', startTime: { gte: start, lte: end } },
      },
      select: { customerId: true, price: true },
    }),
  ]);
  return [
    ...bookings.map((b) => ({ customerId: b.customerId as string, money: b.priceTotal })),
    ...seats.map((s) => ({ customerId: s.customerId as string, money: s.price })),
  ];
}

/** Візити -> по людині: скільки разів і на яку суму. */
export function tallyVisits(visits: { customerId: string; money: number }[]) {
  const byCustomer = new Map<string, { visits: number; spend: number }>();
  for (const v of visits) {
    const row = byCustomer.get(v.customerId) ?? { visits: 0, spend: 0 };
    row.visits += 1;
    row.spend += v.money;
    byCustomer.set(v.customerId, row);
  }
  return byCustomer;
}

export async function periodStats(clubId: string, start: Date, end: Date) {
  const bookings = await prisma.booking.findMany({
    where: {
      clubId,
      status: 'CONFIRMED',
      startTime: { gte: start, lte: end },
    },
    select: {
      id: true, priceTotal: true, rentalTotal: true, trainerPrice: true, capacity: true,
      customer: { select: { discountPercent: true } },
    },
  });

  /* Виручка корту (нарахування): без тренера/прокату, абонемент за вартістю заняття. */
  const passValues = await loadPassSessionValues(prisma, bookings.map((b) => b.id));
  const revenue = bookings.reduce(
    (s, b) => s + courtValueOf({ ...b, discountPercent: b.customer?.discountPercent }, passValues.get(b.id)), 0);
  /* Різні клієнти — і власники броней, і учасники місць групових занять. */
  const uniqueCustomers = tallyVisits(await loadPeriodVisits(clubId, start, end)).size;

  return { bookings: bookings.length, revenue, uniqueCustomers };
}

/** (нове − старе) / старе, у відсотках. null, якщо нема з чим порівнювати. */
function pctChange(now: number, prev: number): number | null {
  if (prev === 0) return now === 0 ? 0 : null;
  return Math.round(((now - prev) / prev) * 1000) / 10;
}

/**
 * GET /api/admin/analytics/summary?period=week|month
 *
 * Скільки прийшло клієнтів і скільки грошей зараз проти попереднього
 * такого самого періоду — рівно те, що просили: "скільки клієнтів на
 * тижні/місяці, підрахунок грошей", але одразу з динамікою.
 */
analyticsRouter.get('/summary', async (req, res) => {
  const parsed = periodQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const club = await prisma.club.findUnique({
    where: { id: req.auth!.clubId },
    select: { timezone: true },
  });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

    const bounds = periodBounds(parsed.data, club.timezone, DateTime.now());
  /* Власний діапазон приходить від клієнта: перевернутий, задовгий або
     неповний читати нема як. */
  if (!bounds) return res.status(400).json({ error: 'BAD_PERIOD' });
  const { current, previous } = bounds;

  const [now, prev] = await Promise.all([
    periodStats(req.auth!.clubId, current.start, current.end),
    periodStats(req.auth!.clubId, previous.start, previous.end),
  ]);

  res.json({
    period: parsed.data.period,
    range: { from: current.start.toISOString(), to: current.end.toISOString() },
    current: now,
    previous: prev,
    change: {
      bookings: pctChange(now.bookings, prev.bookings),
      revenue: pctChange(now.revenue, prev.revenue),
      uniqueCustomers: pctChange(now.uniqueCustomers, prev.uniqueCustomers),
    },
  });
});

/**
 * GET /api/admin/analytics/customers/top?period=week|month&limit=10
 *
 * Найчастіші гравці за період — основа для будь-якої програми лояльності
 * пізніше, а зараз просто "хто наші постійні клієнти".
 */
analyticsRouter.get('/customers/top', async (req, res) => {
  const parsed = periodQuery
    .extend({ limit: z.coerce.number().int().min(1).max(50).default(10) })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const club = await prisma.club.findUnique({
    where: { id: req.auth!.clubId },
    select: { timezone: true },
  });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

    const bounds = periodBounds(parsed.data, club.timezone, DateTime.now());
  /* Власний діапазон приходить від клієнта: перевернутий, задовгий або
     неповний читати нема як. */
  if (!bounds) return res.status(400).json({ error: 'BAD_PERIOD' });
  const { current } = bounds;

  const byCustomer = tallyVisits(await loadPeriodVisits(req.auth!.clubId, current.start, current.end));

  const top = [...byCustomer.entries()]
    .sort((a, b) => b[1].visits - a[1].visits)
    .slice(0, parsed.data.limit);

  const customers = await prisma.customer.findMany({
    where: { id: { in: top.map(([id]) => id) } },
    select: { id: true, name: true, phone: true },
  });
  const byId = new Map(customers.map((c) => [c.id, c]));

  res.json(
    top.map(([id, row]) => ({
      customerId: id,
      name: byId.get(id)?.name ?? '—',
      phone: byId.get(id)?.phone ?? '',
      visits: row.visits,
      spend: row.spend,
    })),
  );
});

/**
 * GET /api/admin/analytics/trainers/load?period=week|month
 *
 * Скільки занять і скільки виручки з тренера за період — навантаження,
 * а не рейтинг: тренер із двома заняттями не гірший, просто менше грає.
 */
analyticsRouter.get('/trainers/load', async (req, res) => {
  const parsed = periodQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const club = await prisma.club.findUnique({
    where: { id: req.auth!.clubId },
    select: { timezone: true },
  });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

    const bounds = periodBounds(parsed.data, club.timezone, DateTime.now());
  /* Власний діапазон приходить від клієнта: перевернутий, задовгий або
     неповний читати нема як. */
  if (!bounds) return res.status(400).json({ error: 'BAD_PERIOD' });
  const { current } = bounds;

  const bookings = await prisma.booking.findMany({
    where: {
      clubId: req.auth!.clubId,
      status: 'CONFIRMED',
      startTime: { gte: current.start, lte: current.end },
      trainerId: { not: null },
    },
    select: { trainerId: true, trainerPrice: true },
  });

  const byTrainer = new Map<string, { sessions: number; revenue: number }>();
  for (const b of bookings) {
    const id = b.trainerId!;
    const row = byTrainer.get(id) ?? { sessions: 0, revenue: 0 };
    row.sessions += 1;
    row.revenue += b.trainerPrice;
    byTrainer.set(id, row);
  }

  const trainers = await prisma.trainer.findMany({
    where: { id: { in: [...byTrainer.keys()] } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(trainers.map((t) => [t.id, t.name]));

  res.json(
    [...byTrainer.entries()]
      .map(([id, row]) => ({ trainerId: id, name: nameOf.get(id) ?? '—', ...row }))
      .sort((a, b) => b.sessions - a.sessions),
  );
});

/**
 * GET /api/admin/analytics/forecast?period=week|month
 *
 * Прогноз наступного періоду за трендом попередніх — НЕ статистична модель,
 * а екстраполяція середнього темпу росту з фіксованим коридором похибки
 * (±17.5%, як просили "15-20%"). Чесно позначено як оцінку: на вибірці
 * з кількох тижнів справжній довірчий інтервал все одно був би профанацією.
 */
analyticsRouter.get('/forecast', async (req, res) => {
  const parsed = periodQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const club = await prisma.club.findUnique({
    where: { id: req.auth!.clubId },
    select: { timezone: true },
  });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

  const period = parsed.data.period;
  const unit = period === 'week' ? 'week' : 'month';
  const SAMPLE = period === 'week' ? 8 : 6;

  const now = DateTime.now().setZone(club.timezone);
  const series: { start: string; end: string; revenue: number }[] = [];

  // SAMPLE повних періодів ДО поточного (він ще не завершився — рахувати
  // його разом із завершеними означало б порівнювати неповний тиждень
  // з повними й системно занижувати тренд).
  for (let i = SAMPLE; i >= 1; i -= 1) {
    const anchor = now.minus({ [unit]: i } as Record<string, number>);
    const start = anchor.startOf(unit as 'week' | 'month').toJSDate();
    const end = anchor.endOf(unit as 'week' | 'month').toJSDate();
    const stats = await periodStats(req.auth!.clubId, start, end);
    series.push({ start: start.toISOString(), end: end.toISOString(), revenue: stats.revenue });
  }

  const nonZero = series.filter((p) => p.revenue > 0).length;
  if (nonZero < 2) {
    return res.json({ available: false, reason: 'NOT_ENOUGH_DATA', series });
  }

  const growthRates: number[] = [];
  for (let i = 1; i < series.length; i += 1) {
    if (series[i - 1].revenue > 0) {
      growthRates.push((series[i].revenue - series[i - 1].revenue) / series[i - 1].revenue);
    }
  }
  const avgGrowth = growthRates.reduce((s, g) => s + g, 0) / growthRates.length;
  // Клямпимо: пара бурхливих тижнів не має екстраполюватись у прогноз
  // "виручка х5 наступного місяця".
  const clampedGrowth = Math.max(-0.5, Math.min(1, avgGrowth));

  const lastPeriod = series[series.length - 1].revenue;
  const mid = Math.round(lastPeriod * (1 + clampedGrowth));

  res.json({
    available: true,
    period,
    basedOnPeriods: series.length,
    lastPeriodRevenue: lastPeriod,
    growthRatePct: Math.round(clampedGrowth * 1000) / 10,
    forecast: {
      low: Math.round(mid * 0.825),
      mid,
      high: Math.round(mid * 1.175),
    },
    series,
  });
});

/* -------------------------------------------------------------------------- */
/* ЗАВАНТАЖЕННЯ: ДНІ ТИЖНЯ І ГОДИНИ ДОБИ                                      */
/* -------------------------------------------------------------------------- */

/**
 * Скільки броней має набратись, щоб профіль узагалі показувати.
 *
 * Тиждень дає рівно ОДНЕ спостереження на кожен день тижня: одна бронь у
 * вівторок о 08:00 при двох кортах — це «завантаження 50%», хоча насправді
 * це один випадковий гравець. Поки броней менше двох десятків, графік
 * малює не звичку клубу, а шум.
 */
const LOAD_MIN_BOOKINGS = 20;

/**
 * GET /api/admin/analytics/load?weeks=8
 *
 * Який день тижня і яка година доби реально заповнені. Відповідь — два зрізи
 * однієї матриці: byWeekday (7 рядків) і byHour (тільки години, коли клуб
 * узагалі відчинений).
 *
 * ── Чому не period=week|month, як у решти звітів ─────────────────────────
 *
 * Ті звіти відповідають на питання «як ідуть справи зараз» і порівнюються з
 * попереднім періодом. Тут питання про сталу звичку клієнтів, а вона на
 * одному тижні не видна: у клітинці «вівторок, 08:00» за тиждень рівно
 * стільки спостережень, скільки в клубі кортів.
 *
 * ── Чому вікно закінчується на початку поточного тижня ───────────────────
 *
 * Поточний тиждень неповний: у середу в ньому вже є понеділок і вівторок, а
 * суботи ще немає. Змішавши його з повними, ми систематично занижували б
 * вихідні. Та сама причина, що й у /forecast.
 */
analyticsRouter.get('/load', async (req, res) => {
  const parsed = z
    .object({ weeks: z.coerce.number().int().min(4).max(26).default(8) })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const result = await loadClubLoadProfile(req.auth!.clubId, parsed.data.weeks, DateTime.now());
  if (!result) return res.status(404).json({ error: 'NOT_FOUND' });

  const range = { weeks: result.window.weeks, from: result.window.from.toISOString(), to: result.window.to.toISOString() };

  /* Чесно кажемо «замало», а не малюємо графік по трьох бронях — той самий
     принцип, що в /forecast з NOT_ENOUGH_DATA. */
  if (!result.available) {
    return res.json({ available: false, reason: result.reason, ...range, bookings: result.bookings, needBookings: result.needBookings });
  }

  res.json({ available: true, ...range, ...result.profile });
});

/* -------------------------------------------------------------------------- */
/* PRO: ЗДОРОВʼЯ КЛУБУ — НЕ ЩЕ ОДИН СПИСОК ЦИФР, А ПРИЧИНИ ДЛЯ ДІЇ           */
/* -------------------------------------------------------------------------- */

/**
 * Операційне вікно /deep (воронка, утримання).
 *
 * week/month — від початку періоду до «зараз», як і було. custom — рівно
 * від from до кінця to в таймзоні клубу (ті самі межі й ліміт 366 днів, що
 * у решти звітів через periodBounds); null — діапазон нечитабельний (400).
 */
export function deepOperationalWindow(q: PeriodQuery, tz: string, now: DateTime) {
  if (q.period === 'custom') {
    const bounds = periodBounds(q, tz, now);
    return bounds ? { from: bounds.current.start, to: bounds.current.end } : null;
  }
  const unit = q.period === 'week' ? 'week' : 'month';
  return { from: now.setZone(tz).startOf(unit).toJSDate(), to: now.toJSDate() };
}

/**
 * GET /api/admin/analytics/deep?period=week|month|custom&from=&to=
 *
 * Дорогий, але один агрегований зріз для найвищого пакета. Він навмисно
 * об'єднує три різні питання власника:
 *   1. де губляться записи і гроші (статуси); 2. хто перестає ходити
 *   (утримання); 3. який корт продає свій доступний час найкраще.
 *
 * Звичайний `summary` лишається швидкою панеллю «сьогодні». Тут останні
 * вісім ПОВНИХ тижнів: незавершений тиждень не псує ні завантаження, ні
 * рейтинг кортів. Блокування віднімаються з ємності через buildLoadProfile,
 * отже ремонт не видається за непроданий час.
 */
analyticsRouter.get('/deep', async (req, res) => {
  const parsed = periodQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const clubId = req.auth!.clubId;
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: {
      timezone: true,
      createdAt: true,
      hours: { select: { weekday: true, openMinute: true, closeMinute: true, isClosed: true } },
    },
  });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

  const now = DateTime.now().setZone(club.timezone);
  const period = parsed.data.period;
  const window = deepOperationalWindow(parsed.data, club.timezone, now);
  if (!window) return res.status(400).json({ error: 'BAD_PERIOD' });
  const { from: operationalFrom, to: operationalTo } = window;

  // Рівно вісім завершених тижнів — для змінного попиту це достатньо
  // згладжує випадковість, але ще не перетворює літні дані на «норму» зими.
  const loadTo = now.startOf('week').toJSDate();
  const nominalLoadFrom = now.startOf('week').minus({ weeks: 8 }).toJSDate();
  const loadFrom = club.createdAt > nominalLoadFrom ? club.createdAt : nominalLoadFrom;

  const [courts, blocks, loadBookings, funnelBookings, funnelSeats, directVisits, seatVisits] = await Promise.all([
    prisma.court.findMany({
      where: { clubId, isActive: true },
      select: { id: true, name: true, pricePerHour: true, sortOrder: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.block.findMany({
      where: { clubId, startTime: { lt: loadTo }, endTime: { gt: loadFrom } },
      select: { courtId: true, startTime: true, endTime: true },
    }),
    prisma.booking.findMany({
      where: {
        clubId, status: 'CONFIRMED', startTime: { lt: loadTo }, endTime: { gt: loadFrom },
      },
      select: {
        id: true, courtId: true, startTime: true, endTime: true, priceTotal: true,
        rentalTotal: true, trainerPrice: true, capacity: true, customer: { select: { discountPercent: true } },
      },
    }),
    prisma.booking.findMany({
      where: { clubId, startTime: { gte: operationalFrom, lte: operationalTo } },
      select: {
        status: true, priceTotal: true,
        payment: { select: { status: true } },
      },
    }),
    // У груповому занятті контейнер бронює корт, а «запис» клієнта — це
    // місце. Воронка без цього запиту показувала б одну бронь замість
    // восьми заявок і ховала б саме ті неоплати/скасування, які власнику
    // треба помітити.
    prisma.bookingSeat.findMany({
      where: { booking: { clubId, startTime: { gte: operationalFrom, lte: operationalTo } } },
      select: { status: true, price: true, payment: { select: { status: true } } },
    }),
    prisma.booking.findMany({
      where: { clubId, status: 'CONFIRMED', startTime: { lte: operationalTo }, customerId: { not: null } },
      select: { customerId: true, startTime: true },
    }),
    prisma.bookingSeat.findMany({
      where: {
        status: 'BOOKED', customerId: { not: null },
        booking: { clubId, status: 'CONFIRMED', startTime: { lte: operationalTo } },
      },
      select: { customerId: true, booking: { select: { startTime: true } } },
    }),
  ]);

  /* Виручка корту: без тренера/прокату, заняття з абонемента — за pass.price/totalSessions. */
  const loadPassValues = await loadPassSessionValues(prisma, loadBookings.map((b) => b.id));
  const valuedLoadBookings = loadBookings.map((b) => ({
    courtId: b.courtId, startTime: b.startTime, endTime: b.endTime, priceTotal: b.priceTotal,
    courtValue: courtValueOf({ ...b, discountPercent: b.customer?.discountPercent }, loadPassValues.get(b.id)),
  }));
  const profileInput = {
    from: loadFrom, to: loadTo, timezone: club.timezone, hours: club.hours, blocks, bookings: valuedLoadBookings,
  };
  const load = buildLoadProfile({ ...profileInput, courts });
  const courtPerformance = courts.map((court) => {
    const one = buildLoadProfile({ ...profileInput, courts: [{ id: court.id }] }).totals;
    const bookedHours = one.bookedMinutes / 60;
    const availableHours = one.openMinutes / 60;
    return {
      courtId: court.id,
      name: court.name,
      bookings: one.bookings,
      revenue: one.revenue,
      occupancy: roundPct(one.occupancy),
      availableHours: Math.round(availableHours * 10) / 10,
      bookedHours: Math.round(bookedHours * 10) / 10,
      unsoldHours: Math.max(0, Math.round((availableHours - bookedHours) * 10) / 10),
      revenuePerBookedHour: bookedHours ? Math.round(one.revenue / bookedHours) : 0,
      revenuePerAvailableHour: availableHours ? Math.round(one.revenue / availableHours) : 0,
    };
  }).sort((a, b) => b.revenuePerAvailableHour - a.revenuePerAvailableHour || b.occupancy - a.occupancy);

  const funnelRows: FunnelBooking[] = [
    ...funnelBookings.map((booking) => ({
      ...booking,
      paymentStatus: booking.payment?.status ?? null,
    })),
    ...funnelSeats.map((seat): FunnelBooking => ({
      status: seat.status === 'BOOKED'
        ? 'CONFIRMED'
        : seat.status === 'PENDING'
          ? 'PENDING'
          : seat.status === 'CANCELLED'
            ? 'CANCELLED'
            : 'EXPIRED',
      priceTotal: seat.price,
      paymentStatus: seat.payment?.status ?? null,
    })),
  ];
  const funnel = bookingFunnel(funnelRows);
  const retention = retentionFromVisits([
    ...directVisits.map((v) => ({ customerId: v.customerId!, at: v.startTime })),
    ...seatVisits.map((v) => ({ customerId: v.customerId!, at: v.booking.startTime })),
  ], operationalTo, 30);

  const atRisk = retention.atRiskIds.length
    ? await prisma.customer.findMany({
      where: { clubId, id: { in: retention.atRiskIds.slice(0, 6) } },
      select: { id: true, name: true, phone: true },
    })
    : [];

  const insights: { tone: 'alert' | 'watch' | 'good'; title: string; body: string }[] = [];
  if (funnel.cancellationRate !== null && funnel.cancellationRate >= 15 && funnel.CANCELLED >= 3) {
    insights.push({
      tone: 'alert', title: `Скасування — ${funnel.cancellationRate}%`,
      body: `${funnel.CANCELLED} записів скасовано. Перевірте вікно скасування, нагадування та доступність часу.`,
    });
  }
  if (load.totals.openMinutes > 0 && load.totals.occupancy < 0.45) {
    insights.push({
      tone: 'watch', title: `Непродано ${Math.round((load.totals.openMinutes - load.totals.bookedMinutes) / 60)} год`,
      body: 'Це доступний час за 8 повних тижнів без урахування ремонтів. Почніть із тихих годин у тепловій карті.',
    });
  }
  if (retention.atRiskIds.length >= 3) {
    insights.push({
      tone: 'watch', title: `${retention.atRiskIds.length} клієнтів під ризиком`,
      body: 'Останній візит 30–90 днів тому — це сегмент «Згасає» в картотеці (те саме число). Нижче є контакти для персонального нагадування, повний список — у «Клієнти → Під ризиком».',
    });
  }
  if (funnel.conversionRate !== null && funnel.conversionRate >= 85 && load.totals.occupancy >= 0.65) {
    insights.push({
      tone: 'good', title: 'Сильний операційний ритм',
      body: 'Підтверджується більшість вирішених записів, а корти стабільно завантажені. Перевірте, чи не час тестувати вищу ціну у пікові години.',
    });
  }
  if (!insights.length) {
    insights.push({
      tone: 'good', title: 'Критичних сигналів немає',
      body: 'Дивіться на рух показників між періодами: аналітика показує факти, а не вигадує проблему з кількох записів.',
    });
  }

  res.json({
    operationalRange: { from: operationalFrom.toISOString(), to: operationalTo.toISOString(), period },
    loadRange: { from: loadFrom.toISOString(), to: loadTo.toISOString(), weeks: 8 },
    funnel,
    retention: { ...retention, atRisk },
    load: { available: load.totals.bookings >= LOAD_MIN_BOOKINGS, bookings: load.totals.bookings, ...load },
    courtPerformance,
    insights,
  });
});

/* -------------------------------------------------------------------------- */
/* ВИТРАТИ І ЧИСТИЙ ПРИБУТОК                                                  */
/* -------------------------------------------------------------------------- */

const monthQuery = z.object({
  /** YYYY-MM. За замовчуванням — поточний місяць клуба. */
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

/** Те саме плюс власний діапазон: from/to сильніші за month, якщо задані. */
const expensesQuery = monthQuery.extend({
  from: z.string().regex(DATE_ONLY).optional(),
  to: z.string().regex(DATE_ONLY).optional(),
  /** accrual («надано послуг», за замовчуванням) | cash («каса») — те саме, що GET /finance/pnl. */
  basis: z.enum(['accrual', 'cash']).default('accrual'),
});

/**
 * Виручка періоду на обох базах (одне визначення з /finance/pnl, lib/pnlBasis.ts):
 * accrual — послуги за датою початку (корт + тренер + прокат, абонемент за
 * вартістю заняття); cash — рух грошей за датою (ledger, онлайн, абонементи).
 */
async function revenueBothBases(clubId: string, start: Date, end: Date, tz: string) {
  const [acc, cashRows] = await Promise.all([
    loadAccrualBookings(prisma, clubId, start, end),
    loadCashRows(clubId, start, end, tz),
  ]);
  return { accrual: accrualTotal(acc.bookings, acc.passValues), cash: cashNet(cashRows) };
}

function basisBlock(basis: Basis, totalExpenses: number, rev: { accrual: number; cash: number }) {
  const revenue = rev[basis];
  const other = otherBasis(basis);
  const pnl = {
    basis,
    revenue,
    expenses: totalExpenses,
    profit: revenue - totalExpenses,
    alt: { basis: other, revenue: rev[other], profit: rev[other] - totalExpenses },
  };
  /* Єдиний блок `pnl` має ту саму форму в /finance/pnl. Верхній рівень лишає
     старі імена: `expenses` тут — РЯДКИ витрат (як і було), тому сума — у
     totalExpenses, а netProfit тепер дорівнює profit обраної бази. */
  return {
    pnl,
    basis,
    revenue,
    profit: pnl.profit,
    netProfit: pnl.profit,
    alt: pnl.alt,
  };
}

/** 'YYYY-MM' (або порожньо — тоді поточний місяць у таймзоні клуба) -> межі місяця. */
function monthBounds(monthStr: string | undefined, tz: string) {
  const anchor = monthStr
    ? DateTime.fromFormat(monthStr, 'yyyy-MM', { zone: tz })
    : DateTime.now().setZone(tz);
  const start = anchor.startOf('month');
  return {
    monthKey: start.toFormat('yyyy-MM'),
    monthDate: start.toJSDate(),
    start: start.toJSDate(),
    end: start.endOf('month').toJSDate(),
  };
}

/**
 * GET /api/admin/analytics/expenses?month=YYYY-MM
 *
 * Витрати за місяць + виручка того самого місяця + чистий прибуток одним
 * запитом — власнику потрібне готове число, а не сирі дані для підрахунку.
 */
analyticsRouter.get('/expenses', async (req, res) => {
  const parsed = expensesQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const club = await prisma.club.findUnique({
    where: { id: req.auth!.clubId },
    select: { timezone: true },
  });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

  const tz = club.timezone;
  const clubId = req.auth!.clubId;

  /* Власний діапазон. Витрата в базі привʼязана до МІСЯЦЯ, а не до дня:
     оренда й зарплата так і платяться, дробити їх по днях ми не вміємо і
     вигадувати не будемо. Тому для довільного періоду беремо витрати всіх
     місяців, яких він торкається, а виручку — точно за вибрані дні, і
     чесно кажемо клієнту прапорцем wholeMonths, чи можна вважати різницю
     чистим прибутком. */
  if (parsed.data.from && parsed.data.to) {
    const start = DateTime.fromISO(parsed.data.from, { zone: tz }).startOf('day');
    const end = DateTime.fromISO(parsed.data.to, { zone: tz }).endOf('day');
    if (!start.isValid || !end.isValid || end < start) {
      return res.status(400).json({ error: 'BAD_PERIOD' });
    }

    const months: Date[] = [];
    for (let m = start.startOf('month'); m <= end; m = m.plus({ months: 1 })) {
      months.push(m.toJSDate());
    }

    const [expenses, stats] = await Promise.all([
      prisma.clubExpense.findMany({
        where: { clubId, month: { in: months } },
        orderBy: [{ month: 'asc' }, { createdAt: 'asc' }],
      }),
      revenueBothBases(clubId, start.toJSDate(), end.toJSDate(), tz),
    ]);

    const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);

    res.json({
      from: start.toFormat('yyyy-MM-dd'),
      to: end.toFormat('yyyy-MM-dd'),
      months: months.map((m) => DateTime.fromJSDate(m).setZone(tz).toFormat('yyyy-MM')),
      /* Період збігається з межами місяців — отже, витрати й виручка
         міряні по одній лінійці, і чистий прибуток можна називати чистим
         прибутком. Інакше кабінет мусить це застерегти. */
      wholeMonths: start.hasSame(start.startOf('month'), 'day')
        && end.hasSame(end.endOf('month'), 'day'),
      expenses,
      totalExpenses,
      ...basisBlock(parsed.data.basis, totalExpenses, stats),
    });
    return;
  }

  const { monthKey, monthDate, start, end } = monthBounds(parsed.data.month, tz);

  const [expenses, stats] = await Promise.all([
    prisma.clubExpense.findMany({
      where: { clubId, month: monthDate },
      orderBy: { createdAt: 'asc' },
    }),
    revenueBothBases(clubId, start, end, tz),
  ]);

  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);

  res.json({
    month: monthKey,
    months: [monthKey],
    wholeMonths: true,
    expenses,
    totalExpenses,
    ...basisBlock(parsed.data.basis, totalExpenses, stats),
  });
});

const addExpenseSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  category: z.enum(['SALARY', 'RENT', 'BANK_FEE', 'UTILITIES', 'MARKETING', 'EQUIPMENT', 'TAX', 'OTHER']),
  label: z.string().trim().min(1).max(120),
  /** Гривні з поля вводу, як і решта грошових полів у кабінеті — переводимо в копійки тут. */
  amountGrn: z.number().positive(),
});

/** POST /api/admin/analytics/expenses — додати рядок витрат за місяць. */
analyticsRouter.post('/expenses', async (req, res) => {
  const parsed = addExpenseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const club = await prisma.club.findUnique({
    where: { id: req.auth!.clubId },
    select: { timezone: true },
  });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

  const { monthDate } = monthBounds(parsed.data.month, club.timezone);

  const expense = await prisma.clubExpense.create({
    data: {
      clubId: req.auth!.clubId,
      month: monthDate,
      category: parsed.data.category,
      label: parsed.data.label,
      amount: Math.round(parsed.data.amountGrn * 100),
    },
  });

  res.status(201).json(expense);
});

/** DELETE /api/admin/analytics/expenses/:id */
analyticsRouter.delete('/expenses/:id', async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const result = await prisma.clubExpense.deleteMany({
    where: { id, clubId: req.auth!.clubId },
  });

  if (result.count === 0) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true });
});

/* -------------------------------------------------------------------------- */
/* КАРТОТЕКА КЛІЄНТІВ                                                         */
/* -------------------------------------------------------------------------- */

/*
 * Межі сегментів, tierOf і сам збирач картотеки переїхали в
 * lib/customerRoster.ts: тепер екран і вивантаження рахують одне й те саме
 * одним кодом. Реекспорт лишається, бо на `tierOf` із цього модуля
 * посилаються тести політик — правила сегментації описані саме там.
 */
export {
  tierOf,
  TIER_ACTIVE_DAYS,
  TIER_FADING_DAYS,
  TIER_NEW_VISITS,
  type CustomerTier,
} from '../lib/customerRoster';

/**
 * GET /api/admin/analytics/traffic?period=week|month|custom
 *
 * Звідки приходять броні й клієнти.
 *
 * ── Два різні питання в одній відповіді ──────────────────────────────────
 *
 * `channels` — останній дотик: що спрацювало на броні цього періоду. Це
 * відповідь на «чи окупається реклама просто зараз».
 *
 * `acquisition` — перший дотик: що привело в клуб людей, чиї картки
 * заведені в цьому періоді. Відповідь на «звідки беруться нові».
 *
 * Плутати їх не можна. Постійний гравець, який сьогодні зайшов із
 * закладки, дає «прямий захід» у першому звіті — але клуб його колись
 * привів Instagram, і саме це видно в другому.
 *
 * ── Про «невідомо» ───────────────────────────────────────────────────────
 *
 * Броні, створені до появи обліку, мають порожній канал. Вони йдуть
 * окремим рядком `unknown`, а не розкидаються по каналах і не ховаються:
 * інакше перший же звіт показав би, що 100% трафіку — «прямі заходи»,
 * і клуб зробив би з цього неправильний висновок про рекламу.
 */
analyticsRouter.get('/traffic', async (req, res) => {
  const parsed = periodQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const club = await prisma.club.findUnique({
    where: { id: req.auth!.clubId },
    select: { timezone: true },
  });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

  const bounds = periodBounds(parsed.data, club.timezone, DateTime.now());
  if (!bounds) return res.status(400).json({ error: 'BAD_PERIOD' });
  const { current } = bounds;
  const clubId = req.auth!.clubId;

  const [bookings, customers] = await Promise.all([
    prisma.booking.findMany({
      where: {
        clubId,
        status: 'CONFIRMED',
        startTime: { gte: current.start, lte: current.end },
      },
      select: {
        trafficChannel: true, utmSource: true, utmMedium: true,
        utmCampaign: true, referrerHost: true, priceTotal: true, customerId: true,
      },
    }),
    prisma.customer.findMany({
      where: { clubId, createdAt: { gte: current.start, lte: current.end } },
      select: { firstChannel: true, firstUtmSource: true, firstUtmCampaign: true },
    }),
  ]);

  res.json({
    range: { from: current.start.toISOString(), to: current.end.toISOString() },
    channels: groupChannels(bookings),
    acquisition: groupAcquisition(customers),
    campaigns: groupCampaigns(bookings),
    totals: {
      bookings: bookings.length,
      revenue: bookings.reduce((s, b) => s + b.priceTotal, 0),
      newCustomers: customers.length,
      /* Скільки записів узагалі без джерела. Клуб має бачити, на якій
         частці даних побудований висновок, перш ніж на нього спиратися. */
      unknown: bookings.filter((b) => !b.trafficChannel).length,
    },
  });
});

/** Броні за зведеним каналом: скільки, на скільки і від скількох людей. */
function groupChannels(rows: {
  trafficChannel: string | null; priceTotal: number; customerId: string | null;
}[]) {
  const acc = new Map<string, { bookings: number; revenue: number; customers: Set<string> }>();

  for (const row of rows) {
    const key = row.trafficChannel ?? 'UNKNOWN';
    const cell = acc.get(key) ?? { bookings: 0, revenue: 0, customers: new Set<string>() };
    cell.bookings += 1;
    cell.revenue += row.priceTotal;
    if (row.customerId) cell.customers.add(row.customerId);
    acc.set(key, cell);
  }

  return [...acc.entries()]
    .map(([channel, cell]) => ({
      channel,
      bookings: cell.bookings,
      revenue: cell.revenue,
      customers: cell.customers.size,
      /* Середній чек по каналу — головне число для порівняння: канал може
         давати мало броней, але дорогих. */
      avgCheck: cell.bookings ? Math.round(cell.revenue / cell.bookings) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue || b.bookings - a.bookings);
}

/** Нові картки за першим дотиком — що приводить людей у клуб. */
function groupAcquisition(rows: { firstChannel: string | null; firstUtmSource: string | null }[]) {
  const acc = new Map<string, number>();
  for (const row of rows) {
    const key = row.firstChannel ?? 'UNKNOWN';
    acc.set(key, (acc.get(key) ?? 0) + 1);
  }
  return [...acc.entries()]
    .map(([channel, customers]) => ({ channel, customers }))
    .sort((a, b) => b.customers - a.customers);
}

/**
 * Окремі кампанії — під ними й ухвалюють рішення «продовжити чи зупинити».
 *
 * Рядки без utm_campaign сюди не потрапляють: «без кампанії» — це не
 * кампанія, і бачити її поруч із реальними означає щоразу відфільтровувати
 * її очима.
 */
function groupCampaigns(rows: {
  utmSource: string | null; utmCampaign: string | null; priceTotal: number;
}[]) {
  const acc = new Map<string, { source: string | null; bookings: number; revenue: number }>();

  for (const row of rows) {
    if (!row.utmCampaign) continue;
    const key = `${row.utmSource ?? '—'}|${row.utmCampaign}`;
    const cell = acc.get(key) ?? { source: row.utmSource, bookings: 0, revenue: 0 };
    cell.bookings += 1;
    cell.revenue += row.priceTotal;
    acc.set(key, cell);
  }

  return [...acc.entries()]
    .map(([key, cell]) => ({ campaign: key.split('|')[1], ...cell }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 20);
}

/**
 * Відбір картотеки — спільний для екрана і для вивантаження.
 *
 * Один і той самий набір параметрів навмисно: клуб фільтрує список на
 * екрані, бачить потрібних людей і натискає «Завантажити». Якби фільтри
 * розрізнялись, у файлі опинялись би не ті, кого щойно відібрали, — а це
 * найгірше, що може зробити вивантаження.
 */
const rosterQuery = z.object({
  tier: z.enum(['ACTIVE', 'FADING', 'LOST', 'NEW']).optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  q: z.string().trim().min(1).max(40).optional(),
});

type RosterSort = 'visits' | 'spend' | 'recent' | 'name' | 'birthday';

/** Порядок рядків. Мутує копію, а не вхідний масив. */
function sortRoster(rows: RosterRow[], sort: RosterSort): RosterRow[] {
  return [...rows].sort((a, b) => {
    if (sort === 'visits') return b.visits - a.visits;
    if (sort === 'spend') return b.spend - a.spend;
    if (sort === 'name') return a.name.localeCompare(b.name, 'uk');
    if (sort === 'birthday') return (a.daysUntilBirthday ?? 999) - (b.daysUntilBirthday ?? 999);
    // recent: хто був найпізніше. Ті, хто не був жодного разу, — у кінці.
    if (!a.lastVisit && !b.lastVisit) return 0;
    if (!a.lastVisit) return 1;
    if (!b.lastVisit) return -1;
    return b.lastVisit.localeCompare(a.lastVisit);
  });
}

/**
 * GET /api/admin/analytics/customers/export?format=xlsx|csv
 *
 * Картотека клубу файлом: Excel або CSV, із тими самими фільтрами, що на
 * екрані.
 *
 * ── Чому тільки OWNER ────────────────────────────────────────────────────
 *
 * Решта аналітики — агрегати: завантаження кортів, виручка, частки. Тут
 * інше: імена, телефони й email усіх клієнтів одним файлом. Це і є та база,
 * заради якої клуб платить за систему, і найцінніше, що з нього можна
 * винести. Адміністратор працює з картками щодня — але поштучно, через
 * пошук на ресепшені; винести всю базу може лише власник.
 *
 * Вивантаження пишеться в ChangeLog. Не для покарання, а тому що це єдина
 * дія в кабінеті, після якої персональні дані клубу живуть поза системою:
 * коли вони спливуть у конкурента, питання «хто і коли скачав» має мати
 * відповідь.
 *
 * ── Про розмежування клубів ──────────────────────────────────────────────
 *
 * `clubId` береться лише з токена (`req.auth`) і ніколи з запиту. Тому
 * параметра «вивантажити інший клуб» не існує в принципі, і його не можна
 * підставити: база спільна, доступ — ні.
 *
 * Обробник винесено в іменовану функцію (`customersExportHandler`), а не
 * лишено анонімним у `.get(...)`, — той самий код тепер висить і тут (старий
 * шлях, під `requireFeature('analytics')` роутера), і на `exportRouter`
 * (routes/export.ts), де цього вартового плану нема: вивантаження бази —
 * не аналітика, а данні клубу, і власник має дійти до них на будь-якому
 * тарифі. Дублювати логіку заради різних адрес — якраз те, чого тут
 * уникаємо.
 */
export async function customersExportHandler(req: Request, res: Response) {
  {
    const parsed = rosterQuery
      .extend({
        format: z.enum(['xlsx', 'csv']).default('xlsx'),
        sort: z.enum(['visits', 'spend', 'recent', 'name', 'birthday']).default('name'),
      })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
    const { format, sort, tier, tag, q } = parsed.data;

    /* Пошта в токені не лежить — беремо з картки користувача разом із
       клубом. Потрібна саме для журналу: «хто скачав» має читатись через
       рік, коли акаунт уже може не існувати. */
    const [club, actor] = await Promise.all([
      prisma.club.findUnique({
        where: { id: req.auth!.clubId },
        select: { name: true, timezone: true },
      }),
      prisma.user.findFirst({
        where: { id: req.auth!.userId, clubId: req.auth!.clubId },
        select: { email: true },
      }),
    ]);
    if (!club || !actor) return res.status(404).json({ error: 'NOT_FOUND' });

    const now = new Date();
    const all = await loadRoster(req.auth!.clubId, { tag, q }, now);
    const rows = sortRoster(tier ? all.filter((r) => r.tier === tier) : all, sort);

    const meta: ExportMeta = {
      clubName: club.name,
      timezone: club.timezone,
      now,
      filter: { tier, tag, q },
    };

    /* Журнал пишемо до відправки файла: інакше запис, що впав, лишив би
       вивантаження без сліду саме тоді, коли слід найпотрібніший. */
    await recordChanges(
      prisma,
      { clubId: req.auth!.clubId, entity: 'CustomerExport', entityId: req.auth!.clubId },
      { userId: req.auth!.userId, email: actor.email, role: req.auth!.role },
      [{
        field: 'export',
        before: null,
        after: { format, rows: rows.length, filter: meta.filter },
      }],
    );

    const fileName = rosterFileName(meta, format);
    /* filename* у RFC 5987 — щоб кирилиця в назві клубу доїхала до браузера
       цілою; простий filename лишаємо запасним для старих клієнтів. */
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="customers.${format}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    /* Картотека — персональні дані, а не сторінка каталогу: жодних кешів
       по дорозі. */
    res.setHeader('Cache-Control', 'no-store');

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.send(rosterCsv(rows, meta));
    }

    res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
    return res.send(buildWorkbook(rosterWorkbookSheets(rows, meta)));
  }
}

analyticsRouter.get('/customers/export', requireRole('OWNER'), customersExportHandler);

const bookingExportQuery = z.object({
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  /* Дати без часу, як і в periodBounds: години в такому запиті нічого не
     уточнюють клубу, а от плутанину з таймзонами дають. Обидві опційні —
     типове вивантаження це «весь час», не тиждень і не місяць. */
  from: z.string().regex(DATE_ONLY).optional(),
  to: z.string().regex(DATE_ONLY).optional(),
});

/**
 * GET /api/admin/analytics/bookings/export?format=xlsx|csv&from=&to=
 *
 * Усі броні клубу файлом: приватні й групові, з оплатами, акціями,
 * скасуваннями й відвідуваністю. Той самий чесний сценарій «а що, якщо ми
 * зникнемо», що й /customers/export, тільки про записи, а не про людей —
 * клуб має піти з системи з історією того, ХТО і КОЛИ грав, а не лише з
 * телефонною книгою.
 *
 * ── Чому тільки OWNER ────────────────────────────────────────────────────
 *
 * Той самий аргумент, що й у customers/export: адміністратор бачить броні
 * щодня, але по одній, через сітку дня. Уся історія одним файлом — це те,
 * що виносять із клубу, і рішення про це лишається за власником.
 *
 * ── Період ────────────────────────────────────────────────────────────────
 *
 * from/to не мають типового значення — типове саме «весь час»: клубу, що
 * питає «а що як ви зникнете», не можна відповісти файлом за останній
 * тиждень. Межі, коли задані, читаються в таймзоні клубу через periodBounds
 * — так само, як і решта звітів.
 *
 * Обробник, як і в customers/export, винесено в іменовану функцію
 * (`bookingsExportHandler`): той самий код висить і на старому шляху (під
 * `requireFeature('analytics')`), і на `exportRouter` (без нього) — див.
 * коментар над `customersExportHandler`.
 */
export async function bookingsExportHandler(req: Request, res: Response) {
  {
    const parsed = bookingExportQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
    const { format, from, to } = parsed.data;

    const [club, actor] = await Promise.all([
      prisma.club.findUnique({
        where: { id: req.auth!.clubId },
        select: { name: true, timezone: true },
      }),
      prisma.user.findFirst({
        where: { id: req.auth!.userId, clubId: req.auth!.clubId },
        select: { email: true },
      }),
    ]);
    if (!club || !actor) return res.status(404).json({ error: 'NOT_FOUND' });

    const tz = club.timezone;
    const fromBound = from ? DateTime.fromISO(from, { zone: tz }).startOf('day') : null;
    const toBound = to ? DateTime.fromISO(to, { zone: tz }).endOf('day') : null;
    if ((fromBound && !fromBound.isValid) || (toBound && !toBound.isValid)) {
      return res.status(400).json({ error: 'BAD_REQUEST' });
    }
    if (fromBound && toBound && toBound < fromBound) {
      return res.status(400).json({ error: 'BAD_REQUEST' });
    }

    const now = new Date();
    const filterFrom = fromBound?.toJSDate();
    const filterTo = toBound?.toJSDate();
    const data = await loadBookingExport(req.auth!.clubId, { from: filterFrom, to: filterTo });

    const meta: BookingExportMeta = {
      clubName: club.name,
      timezone: tz,
      now,
      from: filterFrom ?? null,
      to: filterTo ?? null,
    };

    /* Журнал — до відправки файла, з тієї ж причини, що й у customers/export:
       запис, що впав уже після відправки, лишив би вивантаження без сліду. */
    await recordChanges(
      prisma,
      { clubId: req.auth!.clubId, entity: 'BookingExport', entityId: req.auth!.clubId },
      { userId: req.auth!.userId, email: actor.email, role: req.auth!.role },
      [{
        field: 'export',
        before: null,
        after: {
          format,
          rows: data.bookings.length,
          seatRows: data.seats.length,
          from: from ?? null,
          to: to ?? null,
        },
      }],
    );

    const fileName = bookingsFileName(meta, format);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="bookings.${format}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    /* Броні — так само персональні дані, як і картотека: жодних кешів. */
    res.setHeader('Cache-Control', 'no-store');

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.send(bookingExportCsv(data.bookings, meta));
    }

    res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
    return res.send(buildWorkbook(bookingExportWorkbookSheets(data, meta)));
  }
}

analyticsRouter.get('/bookings/export', requireRole('OWNER'), bookingsExportHandler);

/**
 * GET /api/admin/analytics/customers
 *
 * Картотека: усі клієнти клубу з відвідуваннями, витратами й сегментом.
 *
 * ── Чому не /customers/top ───────────────────────────────────────────────
 *
 * Той роут відповідає на питання «хто наші найкращі за місяць» і бере
 * тільки CONFIRMED-броні за період. Тут питання інше — «що взагалі з нашою
 * базою»: потрібні всі, разом із тими, хто перестав ходити, бо саме вони
 * цікаві для дзвінка.
 *
 * ── Групові заняття рахуються теж ────────────────────────────────────────
 *
 * У контейнера групи customerId порожній — люди сидять у BookingSeat. Тому
 * відвідування збираються з ДВОХ джерел. Без цього клієнт, який ходить
 * лише на йогу, виглядав би як «жодного разу не був», і клуб дзвонив би
 * повертати того, хто був учора.
 */
analyticsRouter.get('/customers', async (req, res) => {
  const parsed = rosterQuery
    .extend({
      sort: z.enum(['visits', 'spend', 'recent', 'name', 'birthday']).default('recent'),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const { tier, tag, q, sort, limit } = parsed.data;

  const now = new Date();
  const all = await loadRoster(req.auth!.clubId, { tag, q }, now);
  if (all.length === 0) return res.json({ tiers: {}, customers: [] });

  /* Підсумок по сегментах рахуємо ДО фільтра: клуб має бачити, скільки
     всього втрачених, навіть коли дивиться на активних. */
  const tiers = tierCounts(all);
  const rows = sortRoster(tier ? all.filter((r) => r.tier === tier) : all, sort);

  res.json({
    tiers,
    total: rows.length,
    thresholds: { activeDays: TIER_ACTIVE_DAYS, fadingDays: TIER_FADING_DAYS },
    customers: rows.slice(0, limit),
  });
});

/**
 * GET /api/admin/analytics/trainers/popular?months=6
 *
 * Хто з тренерів популярніший — за КІЛЬКІСТЮ РІЗНИХ ЛЮДЕЙ, а не занять.
 *
 * ── Чому не /trainers/load ───────────────────────────────────────────────
 *
 * Той рахує навантаження за тиждень або місяць: скільки занять і скільки
 * з них виручки. Питання «до кого йдуть» інше й на короткому вікні не
 * відповідається: тренер із пʼятьма постійними по двічі на тиждень дасть
 * більше занять, ніж той, до кого за півроку сходило сорок різних людей.
 * Перший завантажений, другий популярний, і плутати їх не варто.
 *
 * ── Групові рахуються по людях ───────────────────────────────────────────
 *
 * У групового заняття один тренер і багато записаних. Тому йога на вісьмох
 * — це ОДНЕ заняття і ВІСІМ клієнтів. Рахувати її як одного клієнта
 * означало б записати тренера групових у невостребуваних.
 *
 * Люди без картки (адміністратор завів бронь без телефона) серед різних не
 * рахуються: їх нема чим відрізнити одне від одного. Самі заняття — так.
 */
analyticsRouter.get('/trainers/popular', async (req, res) => {
  const parsed = z
    .object({ months: z.coerce.number().int().min(1).max(24).default(6) })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const club = await prisma.club.findUnique({
    where: { id: req.auth!.clubId },
    select: { timezone: true },
  });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

  const now = DateTime.now().setZone(club.timezone);
  const from = now.minus({ months: parsed.data.months }).startOf('day').toJSDate();
  const to = now.toJSDate();

  const clubId = req.auth!.clubId;

  const [bookings, seats] = await Promise.all([
    prisma.booking.findMany({
      where: {
        clubId,
        status: 'CONFIRMED',
        trainerId: { not: null },
        startTime: { gte: from, lte: to },
      },
      select: {
        trainerId: true, customerId: true, trainerPrice: true, capacity: true,
      },
    }),
    prisma.bookingSeat.findMany({
      where: {
        status: 'BOOKED',
        booking: {
          clubId,
          status: 'CONFIRMED',
          trainerId: { not: null },
          startTime: { gte: from, lte: to },
        },
      },
      select: { customerId: true, booking: { select: { trainerId: true } } },
    }),
  ]);

  type Row = { sessions: number; clients: Set<string>; headcount: number; revenue: number };
  const byTrainer = new Map<string, Row>();
  const rowFor = (id: string) => {
    const r = byTrainer.get(id)
      ?? { sessions: 0, clients: new Set<string>(), headcount: 0, revenue: 0 };
    byTrainer.set(id, r);
    return r;
  };

  for (const b of bookings) {
    const r = rowFor(b.trainerId!);
    r.sessions += 1;
    r.revenue += b.trainerPrice;
    /* Приватна бронь — одна людина. Людей у групі рахуємо нижче, по
       місцях: capacity тут лише позначає, що заняття не приватне. */
    if (b.capacity == null) {
      r.headcount += 1;
      if (b.customerId) r.clients.add(b.customerId);
    }
  }

  for (const s of seats) {
    const r = rowFor(s.booking.trainerId!);
    r.headcount += 1;
    if (s.customerId) r.clients.add(s.customerId);
  }

  const trainers = await prisma.trainer.findMany({
    where: { id: { in: [...byTrainer.keys()] } },
    select: { id: true, name: true, isActive: true },
  });
  const byId = new Map(trainers.map((t) => [t.id, t]));

  res.json({
    months: parsed.data.months,
    from: from.toISOString(),
    trainers: [...byTrainer.entries()]
      .map(([id, r]) => ({
        trainerId: id,
        name: byId.get(id)?.name ?? '—',
        isActive: byId.get(id)?.isActive ?? false,
        sessions: r.sessions,
        /** Різних людей — головне число цього звіту */
        clients: r.clients.size,
        /** Скільки разів до нього приходили взагалі, з повторами */
        headcount: r.headcount,
        revenue: r.revenue,
      }))
      .sort((a, b) => b.clients - a.clients || b.sessions - a.sessions),
  });
});

/**
 * GET /api/admin/analytics/customers/:id/visits
 *
 * Історія відвідувань однієї людини — броні корту й групові заняття в
 * одному списку, бо для клуба це однаково «приходив».
 *
 * Майбутні записи теж повертаємо, окремим прапорцем: адміністратор
 * відкриває картку саме тоді, коли людина на дроті, і питання «а коли я
 * записаний» звучить не рідше, ніж «скільки я вже ходив».
 */
analyticsRouter.get('/customers/:id/visits', async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const parsed = z
    .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const clubId = req.auth!.clubId;

  const customer = await prisma.customer.findFirst({
    where: { id: id.data, clubId },
    select: { id: true, name: true, phone: true },
  });
  if (!customer) return res.status(404).json({ error: 'NOT_FOUND' });

  const [bookings, seats] = await Promise.all([
    prisma.booking.findMany({
      where: { clubId, customerId: customer.id, status: { in: ['CONFIRMED', 'PENDING'] } },
      select: {
        id: true, startTime: true, endTime: true, priceTotal: true, status: true,
        court: { select: { name: true } },
        trainer: { select: { name: true } },
      },
      orderBy: { startTime: 'desc' },
      take: parsed.data.limit,
    }),
    prisma.bookingSeat.findMany({
      where: {
        customerId: customer.id,
        status: 'BOOKED',
        booking: { clubId, status: { in: ['CONFIRMED', 'PENDING'] } },
      },
      select: {
        id: true, price: true,
        booking: {
          select: {
            startTime: true, endTime: true, title: true, status: true,
            court: { select: { name: true } },
            trainer: { select: { name: true } },
          },
        },
      },
      orderBy: { booking: { startTime: 'desc' } },
      take: parsed.data.limit,
    }),
  ]);

  const now = Date.now();

  const visits = [
    ...bookings.map((b) => ({
      id: b.id,
      kind: 'COURT' as const,
      label: b.court.name,
      start: b.startTime.toISOString(),
      end: b.endTime.toISOString(),
      price: b.priceTotal,
      trainerName: b.trainer?.name ?? null,
      status: b.status,
      upcoming: b.startTime.getTime() > now,
    })),
    ...seats.map((s) => ({
      id: s.id,
      kind: 'GROUP' as const,
      label: s.booking.title ?? 'Групове заняття',
      start: s.booking.startTime.toISOString(),
      end: s.booking.endTime.toISOString(),
      price: s.price,
      trainerName: s.booking.trainer?.name ?? null,
      status: s.booking.status,
      upcoming: s.booking.startTime.getTime() > now,
    })),
  ].sort((a, b) => b.start.localeCompare(a.start));

  const past = visits.filter((v) => !v.upcoming);

  res.json({
    customer,
    /* Підсумок рахуємо тільки по тому, що вже відбулось: майбутній запис
       ще не відвідування, і додавати його до «сходив 12 разів» — брехня. */
    totals: {
      visits: past.length,
      spend: past.reduce((a, v) => a + v.price, 0),
      firstVisit: past.length ? past[past.length - 1].start : null,
      lastVisit: past.length ? past[0].start : null,
    },
    visits: visits.slice(0, parsed.data.limit),
  });
});
