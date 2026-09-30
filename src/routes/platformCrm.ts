import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import type { Prisma, LeadStage, CrmActivityKind } from '@prisma/client';

import { prisma } from '../lib/db';
import { requirePlatformAuth } from '../lib/platformAuth';
import { normalizePhone } from '../lib/phone';
import { courtPrice, isCustomQuote } from '../lib/courtPricing';
import { buildFillPatch, mapImportRow } from '../lib/leadImport';
import type { LeadImportData } from '../lib/leadImport';

/**
 * CRM оператора платформи: ліди, журнал дій (CrmActivity) по лідах і
 * клубах, задачі. Окремо від platform.ts, щоб каталог клубів і підписки не
 * змішувались із продажами. Монтується на той самий /api/platform.
 */
export const platformCrmRouter = Router();

platformCrmRouter.use(['/leads', '/tasks', '/activities', '/clubs/:id/activities'], requirePlatformAuth);

/* -------------------------------------------------------------------------- */
/* Спільне                                                                    */
/* -------------------------------------------------------------------------- */

const TZ = 'Europe/Kyiv';

const STAGES = ['NEW', 'CHECKING', 'CONTACTED', 'QUALIFIED', 'DEMO', 'PROPOSAL', 'WON', 'LOST', 'NOT_FIT'] as const;

/** Активні етапи: лід ще в роботі, тож у нього має бути наступний крок. */
const ACTIVE_STAGES: LeadStage[] = ['NEW', 'CHECKING', 'CONTACTED', 'QUALIFIED', 'DEMO', 'PROPOSAL'];

/** Підписи етапів для запису в журналі («Етап: Новий → Контакт»). */
const STAGE_LABEL: Record<LeadStage, string> = {
  NEW: 'Новий',
  CHECKING: 'Перевірка',
  CONTACTED: 'Контакт',
  QUALIFIED: 'Кваліфікований',
  DEMO: 'Демо',
  PROPOSAL: 'Пропозиція',
  WON: 'Клієнт',
  LOST: 'Відмова',
  NOT_FIT: 'Не підходить',
};

/** Види записів, які означають реальний контакт із лідом. */
const CONTACT_KINDS: CrmActivityKind[] = ['CALL', 'MESSAGE', 'MEETING', 'DEMO'];

const stageEnum = z.enum(STAGES);

/**
 * Межі дня за київським часом. Оператор мислить «сьогодні» київською
 * добою, а не UTC: задача на 00:30 за Києвом інакше потрапила б у «вчора».
 *
 * «Прострочене» = раніше за початок сьогоднішньої доби, а не раніше за
 * «зараз»: nextActionAt часто ставиться датою без часу (північ), і без
 * цього кожна сьогоднішня дія червоніла б одразу після опівночі.
 * «Тиждень» = [сьогодні, +7 діб) — прострочене має свій окремий фільтр.
 */
export function kyivBounds(now: Date = new Date()) {
  const start = DateTime.fromJSDate(now, { zone: TZ }).startOf('day');
  return {
    startToday: start.toJSDate(),
    startTomorrow: start.plus({ days: 1 }).toJSDate(),
    weekEnd: start.plus({ days: 7 }).toJSDate(),
  };
}

function idParam(req: Request): string | null {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  // Не-UUID Prisma відкинув би помилкою (500), а для клієнта це просто «не знайдено».
  return z.string().uuid().safeParse(id).success ? id : null;
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002';
}

/** BigInt не серіалізується в JSON — revenueYear віддаємо числом (гривні). */
function serializeLead<T extends { revenueYear?: bigint | null }>(lead: T) {
  return { ...lead, revenueYear: lead.revenueYear == null ? null : Number(lead.revenueYear) };
}

function operator(req: Request): string | undefined {
  return req.platformAuth?.email;
}

/** Дата ISO або YYYY-MM-DD. Дата без часу — початок доби за Києвом. */
function parseDate(s: string): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = DateTime.fromISO(s, { zone: TZ }).startOf('day');
    return d.isValid ? d.toJSDate() : null;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dateInput = z
  .string()
  .trim()
  .transform((s, ctx) => {
    const d = parseDate(s);
    if (!d) {
      ctx.addIssue({ code: 'custom', message: 'invalid date' });
      return z.NEVER;
    }
    return d;
  });

