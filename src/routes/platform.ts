import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { hashPassword } from '../lib/passwordHash';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';

import { prisma } from '../lib/db';
import { JWT_SECRET } from '../lib/authSecret';
import { DateTime } from 'luxon';
import { PLAN_SELECT } from '../lib/plans';
import { clubBilling, PERIOD_LABEL } from '../lib/billing';
import { COURT_PRICING, courtMultiplier, courtPrice, isCustomQuote } from '../lib/courtPricing';
import { EMPTY_BUNDLE, clubListPrice, healthOf, loadClubMetrics } from '../lib/platformMetrics';
import { fmtDate, fmtUah, systemNote } from '../lib/platformJournal';
import { nextPeriod, periodAmount } from '../lib/subscription';
import { sendMessage } from '../lib/telegram';
import { requirePlatformAuth } from '../lib/platformAuth';

export const platformRouter = Router();

/* -------------------------------------------------------------------------- */
/* AUTH                                                                       */
/* -------------------------------------------------------------------------- */

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS' },
});

/**
 * POST /api/platform/login
 *
 * Один акаунт з .env (PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD_HASH).
 * Поки оператор один — заводити під це таблицю в базі зайве.
 */
platformRouter.post('/login', loginLimiter, async (req, res) => {
  const parsed = z
    .object({ email: z.string().email(), password: z.string().min(1) })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'BAD_REQUEST' });
  }

  const expectedEmail = process.env.PLATFORM_ADMIN_EMAIL;
  const expectedHash = process.env.PLATFORM_ADMIN_PASSWORD_HASH;

  if (!expectedEmail || !expectedHash) {
    return res.status(503).json({ error: 'PLATFORM_ADMIN_NOT_CONFIGURED' });
  }

  const email = parsed.data.email.trim().toLowerCase();

  if (email !== expectedEmail.trim().toLowerCase()) {
    // Той самий шлях, що й невірний пароль: не підказуємо, яка з двох речей
    // не збіглась.
    await bcrypt.compare(parsed.data.password, expectedHash);
    return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }

  const valid = await bcrypt.compare(parsed.data.password, expectedHash);
  if (!valid) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }

  const token = jwt.sign({ scope: 'platform', email }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

/* -------------------------------------------------------------------------- */
/* CLUBS                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/platform/pricing
 *
 * Таблиця «скільки коштує пакет при N кортах» для активних планів. Формула
 * живе тільки на сервері (lib/courtPricing.ts): клієнт отримує і константи, і
 * готові суми, і не тримає власну копію, яка одного дня розійшлась би з
 * рахунком.
 */
platformRouter.get('/pricing', requirePlatformAuth, async (_req, res) => {
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { tier: 'asc' }],
    select: PLAN_SELECT,
  });

  const table = Array.from({ length: 16 }, (_, i) => {
    const courts = i + 1;
    return {
      courts,
      multiplier: courtMultiplier(courts),
      customQuote: isCustomQuote(courts),
      plans: plans.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        period: p.period,
        tier: p.tier,
        basePrice: p.price,
        price: courtPrice(p.price, courts),
      })),
    };
  });

  res.json({ ...COURT_PRICING, table });
});

/**
 * GET /api/platform/clubs
 *
 * Усі клуби разом — те, що клубний кабінет принципово не може показати:
 * там кожен токен бачить лише свій clubId.
 *
 * Метрики й здоровʼя рахуються для всіх клубів однією пачкою агрегатів
 * (lib/platformMetrics.ts), а не запитом на клуб.
 */
