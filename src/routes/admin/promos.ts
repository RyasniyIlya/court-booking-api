import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { calendarDateText, dateOnly } from '../../lib/birthday';
import { MAX_PERCENT, MAX_BIRTHDAY_DAYS } from '../../lib/promo';
import { requireAuth, requireStaff, param } from './shared';

/**
 * /api/admin/promos — конструктор акцій клубу.
 *
 * Три види правил в одній таблиці: «щасливі години» по днях тижня, акційні
 * дні (свята, відкриття сезону) і вікно навколо дня народження гравця.
 * Ціну по цих правилах рахує src/lib/promo.ts при створенні броні —
 * кабінет лише заводить правила й показує очікувану ціну.
 *
 * Перевірки тут дублюють і CHECK-констрейнти міграції, і promoErrors у
 * кабінеті. Це не зайве: акція з порожнім списком днів зберігається без
 * помилки і просто ніколи не спрацьовує — найгірший вид поломки, бо клуб
 * дізнається про неї з виторгу наприкінці місяця.
 */
export const promosRouter = Router();

const KINDS = ['WEEKLY', 'DATES', 'BIRTHDAY'] as const;
const DISCOUNTS = ['PERCENT', 'PRICE'] as const;

const promoShape = {
  title: z.string().trim().min(2).max(80),
  kind: z.enum(KINDS),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  dateFrom: calendarDateText.nullable(),
  dateTo: calendarDateText.nullable(),
  daysBefore: z.number().int().min(0).max(MAX_BIRTHDAY_DAYS),
  daysAfter: z.number().int().min(0).max(MAX_BIRTHDAY_DAYS),
  startMinute: z.number().int().min(0).max(1440),
  endMinute: z.number().int().min(1).max(1440),
  discountType: z.enum(DISCOUNTS),
  /** PERCENT: відсотки. PRICE: копійки за годину. Межі — в ruleProblem. */
  discountValue: z.number().int().min(0).max(100_000_000),
  courtIds: z.array(z.string().uuid()).max(200),
  isActive: z.boolean(),
};

const createSchema = z.object({
  ...promoShape,
  weekdays: promoShape.weekdays.default([]),
  dateFrom: promoShape.dateFrom.default(null),
  dateTo: promoShape.dateTo.default(null),
  daysBefore: promoShape.daysBefore.default(0),
  daysAfter: promoShape.daysAfter.default(0),
  courtIds: promoShape.courtIds.default([]),
  isActive: promoShape.isActive.default(true),
});

const patchSchema = z.object(promoShape).partial();

type Rule = {
  kind: (typeof KINDS)[number];
  weekdays: number[];
  dateFrom: string | null;
  dateTo: string | null;
  daysBefore: number;
  daysAfter: number;
  startMinute: number;
  endMinute: number;
  discountType: (typeof DISCOUNTS)[number];
  discountValue: number;
};

/**
 * Що не так із правилом у цілому — після злиття патча з тим, що вже в базі.
 * Окремі поля валідні самі по собі; ламається їхнє поєднання.
 */
function ruleProblem(rule: Rule): string | null {
  if (rule.endMinute <= rule.startMinute) return 'BAD_TIME_WINDOW';

  if (rule.discountType === 'PERCENT') {
    if (rule.discountValue <= 0 || rule.discountValue > MAX_PERCENT) return 'BAD_DISCOUNT';
  } else if (rule.discountValue <= 0) {
    return 'BAD_DISCOUNT';
  }

  if (rule.kind === 'WEEKLY') {
    const unique = new Set(rule.weekdays);
    if (unique.size === 0) return 'BAD_WEEKDAYS';
  }

  if (rule.kind === 'DATES') {
    if (!rule.dateFrom || !rule.dateTo) return 'BAD_DATES';
    if (rule.dateTo < rule.dateFrom) return 'BAD_DATES';
  }

  /* Для BIRTHDAY 0/0 — допустимо: акція рівно в день народження. */
  return null;
}

/** Дати віддаємо як 'YYYY-MM-DD': кабінет кладе їх у input[type=date]. */
const toApi = (p: {
  dateFrom: Date | null;
  dateTo: Date | null;
}) => ({ ...p, dateFrom: dateOnly(p.dateFrom), dateTo: dateOnly(p.dateTo) });

const asDate = (raw: string | null | undefined) =>
  (raw ? new Date(`${raw}T00:00:00.000Z`) : null);

/** Корти чужого клубу в правилі означали б знижку, якої ніхто не побачить. */
async function foreignCourt(clubId: string, courtIds: string[]): Promise<boolean> {
  if (courtIds.length === 0) return false;
  const mine = await prisma.court.count({
    where: { clubId, id: { in: courtIds } },
  });
  return mine !== new Set(courtIds).size;
}