/* -------------------------------------------------------------------------- */
/* Схеми лідa                                                                 */
/* -------------------------------------------------------------------------- */

/** Порожній рядок = «очистити поле», тому перетворюємо на null. */
const text = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional();

const leadShape = {
  name: z.string().trim().min(1).max(200),
  legalName: text(),
  edrpou: z
    .string()
    .trim()
    .transform((s) => s.replace(/\s/g, ''))
    .refine((s) => s === '' || /^\d{5,12}$/.test(s))
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
  city: text(100),
  region: text(100),
  address: text(),
  sport: text(50),
  phone: text(50),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(200)
    .refine((s) => s === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s))
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
  website: text(),
  instagram: text(),
  contactName: text(),
  contactRole: text(100),
  courtsCount: z.number().int().min(0).max(200).nullable().optional(),
  currentSystem: text(),
  source: z.string().trim().min(1).max(50).optional(),
  priority: z.enum(['A', 'B', 'C']).optional(),
  stage: stageEnum.optional(),
  tags: z
    .array(z.string().trim().min(1).max(40))
    .max(20)
    .transform((list) => {
      // Дедуплікація без урахування регістру: «VIP» і «vip» — один тег.
      const seen = new Set<string>();
      return list.filter((t) => {
        const k = t.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    })
    .optional(),
  painConfirmed: z.boolean().optional(),
  decisionMaker: z.boolean().optional(),
  planInterest: text(50),
  nextAction: text(),
  nextActionAt: dateInput.nullable().optional(),
  lastContactAt: dateInput.nullable().optional(),
  lostReason: text(500),
  note: text(2000),
  revenueYear: z.number().int().min(0).nullable().optional(),
  marketScore: text(20),
  finScore: text(20),
};

const createLeadSchema = z.object(leadShape);
const patchLeadSchema = z.object(leadShape).partial();

type LeadInput = z.infer<typeof patchLeadSchema>;

/**
 * Вхід -> дані для Prisma. Телефон нормалізуємо до E.164 (інакше
 * «067 123 45 67» і «+380671234567» — два різні ліди), але не вдалося —
 * лишаємо як ввів оператор: краще неточний номер, ніж втрачений.
 */
function toLeadData(input: LeadInput): Prisma.LeadUncheckedUpdateInput {
  const { phone, revenueYear, ...rest } = input;
  const data: Prisma.LeadUncheckedUpdateInput = { ...rest };
  if (phone !== undefined) data.phone = phone === null ? null : (normalizePhone(phone)?.e164 ?? phone);
  if (revenueYear !== undefined) data.revenueYear = revenueYear === null ? null : BigInt(revenueYear);
  return data;
}

/* -------------------------------------------------------------------------- */
/* ЛІДИ: список, статистика                                                   */
/* -------------------------------------------------------------------------- */

const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  stage: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []))
    .pipe(z.array(stageEnum)),
  tag: z.string().trim().max(40).optional(),
  priority: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : []))
    .pipe(z.array(z.enum(['A', 'B', 'C']))),
  city: z.string().trim().max(100).optional(),
  source: z.string().trim().max(50).optional(),
  due: z.enum(['overdue', 'today', 'week', 'none']).optional(),
  sort: z.enum(['nextActionAt', 'updatedAt', 'priority', 'name', 'courts']).default('updatedAt'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

type ListQuery = z.infer<typeof listQuerySchema>;

/** Пошуковий рядок -> OR по текстових полях і по цифрах телефону. */
function searchWhere(q: string): Prisma.LeadWhereInput {
  const contains = { contains: q, mode: 'insensitive' as const };
  const or: Prisma.LeadWhereInput[] = [
    { name: contains },
    { legalName: contains },
    { city: contains },
    { email: contains },
    { edrpou: { contains: q } },
  ];
  // Телефон зберігається як +380671234567, а оператор вводить «067 123» —
  // тому шукаємо по цифрах без 0 / 380 на початку.
  let digits = q.replace(/\D/g, '');
  if (digits.startsWith('380')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length >= 3) or.push({ phone: { contains: digits } });
  return { OR: or };
}

export function buildLeadWhere(query: ListQuery, now: Date = new Date()): Prisma.LeadWhereInput {
  const and: Prisma.LeadWhereInput[] = [];
  const { startToday, startTomorrow, weekEnd } = kyivBounds(now);

  if (query.q) and.push(searchWhere(query.q));
  if (query.stage.length) and.push({ stage: { in: query.stage } });
  if (query.tag) and.push({ tags: { has: query.tag } });
  if (query.priority.length) and.push({ priority: { in: query.priority } });
  if (query.city) and.push({ city: { equals: query.city, mode: 'insensitive' } });
  if (query.source) and.push({ source: query.source });

  // Фільтри за терміном стосуються лише активних лідів: у клієнта чи
  // відмови «наступного кроку» вже немає, навіть якщо дата лишилась.
  if (query.due === 'overdue') {
    and.push({ stage: { in: ACTIVE_STAGES }, nextActionAt: { lt: startToday } });
  } else if (query.due === 'today') {
    and.push({ stage: { in: ACTIVE_STAGES }, nextActionAt: { gte: startToday, lt: startTomorrow } });
  } else if (query.due === 'week') {
    and.push({ stage: { in: ACTIVE_STAGES }, nextActionAt: { gte: startToday, lt: weekEnd } });
  } else if (query.due === 'none') {
    and.push({ stage: { in: ACTIVE_STAGES }, nextActionAt: null });
  }

  return and.length ? { AND: and } : {};
}

function buildOrderBy(sort: ListQuery['sort']): Prisma.LeadOrderByWithRelationInput[] {
  switch (sort) {
    case 'nextActionAt':
      // Ліди без дати — в кінці: перші рядки мають бути найтерміновішими.
      return [{ nextActionAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }];
    case 'priority':
      return [{ priority: 'asc' }, { name: 'asc' }, { id: 'asc' }];
    case 'name':
      return [{ name: 'asc' }, { id: 'asc' }];
    case 'courts':
      return [{ courtsCount: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }, { id: 'asc' }];
    default:
      return [{ updatedAt: 'desc' }, { id: 'asc' }];
  }
}

function zeroStages(): Record<LeadStage, number> {
  return Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<LeadStage, number>;
}

/**
 * GET /api/platform/leads
 *
 * Фасети (stages, cities, tags, priorities) рахуються по всій таблиці, а
 * не по відфільтрованій вибірці: вкладки етапів мають показувати стабільні
 * числа, а списки міст і тегів — усі доступні варіанти фільтра.
 */
platformCrmRouter.get('/leads', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const query = parsed.data;
  const now = new Date();
  const { startToday } = kyivBounds(now);

  const where = buildLeadWhere(query, now);

  const [rows, total, plans, stageGroups, cityGroups, tagRows, priorityGroups] = await Promise.all([
    prisma.lead.findMany({
      where,
      orderBy: buildOrderBy(query.sort),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.lead.count({ where }),
    prisma.plan.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { tier: 'asc' }],
      select: { code: true, name: true, price: true },
    }),
    prisma.lead.groupBy({ by: ['stage'], _count: { _all: true } }),
    prisma.lead.groupBy({
      by: ['city'],
      where: { city: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { city: 'desc' } },
      take: 30,
    }),
    // Теги — масив: у таблиці 1–5 тис. рядків, тому простіше порахувати в JS,
    // ніж тягнути сирий SQL з unnest.
    prisma.lead.findMany({ where: { tags: { isEmpty: false } }, select: { tags: true } }),
    prisma.lead.groupBy({ by: ['priority'], _count: { _all: true } }),
  ]);

  const stages = zeroStages();
  for (const g of stageGroups) stages[g.stage] = g._count._all;

  const tagCounts = new Map<string, number>();
  for (const r of tagRows) for (const t of r.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const tags = [...tagCounts.entries()]
    .map(([tag, n]) => ({ tag, n }))
    .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag))
    .slice(0, 50);

  const priorities: Record<string, number> = { A: 0, B: 0, C: 0 };
  for (const g of priorityGroups) priorities[g.priority] = g._count._all;

  const items = rows.map((lead) => {
    const active = ACTIVE_STAGES.includes(lead.stage);
    return {
      ...serializeLead(lead),
      // Ціна залежить від кількості кортів (courtPrice) — показуємо по
      // кожному плану в продажу, щоб оператор на дзвінку одразу мав цифру.
      estimatedPrice: plans.map((p) => ({
        code: p.code,
        name: p.name,
        price: courtPrice(p.price, lead.courtsCount),
      })),
      customQuote: isCustomQuote(lead.courtsCount),
      overdue: active && lead.nextActionAt != null && lead.nextActionAt < startToday,
      noNextAction: active && lead.nextActionAt == null,
    };
  });

  res.json({
    items,
    total,
    page: query.page,
    pageSize: query.pageSize,
    facets: {
      stages,
      cities: cityGroups.filter((g) => g.city).map((g) => ({ city: g.city as string, n: g._count._all })),
      tags,
      priorities,
    },
  });
});