platformRouter.get('/clubs', requirePlatformAuth, async (_req, res) => {
  const now = new Date();

  const [clubs, bundles] = await Promise.all([
    prisma.club.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        phone: true,
        address: true,
        city: true,
        crmTags: true,
        isActive: true,
        approvedAt: true,
        trialEndsAt: true,
        paidUntil: true,
        billingPeriod: true,
        billingNote: true,
        planPrice: true,
        plan: { select: PLAN_SELECT },
        group: { select: { id: true, name: true } },
        lead: { select: { id: true, stage: true } },
        createdAt: true,
        users: {
          where: { role: 'OWNER' },
          select: { email: true },
          take: 1,
        },
        _count: { select: { bookings: true, courts: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    loadClubMetrics(undefined, now),
  ]);

  res.json(
    clubs.map((c) => {
      const bundle = bundles.get(c.id) ?? EMPTY_BUNDLE;
      const price = clubListPrice(c, bundle.activeCourts);

      return {
        ...c,
        ownerEmail: c.users[0]?.email ?? null,
        users: undefined,
        bookingsCount: c._count.bookings,
        courtsCount: c._count.courts,
        _count: undefined,
        activeCourtsCount: bundle.activeCourts,
        listPrice: price.listPrice,
        listPricePeriod: price.period,
        listPriceMonthly: price.listPriceMonthly,
        priceSource: price.priceSource,
        customQuote: price.customQuote,
        metrics: bundle.metrics,
        health: healthOf(c, bundle.metrics, now),
      };
    }),
  );
});

/**
 * GET /api/platform/clubs/:id/details
 *
 * Картка клубу для оператора: що в нього налаштовано і як він працює. Лише
 * агрегати — імен і телефонів гравців тут немає навмисно: дані клієнтів
 * належать клубу, і оператору для роботи з клубом вони не потрібні.
 */
platformRouter.get('/clubs/:id/details', requirePlatformAuth, async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const now = new Date();

  const club = await prisma.club.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      slug: true,
      phone: true,
      address: true,
      city: true,
      timezone: true,
      crmTags: true,
      isActive: true,
      approvedAt: true,
      trialEndsAt: true,
      paidUntil: true,
      billingPeriod: true,
      billingNote: true,
      planPrice: true,
      plan: { select: PLAN_SELECT },
      group: { select: { id: true, name: true } },
      lead: { select: { id: true, stage: true } },
      autoConfirm: true,
      prepayEnabled: true,
      passesEnabled: true,
      createdAt: true,
    },
  });

  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

  const from30 = new Date(now.getTime() - 30 * 86_400_000);
  const live = { notIn: ['CANCELLED', 'EXPIRED'] as ('CANCELLED' | 'EXPIRED')[] };

  /* Шість календарних місяців у часовому поясі КЛУБУ: бронь о 00:30 першого
     числа за Києвом — це вже новий місяць, хоч у UTC ще старий. */
  const zone = club.timezone || 'Europe/Kyiv';
  const monthStart = DateTime.now().setZone(zone).startOf('month');
  const months = Array.from({ length: 6 }, (_, i) => monthStart.minus({ months: 5 - i }));
  const seriesFrom = months[0].toJSDate();
  const seriesTo = monthStart.plus({ months: 1 }).toJSDate();

  const [
    bundles,
    courts,
    courtBookings,
    hours,
    staff,
    customers,
    trainers,
    promos,
    passPlans,
    activePasses,
    sources,
    paidAgg,
    lastPaid,
    monthBookings,
    monthCustomers,
  ] = await Promise.all([
    loadClubMetrics([id], now),
    prisma.court.findMany({
      where: { clubId: id },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, pricePerHour: true, isActive: true, sortOrder: true },
    }),
    prisma.booking.groupBy({
      by: ['courtId'],
      where: { clubId: id, startTime: { gte: from30, lt: now }, status: live },
      _count: { _all: true },
    }),
    prisma.clubHours.findMany({
      where: { clubId: id },
      orderBy: { weekday: 'asc' },
      select: { weekday: true, openMinute: true, closeMinute: true, isClosed: true },
    }),
    /* Пошта й роль — так; passwordHash і токени в select не потрапляють */
    prisma.user.findMany({
      where: { clubId: id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, name: true, role: true, tgChatId: true, createdAt: true },
    }),
    prisma.customer.count({ where: { clubId: id } }),
    prisma.trainer.count({ where: { clubId: id } }),
    prisma.promo.count({ where: { clubId: id } }),
    prisma.passPlan.count({ where: { clubId: id } }),
    prisma.pass.count({ where: { clubId: id, revokedAt: null, validUntil: { gt: now } } }),
    prisma.booking.groupBy({
      by: ['source'],
      where: { clubId: id, startTime: { gte: from30, lt: now }, status: live },
      _count: { _all: true },
    }),
    prisma.clubInvoice.aggregate({
      where: { clubId: id, status: 'PAID' },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.clubInvoice.findFirst({
      where: { clubId: id, status: 'PAID' },
      orderBy: { paidAt: 'desc' },
      select: { id: true, amount: true, periodFrom: true, periodTo: true, paidAt: true, method: true },
    }),
    prisma.$queryRaw<{ month: string; bookings: number; revenue: number }[]>`
      SELECT to_char(date_trunc('month', "startTime" AT TIME ZONE ${zone}::text), 'YYYY-MM') AS month,
             COUNT(*)::int AS bookings,
             COALESCE(SUM("priceTotal"), 0)::float8 AS revenue
        FROM "Booking"
       WHERE "clubId" = ${id}::uuid
         AND "startTime" >= ${seriesFrom}
         AND "startTime" < ${seriesTo}
         AND "status" NOT IN ('CANCELLED', 'EXPIRED')
       GROUP BY 1
    `,
    /* Customer.createdAt лежить як timestamp без пояса (UTC) — спершу
       прикладаємо UTC, потім переводимо в пояс клубу. */
    prisma.$queryRaw<{ month: string; customers: number }[]>`
      SELECT to_char(date_trunc('month', ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${zone}::text), 'YYYY-MM') AS month,
             COUNT(*)::int AS customers
        FROM "Customer"
       WHERE "clubId" = ${id}::uuid
         AND "createdAt" >= ${seriesFrom}
         AND "createdAt" < ${seriesTo}
       GROUP BY 1
    `,
  ]);

  const bundle = bundles.get(id) ?? EMPTY_BUNDLE;
  const price = clubListPrice(club, bundle.activeCourts);
  const perCourt = new Map(courtBookings.map((r) => [r.courtId, r._count._all]));
  const bookingsByMonth = new Map(monthBookings.map((r) => [r.month, r]));
  const customersByMonth = new Map(monthCustomers.map((r) => [r.month, r.customers]));

  const sources30: Record<string, number> = { WIDGET: 0, ADMIN: 0, TELEGRAM_BOT: 0, PLAYER_APP: 0 };
  for (const r of sources) sources30[r.source] = r._count._all;

  res.json({
    ...club,
    activeCourtsCount: bundle.activeCourts,
    courtsCount: bundle.courts,
    listPrice: price.listPrice,
    listPricePeriod: price.period,
    listPriceMonthly: price.listPriceMonthly,
    priceSource: price.priceSource,
    customQuote: price.customQuote,
    courts: courts.map((c) => ({ ...c, bookings30: perCourt.get(c.id) ?? 0 })),
    hours,
    staff: staff.map(({ tgChatId, ...u }) => ({ ...u, tgLinked: Boolean(tgChatId) })),
    counts: { customers, trainers, promos, passPlans, activePasses },
    metrics: bundle.metrics,
    health: healthOf(club, bundle.metrics, now),
    series: months.map((m) => {
      const key = m.toFormat('yyyy-LL');
      return {
        month: key,
        bookings: bookingsByMonth.get(key)?.bookings ?? 0,
        revenue: bookingsByMonth.get(key)?.revenue ?? 0,
        newCustomers: customersByMonth.get(key) ?? 0,
      };
    }),
    sources30,
    invoicesSummary: {
      totalPaid: paidAgg._sum.amount ?? 0,
      paidCount: paidAgg._count._all,
      lastPaid,
    },
  });
});

