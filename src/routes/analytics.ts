import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { prisma } from '../lib/db';
import { requireAuth, requireRole, requireFeature } from './admin';
import { buildLoadProfile } from '../lib/loadProfile';
import { bookingFunnel, retentionFromVisits, roundPct, type FunnelBooking } from '../lib/deepAnalytics';

/**
 * CRM-аналітика кабінету. Окремий файл, а не ще один розділ
 * у admin.ts (той і так росте з кожною фічею) — увесь модуль про читання
 * даних, жодного запису.
 *
 * OWNER і ADMIN. Тренер — ні: виручка клубу й список найчастіших клієнтів
 * не мають стосунку до його розкладу. Модератор веде клуб щодня і без цифр
 * не веде його взагалі, тому дані тут ті самі, що й у власника.
 * requireLevel не потрібен — це той самий "перегляд", що список броней на
 * рівні 1, просто звужений по ролі, а не по рівню.
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
analyticsRouter.use(requireAuth, requireRole('OWNER', 'ADMIN'), requireFeature('analytics'));

const periodQuery = z.object({
  period: z.enum(['week', 'month']).default('week'),
});

/** Межі періоду в таймзоні клубу, повернуті як UTC-момент для запиту в базу. */
function periodBounds(period: 'week' | 'month', tz: string, anchor: DateTime) {
  const unit = period === 'week' ? 'week' : 'month';
  const currentStart = anchor.setZone(tz).startOf(unit);
  const currentEnd = anchor.setZone(tz).endOf(unit);
  const previousStart = currentStart.minus({ [unit]: 1 } as Record<string, number>);
  const previousEnd = currentEnd.minus({ [unit]: 1 } as Record<string, number>);
  return {
    current: { start: currentStart.toJSDate(), end: currentEnd.toJSDate() },
    previous: { start: previousStart.toJSDate(), end: previousEnd.toJSDate() },
  };
}

async function periodStats(clubId: string, start: Date, end: Date) {
  const bookings = await prisma.booking.findMany({
    where: {
      clubId,
      status: 'CONFIRMED',
      startTime: { gte: start, lte: end },
    },
    select: { priceTotal: true, customerId: true },
  });

  const revenue = bookings.reduce((s, b) => s + b.priceTotal, 0);
  const uniqueCustomers = new Set(bookings.map((b) => b.customerId).filter(Boolean)).size;

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

  const { current, previous } = periodBounds(parsed.data.period, club.timezone, DateTime.now());

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

  const { current } = periodBounds(parsed.data.period, club.timezone, DateTime.now());

  const bookings = await prisma.booking.findMany({
    where: {
      clubId: req.auth!.clubId,
      status: 'CONFIRMED',
      startTime: { gte: current.start, lte: current.end },
      customerId: { not: null },
    },
    select: { customerId: true, priceTotal: true },
  });

  const byCustomer = new Map<string, { visits: number; spend: number }>();
  for (const b of bookings) {
    const id = b.customerId!;
    const row = byCustomer.get(id) ?? { visits: 0, spend: 0 };
    row.visits += 1;
    row.spend += b.priceTotal;
    byCustomer.set(id, row);
  }

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

  const { current } = periodBounds(parsed.data.period, club.timezone, DateTime.now());

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

  const weeks = parsed.data.weeks;
  const anchor = DateTime.now().setZone(club.timezone).startOf('week');
  const to = anchor.toJSDate();

  /* Вікно не заходить за появу клубу: до реєстрації корти не могли
     простоювати, і без цього обрізання клуб першого місяця бачив би
     завантаження, поділене на неіснуючі тижні.

     Того самого для окремого корту зробити не вийде: Court не зберігає
     дати створення. Корт, доданий посеред вікна, перші тижні виглядатиме
     недозавантаженим — це відоме обмеження, а не помилка розрахунку. */
  const windowStart = anchor.minus({ weeks }).toJSDate();
  const from = club.createdAt > windowStart ? club.createdAt : windowStart;

  /* Броні й блокування беремо ПЕРЕТИНОМ з вікном, а не за startTime: заняття,
     що почалось до опівночі понеділка й тягнеться в наш період, зайняло корт
     так само, як будь-яке інше. */
  const [courts, blocks, bookings] = await Promise.all([
    prisma.court.findMany({
      where: { clubId, isActive: true },
      select: { id: true },
    }),
    prisma.block.findMany({
      where: { clubId, startTime: { lt: to }, endTime: { gt: from } },
      select: { courtId: true, startTime: true, endTime: true },
    }),
    prisma.booking.findMany({
      where: {
        clubId,
        status: 'CONFIRMED',
        startTime: { lt: to },
        endTime: { gt: from },
      },
      select: { courtId: true, startTime: true, endTime: true, priceTotal: true },
    }),
  ]);

  const profile = buildLoadProfile({
    from, to, timezone: club.timezone, hours: club.hours, courts, blocks, bookings,
  });

  const range = { weeks, from: from.toISOString(), to: to.toISOString() };

  /* Чесно кажемо «замало», а не малюємо графік по трьох бронях — той самий
     принцип, що в /forecast з NOT_ENOUGH_DATA. */
  if (profile.totals.bookings < LOAD_MIN_BOOKINGS) {
    return res.json({
      available: false,
      reason: 'NOT_ENOUGH_DATA',
      ...range,
      bookings: profile.totals.bookings,
      needBookings: LOAD_MIN_BOOKINGS,
    });
  }

  res.json({ available: true, ...range, ...profile });
});