/**
 * GET /api/platform/leads/stats — цифри для шапки CRM.
 * Реєструється ДО /leads/:id, інакше «stats» вважався б id.
 */
platformCrmRouter.get('/leads/stats', async (_req, res) => {
  const now = new Date();
  const { startToday, startTomorrow } = kyivBounds(now);
  const day = 24 * 60 * 60 * 1000;

  const [stageGroups, overdue, today, noNextAction, createdLast7, wonLast30] = await Promise.all([
    prisma.lead.groupBy({ by: ['stage'], _count: { _all: true } }),
    prisma.lead.count({ where: { stage: { in: ACTIVE_STAGES }, nextActionAt: { lt: startToday } } }),
    prisma.lead.count({
      where: { stage: { in: ACTIVE_STAGES }, nextActionAt: { gte: startToday, lt: startTomorrow } },
    }),
    prisma.lead.count({ where: { stage: { in: ACTIVE_STAGES }, nextActionAt: null } }),
    prisma.lead.count({ where: { createdAt: { gte: new Date(now.getTime() - 7 * day) } } }),
    // Окремої дати «виграно» немає: updatedAt ліда з етапом WON — найближче
    // наближення (після конверсії лід рідко редагують).
    prisma.lead.count({ where: { stage: 'WON', updatedAt: { gte: new Date(now.getTime() - 30 * day) } } }),
  ]);

  const byStage = zeroStages();
  for (const g of stageGroups) byStage[g.stage] = g._count._all;

  res.json({ byStage, overdue, today, noNextAction, createdLast7, wonLast30 });
});