const LEAD_STAGES = ['NEW', 'CHECKING', 'CONTACTED', 'QUALIFIED', 'DEMO', 'PROPOSAL', 'WON', 'LOST', 'NOT_FIT'] as const;
/** Етапи, на яких лід ще в роботі й має мати наступну дію */
const ACTIVE_LEAD_STAGES = ['NEW', 'CHECKING', 'CONTACTED', 'QUALIFIED', 'DEMO', 'PROPOSAL'] as const;

/**
 * GET /api/platform/overview
 *
 * Дашборд оператора: скільки клубів, скільки грошей і кому дзвонити. Один
 * екран замість вікна «Клуби» з калькулятором поруч.
 *
 * MRR — лише з клубів, у яких оплачений період ще триває: пробний і
 * прострочений клуб грошей зараз не приносять. Ціна — та сама, що виставить
 * видача підписки (активні корти, індивідуальна ціна), приведена до місяця.
 * Клуби, що чекають схвалення, у воронці клієнтів не рахуються взагалі.
 */
platformRouter.get('/overview', requirePlatformAuth, async (_req, res) => {
  const now = new Date();
  const from30 = new Date(now.getTime() - 30 * 86_400_000);
  const in7 = new Date(now.getTime() + 7 * 86_400_000);
  const in14 = new Date(now.getTime() + 14 * 86_400_000);
  const activeStages = [...ACTIVE_LEAD_STAGES];

  const [clubs, bundles, invoices30, leadGroups, leadsOverdue, leadsNoAction] = await Promise.all([
    prisma.club.findMany({
      select: {
        id: true,
        name: true,
        isActive: true,
        approvedAt: true,
        createdAt: true,
        trialEndsAt: true,
        paidUntil: true,
        billingPeriod: true,
        planPrice: true,
        plan: { select: PLAN_SELECT },
      },
    }),
    loadClubMetrics(undefined, now),
    prisma.clubInvoice.aggregate({
      where: { status: 'PAID', paidAt: { gte: from30 } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.lead.groupBy({ by: ['stage'], _count: { _all: true } }),
    prisma.lead.count({ where: { stage: { in: activeStages }, nextActionAt: { lt: now } } }),
    prisma.lead.count({ where: { stage: { in: activeStages }, nextActionAt: null } }),
  ]);

  type Row = Record<string, unknown> & { id: string; name: string; listPrice: number };
  const counts = { total: clubs.length, active: 0, pending: 0, onTrial: 0, paying: 0, overdue: 0, disabled: 0 };
  const health = { ok: 0, warn: 0, bad: 0 };
  const totals = { activeCourts: 0, bookings30: 0, revenue30: 0, customers: 0 };
  const expiring14: Row[] = [];
  const trialsEnding7: Row[] = [];
  const overdueList: Row[] = [];
  let mrr = 0;
  let newClubs30 = 0;

  for (const club of clubs) {
    const bundle = bundles.get(club.id) ?? EMPTY_BUNDLE;
    const price = clubListPrice(club, bundle.activeCourts);
    const billing = clubBilling(club, now);
    const brief = { id: club.id, name: club.name, listPrice: price.listPrice };

    if (club.createdAt >= from30) newClubs30 += 1;

    if (club.isActive) totals.activeCourts += bundle.activeCourts;
    totals.bookings30 += bundle.metrics.bookings30;
    totals.revenue30 += bundle.metrics.revenue30;
    totals.customers += bundle.metrics.customersTotal;

    if (!club.isActive) counts.disabled += 1;
    if (!club.approvedAt) {
      counts.pending += 1;
      continue; // ще не клієнт: ні оплат, ні здоровʼя
    }
    health[healthOf(club, bundle.metrics, now).tone] += 1;
    if (!club.isActive) continue;
    counts.active += 1;

    if (club.paidUntil && club.paidUntil > now) {
      counts.paying += 1;
      mrr += price.listPriceMonthly;
      if (club.paidUntil <= in14) expiring14.push({ ...brief, paidUntil: club.paidUntil });
    }

    if (billing.trial && billing.until && billing.until > now) {
      counts.onTrial += 1;
      if (billing.until <= in7) trialsEnding7.push({ ...brief, trialEndsAt: billing.until });
    }

    if (billing.state === 'grace' || billing.state === 'blocked') {
      counts.overdue += 1;
      overdueList.push({
        ...brief,
        paidUntil: club.paidUntil,
        until: billing.until,
        state: billing.state,
        daysLeft: billing.daysLeft,
      });
    }
  }

  const time = (row: Row, key: string) => new Date(row[key] as Date).getTime();
  expiring14.sort((a, b) => time(a, 'paidUntil') - time(b, 'paidUntil'));
  trialsEnding7.sort((a, b) => time(a, 'trialEndsAt') - time(b, 'trialEndsAt'));
  overdueList.sort((a, b) => time(a, 'until') - time(b, 'until'));

  const byStage: Record<string, number> = Object.fromEntries(LEAD_STAGES.map((s) => [s, 0]));
  for (const g of leadGroups) byStage[g.stage] = g._count._all;

  res.json({
    clubs: counts,
    mrr,
    arr: mrr * 12,
    expiring14,
    trialsEnding7,
    overdueList,
    newClubs30,
    totals,
    invoices30: { count: invoices30._count._all, amount: invoices30._sum.amount ?? 0 },
    health,
    leads: { byStage, overdueNextActions: leadsOverdue, noNextAction: leadsNoAction },
  });
});

/* -------------------------------------------------------------------------- */
/* CLUB GROUPS                                                                */
/* -------------------------------------------------------------------------- */

const groupBody = z.object({
  name: z.string().trim().min(2).max(120),
  note: z.string().trim().max(500).nullable().optional(),
  clubIds: z.array(z.string().uuid()).max(100).default([]),
});

const groupInclude = {
  clubs: {
    orderBy: { name: 'asc' as const },
    select: {
      id: true, name: true, slug: true, paidUntil: true, trialEndsAt: true,
      billingPeriod: true, planPrice: true, plan: { select: PLAN_SELECT },
    },
  },
};

platformRouter.get('/groups', requirePlatformAuth, async (_req, res) => {
  const groups = await prisma.clubGroup.findMany({
    orderBy: { name: 'asc' },
    include: groupInclude,
  });
  res.json(groups);
});

platformRouter.post('/groups', requirePlatformAuth, async (req, res) => {
  const parsed = groupBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const clubIds = [...new Set(parsed.data.clubIds)];

  const group = await prisma.$transaction(async (tx) => {
    const created = await tx.clubGroup.create({
      data: { name: parsed.data.name, note: parsed.data.note || null },
    });
    if (clubIds.length) {
      await tx.club.updateMany({ where: { id: { in: clubIds } }, data: { groupId: created.id } });
    }
    return tx.clubGroup.findUniqueOrThrow({ where: { id: created.id }, include: groupInclude });
  });
  res.status(201).json(group);
});

platformRouter.patch('/groups/:id', requirePlatformAuth, async (req, res) => {
  const parsed = groupBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const clubIds = [...new Set(parsed.data.clubIds)];

  try {
    const group = await prisma.$transaction(async (tx) => {
      await tx.clubGroup.update({
        where: { id },
        data: { name: parsed.data.name, note: parsed.data.note || null },
      });
      await tx.club.updateMany({ where: { groupId: id, id: { notIn: clubIds } }, data: { groupId: null } });
      if (clubIds.length) {
        await tx.club.updateMany({ where: { id: { in: clubIds } }, data: { groupId: id } });
      }
      return tx.clubGroup.findUniqueOrThrow({ where: { id }, include: groupInclude });
    });
    res.json(group);
  } catch {
    res.status(404).json({ error: 'NOT_FOUND' });
  }
});

platformRouter.delete('/groups/:id', requirePlatformAuth, async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    await prisma.clubGroup.delete({ where: { id } });
    res.status(204).end();
  } catch {
    res.status(404).json({ error: 'NOT_FOUND' });
  }
});

const groupSettingsBody = z.object({
  planId: z.string().uuid().nullable().optional(),
  planPrice: z.number().int().min(0).max(100_000_00).nullable().optional(),
  billingPeriod: z.enum(['MONTH', 'QUARTER', 'YEAR']).optional(),
  paidUntil: z.string().date().nullable().optional(),
  trialEndsAt: z.string().date().nullable().optional(),
});

platformRouter.patch('/groups/:id/settings', requirePlatformAuth, async (req, res) => {
  const parsed = groupSettingsBody.safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return res.status(400).json({ error: 'BAD_REQUEST' });
  }
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const exists = await prisma.clubGroup.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return res.status(404).json({ error: 'NOT_FOUND' });

  const { paidUntil, trialEndsAt, ...rest } = parsed.data;
  const data: Record<string, unknown> = { ...rest };
  if (paidUntil !== undefined) data.paidUntil = paidUntil ? new Date(`${paidUntil}T23:59:59.999Z`) : null;
  if (trialEndsAt !== undefined) data.trialEndsAt = trialEndsAt ? new Date(`${trialEndsAt}T23:59:59.999Z`) : null;

  try {
    const result = await prisma.club.updateMany({ where: { groupId: id }, data });
    res.json({ ok: true, updated: result.count });
  } catch {
    res.status(400).json({ error: 'BAD_REQUEST' });
  }
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  address: z.string().trim().max(200).nullable().optional(),

  /** true -> approvedAt = зараз, false -> approvedAt = null (повернути «чекає») */
  approved: z.boolean().optional(),

  isActive: z.boolean().optional(),

  /** ISO-дата або null — «оплачено до». Порожній рядок теж означає null. */
  paidUntil: z.string().nullable().optional(),

  /** ISO-дата або null — до коли діє пробний період без оплати. */
  trialEndsAt: z.string().nullable().optional(),

  billingPeriod: z.enum(['MONTH', 'QUARTER', 'YEAR']).optional(),
  billingNote: z.string().trim().max(500).nullable().optional(),

  /** uuid плану або null — зняти план (клуб лишається без обмежень) */
  planId: z.string().uuid().nullable().optional(),
  /**
   * Індивідуальна ціна, копійки. null — брати ціну з плану.
   * 0 дозволений: безкоштовне впровадження — реальна домовленість.
   */
  planPrice: z.number().int().min(0).max(100_000_00).nullable().optional(),

  /**
   * Мітки оператора. До 20 штук; дублі, що різняться лише регістром,
   * зливаються в одну — лишається перше написання («Мережа» і «мережа» —
   * одна мітка, а не дві, за якими потім не збіжиться фільтр).
   */
  crmTags: z
    .array(z.string().trim().min(1).max(40))
    .max(20)
    .transform((tags) => {
      const seen = new Set<string>();
      return tags.filter((t) => {
        const key = t.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    })
    .optional(),
  /** Місто для фільтра й групування. Порожній рядок = не задано */
  city: z
    .string()
    .trim()
    .max(80)
    .nullable()
    .transform((v) => v || null)
    .optional(),
});

/**
 * PATCH /api/platform/clubs/:id
 *
 * Тут же живе схвалення реєстрації (approved: true) і призупинення клубу
 * (isActive: false) — раніше обидві дії робились руками через Prisma
 * Studio чи одноразовий скрипт.
 */
platformRouter.patch('/clubs/:id', requirePlatformAuth, async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'BAD_REQUEST' });
  }

  const { approved, paidUntil, trialEndsAt, ...rest } = parsed.data;

  const data: Record<string, unknown> = { ...rest };

  if (approved !== undefined) {
    data.approvedAt = approved ? new Date() : null;
  }

  if (paidUntil !== undefined) {
    data.paidUntil = paidUntil ? new Date(paidUntil) : null;
  }

  if (trialEndsAt !== undefined) {
    data.trialEndsAt = trialEndsAt ? new Date(trialEndsAt) : null;
  }

  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  /* Стан ДО правки — щоб у журнал потрапило лише те, що справді змінилось:
     повторне «approved: true» на схваленому клубі не варте рядка. */
  const before = await prisma.club.findUnique({
    where: { id },
    select: { isActive: true, approvedAt: true, planPrice: true, plan: { select: { id: true, name: true } } },
  });
  if (!before) return res.status(404).json({ error: 'NOT_FOUND' });

  try {
    /* Правка й журнал — однією транзакцією: рядок «змінено план» без самої
       зміни (або навпаки) гірший за відсутність журналу. */
    const club = await prisma.$transaction(async (tx) => {
      const updated = await tx.club.update({
        where: { id },
        data,
        include: { plan: { select: PLAN_SELECT } },
      });

      const notes: string[] = [];
      if (approved !== undefined && Boolean(before.approvedAt) !== approved) {
        notes.push(approved ? 'Клуб схвалено' : 'Схвалення знято: клуб знову чекає');
      }
      if (rest.isActive !== undefined && before.isActive !== rest.isActive) {
        notes.push(rest.isActive ? 'Клуб увімкнено' : 'Клуб вимкнено');
      }
      if (rest.planId !== undefined && (before.plan?.id ?? null) !== rest.planId) {
        notes.push(`План: ${before.plan?.name ?? 'без плану'} → ${updated.plan?.name ?? 'без плану'}`);
      }
      if (rest.planPrice !== undefined && before.planPrice !== rest.planPrice) {
        const show = (v: number | null) => (v === null ? 'за планом' : fmtUah(v));
        notes.push(`Індивідуальна ціна: ${show(before.planPrice)} → ${show(rest.planPrice)}`);
      }

      for (const text of notes) {
        await tx.crmActivity.create(systemNote(id, text, req.platformAuth?.email));
      }
      return updated;
    });
    res.json(club);
  } catch {
    res.status(404).json({ error: 'NOT_FOUND' });
  }
});