promosRouter.get('/promos', requireAuth, async (req, res) => {
  const promos = await prisma.promo.findMany({
    where: { clubId: req.auth!.clubId },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
  });

  res.json(promos.map(toApi));
});

promosRouter.post('/promos', requireAuth, requireStaff, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const data = parsed.data;
  const problem = ruleProblem(data);
  if (problem) return res.status(400).json({ error: problem });

  if (await foreignCourt(req.auth!.clubId, data.courtIds)) {
    return res.status(404).json({ error: 'COURT_NOT_FOUND' });
  }

  const promo = await prisma.promo.create({
    data: {
      clubId: req.auth!.clubId,
      title: data.title,
      kind: data.kind,
      /* Дні тижня чужого виду правила зберігати нема сенсу: акція на день
         народження з рештками «Пн, Вт» у базі читалась би як помилка. */
      weekdays: data.kind === 'WEEKLY' ? [...new Set(data.weekdays)].sort() : [],
      dateFrom: data.kind === 'DATES' ? asDate(data.dateFrom) : null,
      dateTo: data.kind === 'DATES' ? asDate(data.dateTo) : null,
      daysBefore: data.kind === 'BIRTHDAY' ? data.daysBefore : 0,
      daysAfter: data.kind === 'BIRTHDAY' ? data.daysAfter : 0,
      startMinute: data.startMinute,
      endMinute: data.endMinute,
      discountType: data.discountType,
      discountValue: data.discountValue,
      courtIds: [...new Set(data.courtIds)],
      isActive: data.isActive,
    },
  });

  res.status(201).json(toApi(promo));
});

promosRouter.patch('/promos/:id', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().safeParse(param(req, 'id'));
  if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const current = await prisma.promo.findFirst({
    where: { id: id.data, clubId: req.auth!.clubId },
  });
  if (!current) return res.status(404).json({ error: 'NOT_FOUND' });

  const patch = parsed.data;
  /* Вмикання однією галочкою («Вимкнути» в списку) не має спотикатись об
     правило, яке лежить у базі з тих часів, коли перевірки були іншими —
     але й зберігати завідомо мертву акцію ми не хочемо. Тому міряємо саме
     те, що вийде після злиття. */
  const merged: Rule = {
    kind: patch.kind ?? current.kind,
    weekdays: patch.weekdays ?? current.weekdays,
    dateFrom: patch.dateFrom !== undefined ? patch.dateFrom : dateOnly(current.dateFrom),
    dateTo: patch.dateTo !== undefined ? patch.dateTo : dateOnly(current.dateTo),
    daysBefore: patch.daysBefore ?? current.daysBefore,
    daysAfter: patch.daysAfter ?? current.daysAfter,
    startMinute: patch.startMinute ?? current.startMinute,
    endMinute: patch.endMinute ?? current.endMinute,
    discountType: patch.discountType ?? current.discountType,
    discountValue: patch.discountValue ?? current.discountValue,
  };

  const problem = ruleProblem(merged);
  if (problem) return res.status(400).json({ error: problem });

  const courtIds = patch.courtIds ? [...new Set(patch.courtIds)] : undefined;
  if (courtIds && (await foreignCourt(req.auth!.clubId, courtIds))) {
    return res.status(404).json({ error: 'COURT_NOT_FOUND' });
  }

  const promo = await prisma.promo.update({
    where: { id: id.data },
    data: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      ...(courtIds ? { courtIds } : {}),
      kind: merged.kind,
      weekdays: merged.kind === 'WEEKLY' ? [...new Set(merged.weekdays)].sort() : [],
      dateFrom: merged.kind === 'DATES' ? asDate(merged.dateFrom) : null,
      dateTo: merged.kind === 'DATES' ? asDate(merged.dateTo) : null,
      daysBefore: merged.kind === 'BIRTHDAY' ? merged.daysBefore : 0,
      daysAfter: merged.kind === 'BIRTHDAY' ? merged.daysAfter : 0,
      startMinute: merged.startMinute,
      endMinute: merged.endMinute,
      discountType: merged.discountType,
      discountValue: merged.discountValue,
    },
  });

  res.json(toApi(promo));
});

promosRouter.delete('/promos/:id', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().safeParse(param(req, 'id'));
  if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const result = await prisma.promo.deleteMany({
    where: { id: id.data, clubId: req.auth!.clubId },
  });
  if (result.count === 0) return res.status(404).json({ error: 'NOT_FOUND' });

  res.json({ ok: true });
});