/* -------------------------------------------------------------------------- */
/* ІМПОРТ                                                                     */
/* -------------------------------------------------------------------------- */

const importSchema = z.object({
  // Елементи перевіряє mapImportRow: один поганий рядок не має валити файл.
  rows: z.array(z.unknown()).min(1).max(1000),
  source: z.string().trim().min(1).max(50).optional(),
  dryRun: z.boolean().optional(),
});

/**
 * POST /api/platform/leads/import
 *
 * Дедуплікація: спершу за ЄДРПОУ, інакше за нормалізованим телефоном. Для
 * наявного ліда дописуємо лише порожні поля (buildFillPatch) — етап,
 * теги, примітки й наступний крок оператора повторний імпорт не чіпає.
 * dryRun проходить той самий код, але нічого не пише.
 */
platformCrmRouter.post('/leads/import', async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const { rows, dryRun = false } = parsed.data;
  const source = parsed.data.source ?? 'youcontrol';

  const errors: { index: number; error: string }[] = [];
  const mapped: LeadImportData[] = [];
  rows.forEach((raw, index) => {
    const r = mapImportRow(raw, source);
    if (r.ok) mapped.push(r.data);
    else errors.push({ index, error: r.error });
  });

  const edrpous = [...new Set(mapped.map((d) => d.edrpou).filter((v): v is string => !!v))];
  const phones = [...new Set(mapped.map((d) => d.phone).filter((v): v is string => !!v))];

  // Два батчі замість запиту на кожен рядок: файл до 1000 рядків.
  const or: Prisma.LeadWhereInput[] = [];
  if (edrpous.length) or.push({ edrpou: { in: edrpous } });
  if (phones.length) or.push({ phone: { in: phones } });
  const existing = or.length ? await prisma.lead.findMany({ where: { OR: or } }) : [];

  const byEdrpou = new Map<string, (typeof existing)[number]>();
  const byPhone = new Map<string, (typeof existing)[number]>();
  for (const l of existing) {
    if (l.edrpou) byEdrpou.set(l.edrpou, l);
    if (l.phone && !byPhone.has(l.phone)) byPhone.set(l.phone, l);
  }

  const seen = new Set<string>();
  const touched = new Set<string>();
  const toCreate: Prisma.LeadCreateManyInput[] = [];
  const toUpdate: { id: string; patch: Record<string, unknown> }[] = [];
  let skipped = 0;

  for (const d of mapped) {
    // Дубль усередині самого файлу. Телефон перевіряємо лише для рядків без
    // ЄДРПОУ: різні юрособи мережі можуть ділити один номер.
    const eKey = d.edrpou ? `e:${d.edrpou}` : null;
    const pKey = d.phone ? `p:${d.phone}` : null;
    if ((eKey && seen.has(eKey)) || (!eKey && pKey && seen.has(pKey))) {
      skipped++;
      continue;
    }
    if (eKey) seen.add(eKey);
    if (pKey) seen.add(pKey);

    let ex = d.edrpou ? byEdrpou.get(d.edrpou) : undefined;
    if (!ex && d.phone) {
      const cand = byPhone.get(d.phone);
      // Наявний лід з ІНШИМ ЄДРПОУ на тому ж телефоні — інша юрособа, не дубль.
      if (cand && (!d.edrpou || !cand.edrpou)) ex = cand;
    }

    if (ex) {
      if (touched.has(ex.id)) {
        skipped++;
        continue;
      }
      touched.add(ex.id);
      const patch = buildFillPatch(ex, d);
      if (Object.keys(patch).length === 0) skipped++;
      else toUpdate.push({ id: ex.id, patch });
      continue;
    }

    const { priority, ...rest } = d;
    toCreate.push({ ...rest, priority: priority ?? 'B' });
  }

  let created = toCreate.length;
  const updated = toUpdate.length;

  if (!dryRun && (toCreate.length || toUpdate.length)) {
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    if (toCreate.length) ops.push(prisma.lead.createMany({ data: toCreate, skipDuplicates: true }));
    for (const u of toUpdate) {
      ops.push(prisma.lead.update({ where: { id: u.id }, data: u.patch as Prisma.LeadUncheckedUpdateInput }));
    }
    const results = await prisma.$transaction(ops);
    if (toCreate.length) {
      // skipDuplicates міг відкинути рядки, що з'явились між читанням і записом.
      const real = (results[0] as { count?: number } | undefined)?.count;
      if (typeof real === 'number') {
        skipped += created - real;
        created = real;
      }
    }
  }

  res.json({ created, updated, skipped, errors, dryRun });
});