/* -------------------------------------------------------------------------- */
/* PLANS                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Каталог планів. Веде оператор — клуб сюди не має доступу взагалі:
 * у кабінеті він бачить лише той план, який йому призначили.
 */
platformRouter.get('/plans', requirePlatformAuth, async (_req, res) => {
  const plans = await prisma.plan.findMany({
    orderBy: [{ sortOrder: 'asc' }, { tier: 'asc' }],
    include: { _count: { select: { clubs: true } } },
  });

  res.json(
    plans.map((p) => ({
      ...p,
      clubsCount: p._count.clubs,
      _count: undefined,
    })),
  );
});

const planBody = z.object({
  /** Ключ для коду. Латиниця, цифри й дефіс — на нього спираються seed і нотатки */
  code: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,31}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullable().optional(),
  /** Копійки. 0 дозволений — безкоштовний план теж план */
  price: z.number().int().min(0).max(100_000_00),
  period: z.enum(['MONTH', 'QUARTER', 'YEAR']).optional(),
  tier: z.number().int().min(1).max(9).optional(),
  featTrainers: z.boolean().optional(),
  featGroups: z.boolean().optional(),
  featAnalytics: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

platformRouter.post('/plans', requirePlatformAuth, async (req, res) => {
  const parsed = planBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'BAD_REQUEST' });
  }

  try {
    const plan = await prisma.plan.create({ data: parsed.data });
    res.status(201).json(plan);
  } catch {
    // Єдина реальна причина — зайнятий code (унікальний індекс)
    res.status(409).json({ error: 'CODE_TAKEN' });
  }
});