/* -------------------------------------------------------------------------- */
/* PRO: ЗДОРОВʼЯ КЛУБУ — НЕ ЩЕ ОДИН СПИСОК ЦИФР, А ПРИЧИНИ ДЛЯ ДІЇ           */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/admin/analytics/deep?period=week|month
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
  const unit = period === 'week' ? 'week' : 'month';
  const operationalFrom = now.startOf(unit as 'week' | 'month').toJSDate();
  const operationalTo = now.toJSDate();

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
      select: { courtId: true, startTime: true, endTime: true, priceTotal: true },
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

  const profileInput = {
    from: loadFrom, to: loadTo, timezone: club.timezone, hours: club.hours, blocks, bookings: loadBookings,
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
      tone: 'watch', title: `${retention.atRiskIds.length} клієнтів під ризиком відтоку`,
      body: 'Вони приходили у попередні 30 днів, але не повернулися в останні 30. Нижче є контакти для персонального нагадування.',
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
  const parsed = monthQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const club = await prisma.club.findUnique({
    where: { id: req.auth!.clubId },
    select: { timezone: true },
  });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

  const { monthKey, monthDate, start, end } = monthBounds(parsed.data.month, club.timezone);

  const [expenses, stats] = await Promise.all([
    prisma.clubExpense.findMany({
      where: { clubId: req.auth!.clubId, month: monthDate },
      orderBy: { createdAt: 'asc' },
    }),
    periodStats(req.auth!.clubId, start, end),
  ]);

  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);

  res.json({
    month: monthKey,
    expenses,
    totalExpenses,
    revenue: stats.revenue,
    netProfit: stats.revenue - totalExpenses,
  });
});

const addExpenseSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  category: z.enum(['SALARY', 'RENT', 'BANK_FEE', 'UTILITIES', 'OTHER']),
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

/**
 * Межі сегментів у днях від останнього відвідування.
 *
 * Не налаштування клубу — свідомо. Три сегменти мають означати те саме в
 * усіх клубах, інакше «згасає» в одному дорівнює «активний» в іншому, і
 * будь-яка розмова про цифри між нами й клубом розсипається. Якщо колись
 * попросять — це два поля в Club, але починати з них зарано.
 */
const TIER_ACTIVE_DAYS = 30;
const TIER_FADING_DAYS = 90;

/**
 * Скільки перших відвідувань людина ще вважається новачком.
 *
 * Раніше новачком був тільки той, хто записався і НЕ БУВ ЖОДНОГО РАЗУ, —
 * тобто сегмент зникав рівно тоді, коли з людиною вперше можна поговорити
 * про клуб. А новачок — це не «нуль візитів», це той, хто ще не вирішив,
 * лишається він чи ні: його зустрічають, запамʼятовують імʼя, питають, як
 * пішло. Пʼять занять — це приблизно місяць-півтора занять раз на тиждень,
 * рівно той строк, за який людина або стає постійною, або зникає.
 *
 * Число тут, а не в налаштуваннях клубу, — з тієї ж причини, що й межі в
 * днях: сегмент має означати те саме всюди.
 */
const TIER_NEW_VISITS = 5;

export type CustomerTier = 'ACTIVE' | 'FADING' | 'LOST' | 'NEW';

/**
 * До якого сегмента належить клієнт.
 *
 * NEW окремо від LOST: людина, яка записалась учора, і людина, яка зникла
 * пів року тому, — це різні розмови. Перших зустрічають, других повертають.
 *
 * ── Чому новачок живе всередині «ходить», а не поруч ─────────────────────
 *
 * Спочатку рахуємо, чи людина взагалі ходить, і лише потім — чи вона ще
 * новачок. Тобто той, у кого три візити, але останній був три місяці тому,
 * це FADING, а не NEW.
 *
 * Інакше сегменти почали б брехати саме там, де вони найпотрібніші:
 * новачок, який сходив двічі й пропав, — це найважливіший дзвінок у всій
 * картотеці, а лишившись у «новачках» він виглядав би як людина, яку
 * просто ще не встигли зустріти.
 */