/* -------------------------------------------------------------------------- */
/* ЛІДИ: CRUD                                                                 */
/* -------------------------------------------------------------------------- */

platformCrmRouter.get('/leads/:id', async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!idParam(req)) return res.status(404).json({ error: 'NOT_FOUND' });

  const lead = await prisma.lead.findUnique({
    where: { id },
    include: {
      activities: { orderBy: { createdAt: 'desc' }, take: 100 },
      club: { select: { id: true, name: true, slug: true } },
    },
  });
  if (!lead) return res.status(404).json({ error: 'NOT_FOUND' });

  res.json(serializeLead(lead));
});

platformCrmRouter.post('/leads', async (req, res) => {
  const parsed = createLeadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const data = toLeadData(parsed.data);
  if (data.stage === 'LOST' && !parsed.data.lostReason) {
    return res.status(400).json({ error: 'LOST_REASON_REQUIRED' });
  }

  try {
    const lead = await prisma.lead.create({ data: data as Prisma.LeadUncheckedCreateInput });
    res.status(201).json(serializeLead(lead));
  } catch (e) {
    if (isUniqueViolation(e)) return res.status(409).json({ error: 'EDRPOU_TAKEN' });
    throw e;
  }
});

platformCrmRouter.patch('/leads/:id', async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!idParam(req)) return res.status(404).json({ error: 'NOT_FOUND' });

  const parsed = patchLeadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const existing = await prisma.lead.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  const data = toLeadData(parsed.data);
  const nextStage = (parsed.data.stage ?? existing.stage) as LeadStage;
  const nextLostReason =
    parsed.data.lostReason !== undefined ? parsed.data.lostReason : existing.lostReason;

  // Відмова без причини робить воронку непридатною для аналізу: потім не
  // видно, чому ми програємо. Перевіряємо підсумковий стан, а не лише зміну.
  if (nextStage === 'LOST' && !nextLostReason?.trim()) {
    return res.status(400).json({ error: 'LOST_REASON_REQUIRED' });
  }

  const stageChanged = parsed.data.stage !== undefined && parsed.data.stage !== existing.stage;

  try {
    const ops: Prisma.PrismaPromise<unknown>[] = [prisma.lead.update({ where: { id }, data })];
    if (stageChanged) {
      ops.push(
        prisma.crmActivity.create({
          data: {
            leadId: id,
            kind: 'SYSTEM',
            text: `Етап: ${STAGE_LABEL[existing.stage]} → ${STAGE_LABEL[nextStage]}`,
            author: operator(req),
          },
        }),
      );
    }
    const [lead] = (await prisma.$transaction(ops)) as [Awaited<ReturnType<typeof prisma.lead.update>>];
    res.json(serializeLead(lead));
  } catch (e) {
    if (isUniqueViolation(e)) return res.status(409).json({ error: 'EDRPOU_TAKEN' });
    throw e;
  }
});