platformRouter.patch('/plans/:id', requirePlatformAuth, async (req, res) => {
  // code не міняється після створення: на нього спираються посилання
  // ззовні, а перейменування ключа мовчки розірвало б їх.
  const parsed = planBody.partial().omit({ code: true }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'BAD_REQUEST' });
  }

  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  try {
    const plan = await prisma.plan.update({ where: { id }, data: parsed.data });
    res.json(plan);
  } catch {
    res.status(404).json({ error: 'NOT_FOUND' });
  }
});

/**
 * Видалення плану. Клуби, яким він призначений, НЕ видаляються і не
 * ламаються — за зовнішнім ключем їм проставляється planId = null, тобто
 * вони лишаються без обмежень. Але це рішення оператора, а не побічний
 * ефект, тому попереджаємо кількістю в підтвердженні на клієнті.
 */
platformRouter.delete('/plans/:id', requirePlatformAuth, async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  try {
    await prisma.plan.delete({ where: { id } });
    res.status(204).end();
  } catch {
    res.status(404).json({ error: 'NOT_FOUND' });
  }
});

/* -------------------------------------------------------------------------- */
/* ВІДНОВЛЕННЯ ПАРОЛЯ                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Пароль клубу прочитати не можна — у базі bcrypt-хеш. Тому «відновлення»
 * тут завжди означає «задати новий», і єдине питання — хто підтвердив, що
 * на тому кінці справді власник.
 *
 * Підтверджує оператор, голосом: заявка з бота дає імʼя в Telegram і клуб,
 * далі дзвінок. Автоматично не робимо нічого — жодна перевірка, доступна
 * боту, не відрізняє власника від того, хто знає його пошту.
 */

