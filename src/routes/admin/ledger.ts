import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { recordChanges } from '../../lib/changeLog';
import {
  LEDGER_ENTRY_SELECT, dayRange, ledgerCsv, ledgerFacets, ledgerFileName, ledgerSummary,
} from '../../lib/cashdesk';
import { requireAuth, requireStaff } from './shared';

export const ledgerRouter = Router();

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** Стеля CSV: більше — просимо вужчий період, а не віддаємо обрізаний файл. */
const CSV_MAX_ROWS = 20_000;

const ledgerQuery = z.object({
  from: z.string().regex(DATE_ONLY),
  to: z.string().regex(DATE_ONLY),
  method: z.string().trim().min(1).max(40).optional(),
  kind: z.string().trim().min(1).max(40).optional(),
  account: z.string().trim().min(1).max(200).optional(),
  actor: z.string().trim().min(1).max(200).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).catch(100),
  format: z.enum(['json', 'csv']).catch('json'),
});

/**
 * GET /api/admin/ledger — журнал каси за період.
 *
 * Відповідь — сторінка операцій (`items`, за курсором) і зведення по ВСІХ
 * відфільтрованих операціях періоду, а не лише по сторінці: сума над
 * таблицею не повинна змінюватись від того, скільки разів натиснули
 * «Показати ще».
 *
 * Доступ — як у /shift: власник і модератор. Бухгалтеру цього роута не
 * відкрито: увесь /api/admin/* закритий для нього вартовим blockAccountant, а
 * його касові звіти живуть в окремому /api/admin/finance (касова книга), де
 * вони вже є з вартовим плану й журналом вивантажень.
 *
 * `?format=csv` — той самий відбір файлом (UTF-8 з BOM, `;`).
 */
ledgerRouter.get('/ledger', requireAuth, requireStaff, async (req, res) => {
  const parsed = ledgerQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const q = parsed.data;
  const clubId = req.auth!.clubId;

  const club = await prisma.club.findUniqueOrThrow({ where: { id: clubId }, select: { name: true, timezone: true } });
  const range = dayRange(q.from, q.to, club.timezone);
  if (!range) return res.status(400).json({ error: 'BAD_PERIOD' });

  /* Рішення власника: модератор бачить лише власні операції. Клієнтський
     ?actor ігнорується — ім'я береться з акаунта, а не із запиту. */
  let ownEmail: string | null = null;
  if (req.auth!.role === 'ADMIN') {
    const me = await prisma.user.findFirst({ where: { id: req.auth!.userId, clubId }, select: { email: true } });
    if (!me) return res.status(404).json({ error: 'NOT_FOUND' });
    ownEmail = me.email;
  }
  const period = {
    clubId,
    createdAt: { gte: range.start, lt: range.endExclusive },
    ...(ownEmail ? { actorEmail: ownEmail } : {}),
  };
  const search = q.q
    ? {
      OR: [
        { note: { contains: q.q, mode: 'insensitive' as const } },
        { booking: { is: { customerName: { contains: q.q, mode: 'insensitive' as const } } } },
        { booking: { is: { title: { contains: q.q, mode: 'insensitive' as const } } } },
        { seat: { is: { customerName: { contains: q.q, mode: 'insensitive' as const } } } },
        { customer: { is: { name: { contains: q.q, mode: 'insensitive' as const } } } },
      ],
    }
    : {};
  const where = {
    ...period,
    ...(q.method ? { method: q.method } : {}),
    ...(q.kind ? { kind: q.kind } : {}),
    ...(q.account ? { account: q.account } : {}),
    ...(q.actor && !ownEmail ? { actorEmail: q.actor } : {}),
    ...search,
  };
  const order = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

  if (q.format === 'csv') {
    const actor = await prisma.user.findFirst({
      where: { id: req.auth!.userId, clubId }, select: { email: true },
    });
    if (!actor) return res.status(404).json({ error: 'NOT_FOUND' });

    const rows = await prisma.bookingLedgerEntry.findMany({
      where, orderBy: order, take: CSV_MAX_ROWS + 1, select: LEDGER_ENTRY_SELECT,
    });
    if (rows.length > CSV_MAX_ROWS) return res.status(413).json({ error: 'TOO_MANY_ROWS' });

    /* Файл з іменами клієнтів і сумами — слід у журналі змін, як і в інших
       вивантажень. Запис до відправки: той, що впав після, лишив би файл без сліду. */
    await recordChanges(
      prisma,
      { clubId, entity: 'LedgerExport', entityId: clubId },
      { userId: req.auth!.userId, email: actor.email, role: req.auth!.role },
      [{ field: 'export', before: null, after: { from: q.from, to: q.to, rows: rows.length } }],
    );

    const fileName = ledgerFileName(club.name, q.from, q.to);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ledger.csv"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    res.setHeader('Cache-Control', 'no-store');
    return res.send(ledgerCsv(rows, club.timezone));
  }

  const [page, agg, combos] = await Promise.all([
    prisma.bookingLedgerEntry.findMany({
      where,
      orderBy: order,
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: LEDGER_ENTRY_SELECT,
    }),
    prisma.bookingLedgerEntry.findMany({
      where,
      select: { kind: true, method: true, amount: true, account: true, actorEmail: true, actorRole: true, createdAt: true },
    }),
    /* Варіанти фільтрів — з усього періоду без поточних фільтрів: інакше
       вибравши «Готівка», людина б більше не побачила інших способів. */
    prisma.bookingLedgerEntry.groupBy({
      by: ['method', 'kind', 'account', 'actorEmail'],
      where: period,
    }),
  ]);

  const more = page.length > q.limit;
  const items = more ? page.slice(0, q.limit) : page;
  const summary = ledgerSummary(agg, club.timezone, range.days);

  res.json({
    items,
    ...summary,
    facets: ledgerFacets(combos),
    nextCursor: more ? items[items.length - 1].id : null,
  });
});