platformCrmRouter.delete('/leads/:id', async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!idParam(req)) return res.status(404).json({ error: 'NOT_FOUND' });

  const existing = await prisma.lead.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  // Журнал ліда видалиться каскадом (onDelete: Cascade), клуб не постраждає.
  await prisma.lead.delete({ where: { id } });
  res.status(204).end();
});

/* -------------------------------------------------------------------------- */
/* КОНВЕРСІЯ ЛІДА В КЛУБ                                                      */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/platform/leads/:id/convert  { clubId }
 *
 * Лід купив: зв'язуємо з Club, ставимо WON і переносимо місто й теги в
 * клуб — але лише туди, де в клубу порожньо, щоб не затерти те, що
 * власник клубу чи оператор уже виправили вручну.
 */
platformCrmRouter.post('/leads/:id/convert', async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!idParam(req)) return res.status(404).json({ error: 'LEAD_NOT_FOUND' });

  const parsed = z.object({ clubId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const { clubId } = parsed.data;

  const [lead, club, holder] = await Promise.all([
    prisma.lead.findUnique({ where: { id } }),
    prisma.club.findUnique({ where: { id: clubId }, select: { id: true, name: true, city: true, crmTags: true } }),
    prisma.lead.findUnique({ where: { clubId }, select: { id: true } }),
  ]);
  if (!lead) return res.status(404).json({ error: 'LEAD_NOT_FOUND' });
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });
  if (holder && holder.id !== lead.id) return res.status(409).json({ error: 'CLUB_ALREADY_LINKED' });

  const clubData: Prisma.ClubUpdateInput = {};
  if (!club.city?.trim() && lead.city) clubData.city = lead.city;
  if (club.crmTags.length === 0 && lead.tags.length) clubData.crmTags = lead.tags;

  const author = operator(req);
  try {
    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.lead.update({ where: { id }, data: { clubId, stage: 'WON' } }),
      prisma.crmActivity.create({
        data: { leadId: id, kind: 'SYSTEM', text: `Конверсія: привʼязано клуб «${club.name}»`, author },
      }),
      prisma.crmActivity.create({
        data: { clubId, kind: 'SYSTEM', text: `Клуб привʼязано до ліда «${lead.name}»`, author },
      }),
    ];
    if (Object.keys(clubData).length) ops.push(prisma.club.update({ where: { id: clubId }, data: clubData }));

    const [updated] = (await prisma.$transaction(ops)) as [Awaited<ReturnType<typeof prisma.lead.update>>];
    res.json(serializeLead(updated));
  } catch (e) {
    // Гонка: інший запит встиг привʼязати клуб між перевіркою й записом.
    if (isUniqueViolation(e)) return res.status(409).json({ error: 'CLUB_ALREADY_LINKED' });
    throw e;
  }
});