/**
 * GET /api/platform/resets
 *
 * Черга заявок. За замовчуванням лише нові: закриті цікавлять як журнал,
 * а не як робочий список, і мішати їх в одну стрічку означало б ховати
 * свіжу заявку під торішніми.
 */
platformRouter.get('/resets', requirePlatformAuth, async (req, res) => {
  const all = req.query.all === '1';

  const rows = await prisma.passwordReset.findMany({
    where: all ? {} : { status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    take: all ? 200 : 100,
    select: {
      id: true,
      email: true,
      tgName: true,
      status: true,
      createdAt: true,
      resolvedAt: true,
      resolvedBy: true,
      club: { select: { id: true, name: true, slug: true, phone: true } },
      user: { select: { role: true } },
    },
  });

  res.json(rows);
});

/**
 * POST /api/platform/clubs/:id/owner-password
 *
 * Задати новий пароль власникові клубу. Межі 8..128 — ті самі, що й у
 * формі реєстрації (routes/admin/auth.ts): пароль, з яким потім не
 * вийде увійти, гірший за відсутність кнопки.
 *
 * resetId необовʼязковий: оператор може міняти пароль і без заявки (клуб
 * подзвонив, а бота не має взагалі). Але якщо заявка є — закриваємо її
 * тією ж транзакцією, інакше вона висітиме в черзі вже виконаною.
 */
platformRouter.post('/clubs/:id/owner-password', requirePlatformAuth, async (req, res) => {
  const clubId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = z
    .object({
      password: z.string().min(8).max(128),
      resetId: z.string().uuid().optional(),
    })
    .safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  /* Пароль отримує саме власник. Модератора чи тренера, що загубив
     пароль, заводить наново сам клуб — це його кухня, не наша. */
  const owner = await prisma.user.findFirst({
    where: { clubId, role: 'OWNER' },
    select: { id: true, email: true, tgChatId: true },
  });

  if (!owner) return res.status(404).json({ error: 'NOT_FOUND' });

  const passwordHash = await hashPassword(parsed.data.password, 12);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: owner.id }, data: { passwordHash } });

    /* Сам пароль у журнал не йде ніколи — лише факт і кому. */
    await tx.crmActivity.create(
      systemNote(clubId, `Змінено пароль власника (${owner.email})`, req.platformAuth?.email),
    );

    if (parsed.data.resetId) {
      /* updateMany, а не update: заявку могли закрити секунду тому з
         іншої вкладки, і падати через це нема сенсу — пароль уже новий. */
      await tx.passwordReset.updateMany({
        where: { id: parsed.data.resetId, status: 'PENDING' },
        data: {
          status: 'DONE',
          resolvedAt: new Date(),
          resolvedBy: req.platformAuth?.email ?? null,
        },
      });
    }
  });

  /* Повідомити власника, що пароль змінили. Не заради зручності: якщо
     заявку подав не він, це єдиний сигнал, що доступ до кабінету щойно
     перевидали. Сам пароль у чат не йде — його диктує оператор. */
  if (owner.tgChatId) {
    await sendMessage(
      owner.tgChatId,
      [
        '🔑 Пароль вашого кабінету змінено оператором.',
        '',
        '<i>Якщо ви цього не просили — негайно звʼяжіться з нами.</i>',
      ].join('\n'),
    ).catch(() => {
      /* Бот міг бути вимкнений або чат заблокований. Пароль уже змінено,
         і валити відповідь оператору через це не можна. */
    });
  }

  res.json({ ok: true, email: owner.email });
});

