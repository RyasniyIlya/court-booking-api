import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { prisma } from '../lib/db';
import { requireAuth, requireRole } from './admin';

/**
 * CRM-аналітика для власника клубу. Окремий файл, а не ще один розділ
 * у admin.ts (той і так росте з кожною фічею) — увесь модуль про читання
 * даних, жодного запису.
 *
 * Тільки OWNER, свідомо без ADMIN: виручка й список найчастіших клієнтів —
 * це бізнес-дані власника, а не операційна інформація для щоденної роботи
 * ресепшена. requireLevel тут не потрібен — це той самий "перегляд", що
 * список броней на рівні 1, просто звужений по ролі, а не по рівню.
 */
export const analyticsRouter = Router();

analyticsRouter.use(requireAuth, requireRole('OWNER'));

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