/* -------------------------------------------------------------------------- */
/* ЖУРНАЛ ДІЙ                                                                 */
/* -------------------------------------------------------------------------- */

const activitySchema = z.object({
  // SYSTEM пишуть лише самі ендпоінти — оператор не має підробляти системні записи.
  kind: z.enum(['NOTE', 'CALL', 'MESSAGE', 'MEETING', 'DEMO', 'TASK']),
  text: z.string().trim().min(1).max(2000),
  dueAt: dateInput.nullable().optional(),
});

const activityPatchSchema = z.object({
  text: z.string().trim().min(1).max(2000).optional(),
  dueAt: dateInput.nullable().optional(),
  done: z.boolean().optional(),
});

platformCrmRouter.post('/leads/:id/activities', async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!idParam(req)) return res.status(404).json({ error: 'NOT_FOUND' });

  const parsed = activitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const { kind, text: body, dueAt } = parsed.data;

  // Задача без терміну не потрапить у «Сьогодні» й загубиться.
  if (kind === 'TASK' && !dueAt) return res.status(400).json({ error: 'DUE_REQUIRED' });

  const lead = await prisma.lead.findUnique({ where: { id }, select: { id: true, stage: true } });
  if (!lead) return res.status(404).json({ error: 'NOT_FOUND' });

  const author = operator(req);
  const ops: Prisma.PrismaPromise<unknown>[] = [
    prisma.crmActivity.create({ data: { leadId: id, kind, text: body, dueAt: dueAt ?? null, author } }),
  ];

  if (CONTACT_KINDS.includes(kind)) {
    const leadData: Prisma.LeadUncheckedUpdateInput = { lastContactAt: new Date() };
    // Дзвінок чи зустріч із «новим» лідом — це вже контакт; оператор не
    // мусить окремо тягнути картку на наступний етап.
    const autoMove = lead.stage === 'NEW' || lead.stage === 'CHECKING';
    if (autoMove) leadData.stage = 'CONTACTED';
    ops.push(prisma.lead.update({ where: { id }, data: leadData }));
    if (autoMove) {
      ops.push(
        prisma.crmActivity.create({
          data: {
            leadId: id,
            kind: 'SYSTEM',
            text: `Етап: ${STAGE_LABEL[lead.stage]} → ${STAGE_LABEL.CONTACTED}`,
            author,
          },
        }),
      );
    }
  }

  const [activity] = await prisma.$transaction(ops);
  res.status(201).json(activity);
});

platformCrmRouter.get('/clubs/:id/activities', async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!idParam(req)) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });

  const club = await prisma.club.findUnique({ where: { id }, select: { id: true } });
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });

  const items = await prisma.crmActivity.findMany({
    where: { clubId: id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ items });
});

platformCrmRouter.post('/clubs/:id/activities', async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!idParam(req)) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });

  const parsed = activitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const { kind, text: body, dueAt } = parsed.data;

  if (kind === 'TASK' && !dueAt) return res.status(400).json({ error: 'DUE_REQUIRED' });

  const club = await prisma.club.findUnique({ where: { id }, select: { id: true } });
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });

  const activity = await prisma.crmActivity.create({
    data: { clubId: id, kind, text: body, dueAt: dueAt ?? null, author: operator(req) },
  });
  res.status(201).json(activity);
});

platformCrmRouter.patch('/activities/:id', async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!idParam(req)) return res.status(404).json({ error: 'NOT_FOUND' });

  const parsed = activityPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const existing = await prisma.crmActivity.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });
  // Системний запис — свідчення того, що сталось; правити його не можна.
  if (existing.kind === 'SYSTEM') return res.status(409).json({ error: 'SYSTEM_ENTRY' });

  const { text: newText, dueAt, done } = parsed.data;
  if (existing.kind === 'TASK' && dueAt === null) {
    return res.status(400).json({ error: 'DUE_REQUIRED' });
  }

  const data: Prisma.CrmActivityUncheckedUpdateInput = {};
  if (newText !== undefined) data.text = newText;
  if (dueAt !== undefined) data.dueAt = dueAt;
  if (done !== undefined) data.doneAt = done ? new Date() : null;

  const activity = await prisma.crmActivity.update({ where: { id }, data });
  res.json(activity);
});