/**
 * POST /api/platform/resets/:id/reject
 *
 * Заявка не підтвердилась дзвінком. Прибираємо з черги, але лишаємо в
 * журналі: кілька відхилених заявок на один клуб — це вже сигнал.
 */
platformRouter.post('/resets/:id/reject', requirePlatformAuth, async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const r = await prisma.passwordReset.updateMany({
    where: { id, status: 'PENDING' },
    data: {
      status: 'REJECTED',
      resolvedAt: new Date(),
      resolvedBy: req.platformAuth?.email ?? null,
    },
  });

  if (r.count === 0) return res.status(404).json({ error: 'NOT_FOUND' });
  res.status(204).end();
});

/* -------------------------------------------------------------------------- */
/* ПІДПИСКА                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Видача підписки — головна дія, заради якої платформенка й існує.
 *
 * Гроші приходять поза системою: переказом, посиланням у Telegram, готівкою.
 * Еквайринг заради підписки 1–2,5 тис. грн ми поки не заводимо, тому «видати
 * підписку» означає рівно те, що робить оператор після дзвінка: записати, що
 * гроші дійшли, і посунути дату.
 *
 * Дві речі відбуваються РАЗОМ і тільки разом:
 *   1) створюється ClubInvoice — рядок в історії, який бачить сам клуб;
 *   2) посувається Club.paidUntil — те, від чого залежить онлайн-запис.
 *
 * Раніше не було ні першого, ні другого: таблиця рахунків існувала, кабінет
 * клубу вже малював історію оплат, але створити рахунок було нічим — жоден
 * роут у неї не писав. Історія у всіх клубів була порожня назавжди, а дата
 * рухалась вручну через форму. Транзакція тут не формальність: рахунок без
 * посунутої дати означає «клуб заплатив і не працює», а посунута дата без
 * рахунку — «працює, а за що платив, не видно».
 */
const subscriptionSchema = z.object({
  /** Не задано — беремо період плану, а якщо плану немає, період клубу */
  period: z.enum(['MONTH', 'QUARTER', 'YEAR']).optional(),
  /** Копійки. Не задано — рахуємо за планом і прайсом. 0 дозволений. */
  amount: z.number().int().min(0).max(1_000_000_00).optional(),
  /** 'transfer' | 'link' | 'cash' — вільний рядок, як у моделі */
  method: z.string().trim().max(40).optional(),
  note: z.string().trim().max(500).optional(),
});

platformRouter.post('/clubs/:id/subscription', requirePlatformAuth, async (req, res) => {
  const parsed = subscriptionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const club = await prisma.club.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      paidUntil: true,
      billingPeriod: true,
      planPrice: true,
      plan: { select: PLAN_SELECT },
      users: { where: { role: 'OWNER' }, select: { tgChatId: true }, take: 1 },
      /* Ціна залежить від кількості АКТИВНИХ кортів: вимкнений корт клуб
         не використовує і платити за нього не мусить. */
      _count: { select: { courts: { where: { isActive: true } } } },
    },
  });

  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

  const period = parsed.data.period ?? club.plan?.period ?? club.billingPeriod;
  const { from, to } = nextPeriod(club.paidUntil, period);
  const amount =
    parsed.data.amount ?? periodAmount(club.plan, club.planPrice, period, club._count.courts);

  const [invoice, updated] = await prisma.$transaction([
    prisma.clubInvoice.create({
      data: {
        clubId: club.id,
        periodFrom: from,
        periodTo: to,
        amount,
        status: 'PAID',
        paidAt: new Date(),
        method: parsed.data.method || null,
        note: parsed.data.note || null,
      },
    }),
    prisma.club.update({
      where: { id: club.id },
      /* billingPeriod підтягується за виданим періодом: клуб, який перейшов
         з місяця на рік, має бачити в кабінеті рік, а не старий підпис. */
      data: { paidUntil: to, billingPeriod: period },
      include: { plan: { select: PLAN_SELECT } },
    }),
    prisma.crmActivity.create(
      systemNote(
        club.id,
        `Зараховано оплату: ${PERIOD_LABEL[period]} · ${fmtUah(amount)}, до ${fmtDate(to)}`,
        req.platformAuth?.email,
      ),
    ),
  ]);

  /* Власнику — рядок у Telegram. Не «дякуємо за оплату», а дата: єдине, що
     він хотів дізнатись, коли переказував гроші. */
  const tgChatId = club.users[0]?.tgChatId;
  if (tgChatId) {
    await sendMessage(
      tgChatId,
      `✅ Оплату зараховано. Обслуговування ${club.name} діє до ${to.toLocaleDateString('uk-UA')}.`,
    ).catch(() => {
      /* Бот вимкнений або чат заблокований. Гроші вже зараховані, і валити
         через це відповідь оператору не можна. */
    });
  }

  res.json({ ok: true, club: updated, invoice });
});