export function tierOf(
  lastVisit: Date | null,
  firstSeen: Date,
  now: Date,
  visits = 0,
): CustomerTier {
  if (!lastVisit) {
    const daysKnown = (now.getTime() - firstSeen.getTime()) / 86_400_000;
    return daysKnown <= TIER_ACTIVE_DAYS ? 'NEW' : 'LOST';
  }
  const days = (now.getTime() - lastVisit.getTime()) / 86_400_000;
  if (days > TIER_FADING_DAYS) return 'LOST';
  if (days > TIER_ACTIVE_DAYS) return 'FADING';
  return visits <= TIER_NEW_VISITS ? 'NEW' : 'ACTIVE';
}

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
  const parsed = z
    .object({
      tier: z.enum(['ACTIVE', 'FADING', 'LOST', 'NEW']).optional(),
      tag: z.string().trim().min(1).max(40).optional(),
      q: z.string().trim().min(1).max(40).optional(),
      sort: z.enum(['visits', 'spend', 'recent', 'name']).default('recent'),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const { tier, tag, q, sort, limit } = parsed.data;

  const clubId = req.auth!.clubId;
  const now = new Date();

  /* Пошук: по імені завжди, по хвосту телефона — тільки коли в запиті є
     цифри. Спершу тут при пошуку по літерах у OR підставлялось значення,
     яке «свідомо не збігається» — і Postgres відхиляв ВЕСЬ запит
     (22021: нульовий байт не є валідним UTF8), тобто пошук по імені не
     працював зовсім. Тепер умову просто не додаємо, замість вигадування
     значення, що не може збігтися. */
  const digits = q ? q.replace(/[^0-9]/g, '').slice(-7) : '';
  const search = q
    ? [
      { name: { contains: q, mode: 'insensitive' as const } },
      ...(digits.length >= 3 ? [{ phoneTail: { endsWith: digits } }] : []),
    ]
    : null;

  const customers = await prisma.customer.findMany({
    where: {
      clubId,
      ...(tag ? { tags: { has: tag } } : {}),
      ...(search ? { OR: search } : {}),
    },
    select: {
      id: true, name: true, phone: true, note: true, tags: true,
      isBlocked: true, createdAt: true, telegramChatId: true,
    },
  });
  if (customers.length === 0) return res.json({ tiers: {}, customers: [] });

  const ids = customers.map((c) => c.id);

  /* Два джерела відвідувань. Скасовані не рахуються в жодному: людина
     записалась і не прийшла — це не візит, і в статистику лояльності
     він потрапляти не має. */
  const [bookings, seats] = await Promise.all([
    prisma.booking.findMany({
      where: {
        clubId,
        customerId: { in: ids },
        status: 'CONFIRMED',
        startTime: { lte: now },
      },
      select: { customerId: true, priceTotal: true, startTime: true },
    }),
    prisma.bookingSeat.findMany({
      where: {
        customerId: { in: ids },
        status: 'BOOKED',
        booking: { clubId, status: 'CONFIRMED', startTime: { lte: now } },
      },
      select: { customerId: true, price: true, booking: { select: { startTime: true } } },
    }),
  ]);

  type Row = { visits: number; spend: number; last: Date | null };
  const stats = new Map<string, Row>();
  const bump = (id: string, when: Date, money: number) => {
    const r = stats.get(id) ?? { visits: 0, spend: 0, last: null };
    r.visits += 1;
    r.spend += money;
    if (!r.last || when > r.last) r.last = when;
    stats.set(id, r);
  };

  for (const b of bookings) bump(b.customerId!, b.startTime, b.priceTotal);
  for (const s of seats) bump(s.customerId!, s.booking.startTime, s.price);

  let rows = customers.map((c) => {
    const r = stats.get(c.id) ?? { visits: 0, spend: 0, last: null };
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      note: c.note,
      tags: c.tags,
      isBlocked: c.isBlocked,
      hasCabinet: Boolean(c.telegramChatId),
      since: c.createdAt.toISOString(),
      visits: r.visits,
      spend: r.spend,
      lastVisit: r.last?.toISOString() ?? null,
      tier: tierOf(r.last, c.createdAt, now, r.visits),
    };
  });

  /* Підсумок по сегментах рахуємо ДО фільтра: клуб має бачити, скільки
     всього втрачених, навіть коли дивиться на активних. */
  const tiers = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.tier] = (acc[r.tier] ?? 0) + 1;
    return acc;
  }, {});

  if (tier) rows = rows.filter((r) => r.tier === tier);

  rows.sort((a, b) => {
    if (sort === 'visits') return b.visits - a.visits;
    if (sort === 'spend') return b.spend - a.spend;
    if (sort === 'name') return a.name.localeCompare(b.name, 'uk');
    // recent: хто був найпізніше. Ті, хто не був жодного разу, — у кінці.
    if (!a.lastVisit && !b.lastVisit) return 0;
    if (!a.lastVisit) return 1;
    if (!b.lastVisit) return -1;
    return b.lastVisit.localeCompare(a.lastVisit);
  });

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