platformCrmRouter.delete('/activities/:id', async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!idParam(req)) return res.status(404).json({ error: 'NOT_FOUND' });

  const existing = await prisma.crmActivity.findUnique({ where: { id }, select: { id: true, kind: true } });
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });
  if (existing.kind === 'SYSTEM') return res.status(409).json({ error: 'SYSTEM_ENTRY' });

  await prisma.crmActivity.delete({ where: { id } });
  res.status(204).end();
});

/* -------------------------------------------------------------------------- */
/* ЗАДАЧІ                                                                     */
/* -------------------------------------------------------------------------- */

type TaskItem = {
  type: 'task' | 'nextAction';
  id: string;
  text: string;
  dueAt: Date | null;
  lead?: { id: string; name: string; stage: LeadStage; phone: string | null };
  club?: { id: string; name: string };
};

/**
 * GET /api/platform/tasks?scope=overdue|today|week|all
 *
 * Одна стрічка «що робити» з двох джерел: відкриті задачі (CrmActivity
 * TASK) і «наступні кроки» активних лідів (Lead.nextAction) — другі
 * віртуальні задачі, окремого запису в журналі вони не мають. Обсяг малий
 * (лише відкриті), тому фільтруємо й рахуємо лічильники в пам'яті одним
 * проходом, щоб лічильники завжди збігались зі списком.
 */
platformCrmRouter.get('/tasks', async (req, res) => {
  const parsed = z
    .object({ scope: z.enum(['overdue', 'today', 'week', 'all']).default('all') })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const { scope } = parsed.data;

  const { startToday, startTomorrow, weekEnd } = kyivBounds();

  const [activities, leads] = await Promise.all([
    prisma.crmActivity.findMany({
      where: { kind: 'TASK', doneAt: null },
      include: {
        lead: { select: { id: true, name: true, stage: true, phone: true } },
        club: { select: { id: true, name: true } },
      },
      orderBy: { dueAt: 'asc' },
      take: 2000,
    }),
    prisma.lead.findMany({
      where: { stage: { in: ACTIVE_STAGES }, nextActionAt: { not: null } },
      select: { id: true, name: true, stage: true, phone: true, nextAction: true, nextActionAt: true },
      orderBy: { nextActionAt: 'asc' },
      take: 5000,
    }),
  ]);

  const all: TaskItem[] = [
    ...activities.map((a): TaskItem => ({
      type: 'task',
      id: a.id,
      text: a.text,
      dueAt: a.dueAt,
      ...(a.lead ? { lead: a.lead } : {}),
      ...(a.club ? { club: a.club } : {}),
    })),
    ...leads.map((l): TaskItem => ({
      type: 'nextAction',
      id: l.id,
      text: l.nextAction?.trim() || 'Наступний крок',
      dueAt: l.nextActionAt,
      lead: { id: l.id, name: l.name, stage: l.stage, phone: l.phone },
    })),
  ];

  const isOverdue = (d: Date | null) => d != null && d < startToday;
  const isToday = (d: Date | null) => d != null && d >= startToday && d < startTomorrow;
  const isWeek = (d: Date | null) => d != null && d >= startToday && d < weekEnd;

  const counts = {
    overdue: all.filter((t) => isOverdue(t.dueAt)).length,
    today: all.filter((t) => isToday(t.dueAt)).length,
    week: all.filter((t) => isWeek(t.dueAt)).length,
  };

  const pass: Record<typeof scope, (t: TaskItem) => boolean> = {
    overdue: (t) => isOverdue(t.dueAt),
    today: (t) => isToday(t.dueAt),
    week: (t) => isWeek(t.dueAt),
    all: () => true,
  };

  // Без терміну (для TASK його вимагає API, але старі записи можливі) — в кінець.
  const items = all
    .filter(pass[scope])
    .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity));

  res.json({ items, counts });
});