/** Зарахувати однаковий період усім точкам мережі. amount — за одну точку. */
platformRouter.post('/groups/:id/subscription', requirePlatformAuth, async (req, res) => {
  const parsed = subscriptionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const group = await prisma.clubGroup.findUnique({
    where: { id },
    select: {
      name: true,
      clubs: {
        select: {
          id: true, paidUntil: true, billingPeriod: true, planPrice: true,
          plan: { select: PLAN_SELECT },
          _count: { select: { courts: { where: { isActive: true } } } },
        },
      },
    },
  });
  if (!group) return res.status(404).json({ error: 'NOT_FOUND' });
  if (group.clubs.length === 0) return res.status(409).json({ error: 'EMPTY_GROUP' });

  const rows = group.clubs.map((club) => {
    const period = parsed.data.period ?? club.plan?.period ?? club.billingPeriod;
    const { from, to } = nextPeriod(club.paidUntil, period);
    return {
      club,
      period,
      from,
      to,
      amount: parsed.data.amount ?? periodAmount(club.plan, club.planPrice, period, club._count.courts),
    };
  });

  await prisma.$transaction(rows.flatMap((row) => [
    prisma.clubInvoice.create({
      data: {
        clubId: row.club.id,
        periodFrom: row.from,
        periodTo: row.to,
        amount: row.amount,
        status: 'PAID',
        paidAt: new Date(),
        method: parsed.data.method || null,
        note: parsed.data.note || `Мережа: ${group.name}`,
      },
    }),
    prisma.club.update({
      where: { id: row.club.id },
      data: { paidUntil: row.to, billingPeriod: row.period },
    }),
    prisma.crmActivity.create(
      systemNote(
        row.club.id,
        `Зараховано оплату: ${PERIOD_LABEL[row.period]} · ${fmtUah(row.amount)}, до ${fmtDate(row.to)} (мережа «${group.name}»)`,
        req.platformAuth?.email,
      ),
    ),
  ]));

  res.json({
    ok: true,
    updated: rows.length,
    totalAmount: rows.reduce((sum, row) => sum + row.amount, 0),
  });
});

/**
 * GET /api/platform/clubs/:id/invoices
 *
 * Історія оплат клубу — те, що оператор читає під час дзвінка «а коли я
 * платив востаннє?». Двадцять чотири рядки: два роки помісячних оплат.
 */
platformRouter.get('/clubs/:id/invoices', requirePlatformAuth, async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const rows = await prisma.clubInvoice.findMany({
    where: { clubId: id },
    orderBy: { periodTo: 'desc' },
    take: 24,
  });

  res.json(rows);
});

/**
 * POST /api/platform/invoices/:id/void
 *
 * Скасувати помилковий рахунок. Не видалити: видалений рядок неможливо
 * пояснити клубу, який бачив його вчора в кабінеті.
 *
 * Дата відкочується ТІЛЬКИ якщо вона й досі дорівнює кінцю цього періоду.
 * Інакше оператор, який скасовує торішній рахунок, зніс би клубу оплату,
 * внесену після нього, — і дізнався б про це від клуба, а не від нас.
 *
 * Куди саме відкочувати, вирішує наявність попередніх оплат. Якщо цей
 * рахунок був у клуба першим, дата стає null — тобто «ще не платили», а це
 * стан, у якому все працює (див. lib/billing.ts). Повернути замість цього
 * `periodFrom` означало б вимкнути онлайн-запис клубу, який до нашої ж
 * помилки працював без обмежень.
 */
platformRouter.post('/invoices/:id/void', requirePlatformAuth, async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const invoice = await prisma.clubInvoice.findUnique({
    where: { id },
    select: { id: true, clubId: true, periodFrom: true, periodTo: true, amount: true, status: true },
  });

  if (!invoice) return res.status(404).json({ error: 'NOT_FOUND' });
  if (invoice.status === 'VOID') return res.status(409).json({ error: 'ALREADY_VOID' });

  const earlier = await prisma.clubInvoice.count({
    where: {
      clubId: invoice.clubId,
      status: 'PAID',
      id: { not: invoice.id },
      periodTo: { lte: invoice.periodTo },
    },
  });

  /* Інтерактивна транзакція, а не масив: текст журналу залежить від того,
     чи відкотилась дата, а це відомо лише після updateMany. */
  const rolled = await prisma.$transaction(async (tx) => {
    await tx.clubInvoice.update({
      where: { id: invoice.id },
      data: { status: 'VOID', paidAt: null },
    });
    const result = await tx.club.updateMany({
      where: { id: invoice.clubId, paidUntil: invoice.periodTo },
      data: { paidUntil: earlier > 0 ? invoice.periodFrom : null },
    });
    await tx.crmActivity.create(
      systemNote(
        invoice.clubId,
        `Скасовано рахунок ${fmtUah(invoice.amount)} за ${fmtDate(invoice.periodFrom)}–${fmtDate(invoice.periodTo)}` +
          (result.count > 0 ? ', дату оплати відкочено' : ''),
        req.platformAuth?.email,
      ),
    );
    return result;
  });

  res.json({ ok: true, rolledBack: rolled.count > 0 });
});
