import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { prisma } from '../lib/db';
import { requireAuth, requireRole, requireFeature } from './admin';
import { recordChanges } from '../lib/changeLog';
import { buildWorkbook, XLSX_CONTENT_TYPE } from '../lib/xlsx';
import {
  cashbookFileName,
  cashbookSheets,
  findDebts,
  groupDebtors,
  ledgerRows,
  onlineRows,
  passRows,
  summarize,
  type CashRow,
  type DebtInput,
} from '../lib/cashbook';
import { estimateTax, regimeLimitUsage, TAX_REGIMES, vatApplicable, type TaxRegime } from '../lib/taxRegime';
import { breakEven, monthlyPnl, trainerPayouts } from '../lib/financeReports';
import { loadLiabilityPasses } from '../lib/financeData';

/**
 * Фінанси для бухгалтера: касова книга, податок ФОП, боржники,
 * невідіграні абонементи, виплати тренерам, прибуток по місяцях.
 *
 * Окремо від analytics.ts, бо тут інша лінійка — рух грошей, а не зіграні
 * броні (див. lib/cashbook.ts). Доступ: власник, модератор і роль
 * ACCOUNTANT — той самий бухгалтер, якщо клуб завів йому окремий акаунт
 * (routes/admin/staff.ts), замість передавати вивантаження вручну. Файл
 * — лише власнику й бухгалтеру: модератор веде клуб щодня, але цілий
 * реєстр сум і клієнтів одним файлом — рішення, яке приймають вони двоє.
 */
export const financeRouter = Router();

financeRouter.use(requireAuth, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), requireFeature('analytics'));

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;

const rangeQuery = z.object({
  from: z.string().regex(DATE_ONLY).optional(),
  to: z.string().regex(DATE_ONLY).optional(),
});

/** Без дат — поточний місяць клубу. Перевернутий чи задовгий — null → 400. */
export function cashRange(q: z.infer<typeof rangeQuery>, tz: string, now: DateTime = DateTime.now()) {
  if (!q.from !== !q.to) return null;
  const start = q.from
    ? DateTime.fromISO(q.from, { zone: tz }).startOf('day')
    : now.setZone(tz).startOf('month');
  const end = q.to
    ? DateTime.fromISO(q.to, { zone: tz }).endOf('day')
    : now.setZone(tz).endOf('month');
  if (!start.isValid || !end.isValid || end < start) return null;
  if (end.diff(start, 'days').days > MAX_DAYS) return null;
  return { start, end };
}

const bookingBrief = {
  customerName: true, title: true, startTime: true, court: { select: { name: true } },
} as const;

/** Усі рядки каси за проміжок: журнал + онлайн + абонементи. */
async function loadCashRows(clubId: string, from: Date, to: Date, tz: string): Promise<CashRow[]> {
  const [ledger, payments, passes] = await Promise.all([
    prisma.bookingLedgerEntry.findMany({
      where: { clubId, createdAt: { gte: from, lte: to } },
      select: {
        id: true, createdAt: true, kind: true, method: true, amount: true, account: true, note: true,
        actorEmail: true, seatId: true,
        booking: { select: bookingBrief },
        seat: { select: { customerName: true } },
      },
    }),
    prisma.payment.findMany({
      where: {
        clubId,
        status: { in: ['PAID', 'REFUNDED'] },
        OR: [{ paidAt: { gte: from, lte: to } }, { refundedAt: { gte: from, lte: to } }],
      },
      select: {
        id: true, amount: true, status: true, provider: true, paidAt: true, refundedAt: true, seatId: true,
        booking: { select: bookingBrief },
        seat: { select: { customerName: true, booking: { select: { title: true, startTime: true } } } },
      },
    }),
    prisma.pass.findMany({
      where: { clubId, createdAt: { gte: from, lte: to } },
      select: {
        id: true, createdAt: true, price: true, type: true, totalSessions: true, payMethod: true, payAccount: true,
        customer: { select: { name: true } },
      },
    }),
  ]);

  return [
    ...ledgerRows(ledger, tz),
    ...onlineRows(payments, from, to, tz),
    ...passRows(passes),
  ];
}

/**
 * Від якого дня клуб веде журнал на ресепшені. До цього готівка й термінал
 * у системі не записувались — і звіт мусить це сказати, а не показати нуль.
 */
async function journalSince(clubId: string) {
  const first = await prisma.bookingLedgerEntry.findFirst({
    where: { clubId },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  return first?.createdAt ?? null;
}

/**
 * GET /api/admin/finance/cashbook?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Підсумки по способах, касах і днях, оцінка єдиного податку й військового
 * збору, використання річного ліміту ФОП і останні операції.
 */
financeRouter.get('/cashbook', async (req, res) => {
  const parsed = rangeQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const clubId = req.auth!.clubId;
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { timezone: true, taxRegime: true, vatPayer: true, taxFixedMonthly: true },
  });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

  const tz = club.timezone;
  const range = cashRange(parsed.data, tz);
  if (!range) return res.status(400).json({ error: 'BAD_PERIOD' });
  const from = range.start.toJSDate();
  const to = range.end.toJSDate();

  /* Ліміт — за календарний рік кінця періоду і до кінця періоду, а не до
     сьогодні: звіт за березень має показувати, скільки ліміту лишалось у
     березні. */
  const yearStart = range.end.startOf('year').toJSDate();

  const regime = club.taxRegime as TaxRegime;
  /* Витрати клубу читаємо лише для режимів «від прибутку»: фіксованим і
     режимам «від доходу» вони не потрібні, а запит — зайвий похід у базу. */
  const needsExpenses = regime === 'FOP_GENERAL' || regime === 'TOV_GENERAL';

  const [rows, yearRows, since, expenseRows] = await Promise.all([
    loadCashRows(clubId, from, to, tz),
    loadCashRows(clubId, yearStart, to, tz),
    journalSince(clubId),
    needsExpenses
      ? prisma.clubExpense.findMany({
        /* month — перше число місяця (@db.Date, UTC-північ): беремо всі
           місяці, яких період зачепив хоч одним днем, як і в /pnl. */
        where: {
          clubId,
          month: {
            gte: new Date(`${range.start.toFormat('yyyy-MM')}-01T00:00:00Z`),
            lte: new Date(`${range.end.toFormat('yyyy-MM')}-01T00:00:00Z`),
          },
        },
        select: { category: true, amount: true },
      })
      : Promise.resolve([]),
  ]);

  const summary = summarize(rows, tz, from, to);
  const yearNet = summarize(yearRows, tz, yearStart, yearStart).net;

  res.json({
    from: range.start.toFormat('yyyy-MM-dd'),
    to: range.end.toFormat('yyyy-MM-dd'),
    journalSince: since?.toISOString() ?? null,
    /* Період почався раніше, ніж журнал: готівка до цієї дати невідома. */
    partial: !since || since > from,
    summary,
    /* Сирі налаштування клубу — окремо від tax.regime/tax.vatPayer: ті вже
       ефективні (vatPayer форсовано в false там, де він не застосовний),
       а тут — те, що показати у формі редагування (FinanceSection для
       бухгалтера, ClubTab для решти персоналу): включно з taxFixedMonthly,
       якого в оцінці податку нема окремим полем. */
    regimeSettings: { taxRegime: club.taxRegime, vatPayer: club.vatPayer, taxFixedMonthly: club.taxFixedMonthly },
    tax: estimateTax({
      regime,
      vatPayer: club.vatPayer,
      taxFixedMonthly: club.taxFixedMonthly,
      income: summary.net,
      expenses: expenseRows,
      from,
      to,
      tz,
    }),
    limit: regimeLimitUsage(regime, yearNet, range.end.year),
    rows: [...rows].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 200),
  });
});

/**
 * GET /api/admin/finance/cashbook/export?from&to — .xlsx для бухгалтера.
 * Лише власник; кожне вивантаження лишає слід у журналі змін.
 */
financeRouter.get('/cashbook/export', requireRole('OWNER', 'ACCOUNTANT'), async (req, res) => {
  const parsed = rangeQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const clubId = req.auth!.clubId;
  const [club, actor] = await Promise.all([
    prisma.club.findUnique({ where: { id: clubId }, select: { name: true, timezone: true } }),
    prisma.user.findFirst({ where: { id: req.auth!.userId, clubId }, select: { email: true } }),
  ]);
  if (!club || !actor) return res.status(404).json({ error: 'NOT_FOUND' });

  const range = cashRange(parsed.data, club.timezone);
  if (!range) return res.status(400).json({ error: 'BAD_PERIOD' });
  const from = range.start.toJSDate();
  const to = range.end.toJSDate();

  const rows = await loadCashRows(clubId, from, to, club.timezone);
  const summary = summarize(rows, club.timezone, from, to);
  const meta = { clubName: club.name, timezone: club.timezone, from, to, now: new Date() };

  await recordChanges(
    prisma,
    { clubId, entity: 'CashbookExport', entityId: clubId },
    { userId: req.auth!.userId, email: actor.email, role: req.auth!.role },
    [{
      field: 'export',
      before: null,
      after: { from: range.start.toFormat('yyyy-MM-dd'), to: range.end.toFormat('yyyy-MM-dd'), rows: rows.length },
    }],
  );

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="cashbook.xlsx"; filename*=UTF-8''${encodeURIComponent(cashbookFileName(meta))}`,
  );
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
  return res.send(buildWorkbook(cashbookSheets(rows, summary, meta)));
});

const taxRegimeBody = z.object({
  taxRegime: z.enum(TAX_REGIMES as [TaxRegime, ...TaxRegime[]]).optional(),
  vatPayer: z.boolean().optional(),
  /* Копійки. Стеля — 100 000 грн/міс: щедро понад будь-яку реальну ставку
     ради, але не «довільне число» — захист від друкарської помилки на
     порядок (ввели 3 328 000 замість 33 280). */
  taxFixedMonthly: z.number().int().min(0).max(10_000_000).nullable().optional(),
});

/**
 * PATCH /api/admin/finance/tax-regime
 *
 * Податковий режим клубу: хто платить, чи платник ПДВ, чи є своя фіксована
 * ставка (для ФОП 1/2 групи — рада міняє її, типова цифра не завжди вірна).
 *
 * Доступ — ВЛАСНИК і БУХГАЛТЕР, не модератор: режим визначає бухгалтер
 * клубу, а не той, хто веде зміну. Тому окремий вартовий тут, вужчий за
 * router-рівневий requireRole('OWNER','ADMIN','ACCOUNTANT') вище —
 * модератор до цього ендпоінта не проходить, хоч решту каси й бачить.
 *
 * ChangeLog тут навмисно не пишеться: клубні налаштування (routes/admin/
 * club.ts, PATCH /club) його теж не пишуть — це не окрема поведінка для
 * податків, а той самий вибір, що й для решти реквізитів клубу.
 */
financeRouter.patch('/tax-regime', requireRole('OWNER', 'ACCOUNTANT'), async (req, res) => {
  const parsed = taxRegimeBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const clubId = req.auth!.clubId;
  const current = await prisma.club.findUnique({
    where: { id: clubId },
    select: { taxRegime: true, vatPayer: true, taxFixedMonthly: true },
  });
  if (!current) return res.status(404).json({ error: 'NOT_FOUND' });

  const regime = (parsed.data.taxRegime ?? current.taxRegime) as TaxRegime;
  /* Платник ПДВ має сенс лише для трьох режимів — для решти скидаємо в
     false примусово, а не 400-имо: клуб міг просто лишити стару галочку,
     перемикаючи режим, і не мусить про неї згадувати окремо. */
  const vatPayer = vatApplicable(regime) ? (parsed.data.vatPayer ?? current.vatPayer) : false;

  const data: { taxRegime?: TaxRegime; vatPayer?: boolean; taxFixedMonthly?: number | null } = {};
  if (parsed.data.taxRegime !== undefined) data.taxRegime = parsed.data.taxRegime;
  if (vatPayer !== current.vatPayer) data.vatPayer = vatPayer;
  if (parsed.data.taxFixedMonthly !== undefined) data.taxFixedMonthly = parsed.data.taxFixedMonthly;

  const club = await prisma.club.update({ where: { id: clubId }, data });

  res.json({
    taxRegime: club.taxRegime,
    vatPayer: club.vatPayer,
    taxFixedMonthly: club.taxFixedMonthly,
  });
});

const debtorsQuery = z.object({
  days: z.coerce.number().int().min(1).max(366).default(90),
});

/**
 * GET /api/admin/finance/debtors?days=90
 *
 * Зіграні підтверджені броні й місця в групах, за які отримано менше ціни.
 * Рахуємо тільки від першого запису в журналі: до нього клуб брав гроші
 * повз систему, і кожна стара бронь виглядала б боргом.
 * Броні, списані з абонемента, боргом не є.
 */
financeRouter.get('/debtors', async (req, res) => {
  const parsed = debtorsQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const clubId = req.auth!.clubId;
  const since = await journalSince(clubId);
  if (!since) {
    return res.json({ journalSince: null, total: 0, debtors: [] });
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() - parsed.data.days * 86_400_000);
  const from = since > windowStart ? since : windowStart;

  const [bookings, seats] = await Promise.all([
    prisma.booking.findMany({
      where: {
        clubId, status: 'CONFIRMED', capacity: null, priceTotal: { gt: 0 },
        endTime: { gte: from, lt: now },
      },
      select: {
        id: true, startTime: true, customerId: true, customerName: true, customerPhone: true,
        title: true, priceTotal: true, court: { select: { name: true } },
        ledgerEntries: { where: { seatId: null }, select: { kind: true, amount: true } },
        payment: { select: { status: true, amount: true } },
      },
    }),
    prisma.bookingSeat.findMany({
      where: {
        status: 'BOOKED', price: { gt: 0 },
        booking: { clubId, status: 'CONFIRMED', endTime: { gte: from, lt: now } },
      },
      select: {
        id: true, bookingId: true, customerId: true, customerName: true, customerPhone: true, price: true,
        ledgerEntries: { select: { kind: true, amount: true } },
        payment: { select: { status: true, amount: true } },
        booking: { select: { startTime: true, title: true } },
      },
    }),
  ]);

  const covered = new Set(
    bookings.length
      ? (await prisma.passUsage.findMany({
        where: { bookingId: { in: bookings.map((b) => b.id) }, revertedAt: null },
        select: { bookingId: true },
      })).map((u) => u.bookingId)
      : [],
  );

  const items: DebtInput[] = [
    ...bookings.filter((b) => !covered.has(b.id)).map((b) => ({
      kind: 'BOOKING' as const,
      id: b.id,
      bookingId: b.id,
      startTime: b.startTime,
      customerId: b.customerId,
      customerName: b.customerName,
      customerPhone: b.customerPhone,
      title: b.title || b.court.name,
      price: b.priceTotal,
      ledger: b.ledgerEntries,
      onlinePaid: b.payment?.status === 'PAID' ? b.payment.amount : 0,
    })),
    ...seats.map((s) => ({
      kind: 'SEAT' as const,
      id: s.id,
      bookingId: s.bookingId,
      startTime: s.booking.startTime,
      customerId: s.customerId,
      customerName: s.customerName,
      customerPhone: s.customerPhone,
      title: s.booking.title || 'Групове заняття',
      price: s.price,
      ledger: s.ledgerEntries,
      onlinePaid: s.payment?.status === 'PAID' ? s.payment.amount : 0,
    })),
  ];

  const debtors = groupDebtors(findDebts(items));
  res.json({
    journalSince: since.toISOString(),
    from: from.toISOString(),
    total: debtors.reduce((s, d) => s + d.due, 0),
    debtors,
  });
});

/**
 * GET /api/admin/finance/passes — невідіграні абонементи.
 *
 * Гроші за них уже в касі, а послуга ще попереду: це борг клубу перед
 * клієнтами. Плюс ті, що згорають найближчими днями, — кому подзвонити.
 */
financeRouter.get('/passes', async (req, res) => {
  res.json(await loadLiabilityPasses(req.auth!.clubId, new Date()));
});

/**
 * GET /api/admin/finance/trainers?from&to — нараховано тренерам.
 * Лише проведені заняття: майбутні в періоді ще не відпрацьовані.
 */
financeRouter.get('/trainers', async (req, res) => {
  const parsed = rangeQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const clubId = req.auth!.clubId;
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });
  const range = cashRange(parsed.data, club.timezone);
  if (!range) return res.status(400).json({ error: 'BAD_PERIOD' });

  const now = new Date();
  const to = range.end.toJSDate() < now ? range.end.toJSDate() : now;

  const bookings = await prisma.booking.findMany({
    where: {
      clubId, status: 'CONFIRMED', trainerId: { not: null },
      startTime: { gte: range.start.toJSDate() }, endTime: { lte: to },
    },
    select: {
      trainerId: true, trainerPrice: true, startTime: true, endTime: true, attendance: true,
      trainer: { select: { name: true, pricePerHour: true } },
    },
  });

  const report = trainerPayouts(bookings.filter((b) => b.trainer).map((b) => ({
    trainerId: b.trainerId!,
    trainerName: b.trainer!.name,
    pricePerHour: b.trainer!.pricePerHour,
    trainerPrice: b.trainerPrice,
    startTime: b.startTime,
    endTime: b.endTime,
    attendance: b.attendance,
  })));

  res.json({
    from: range.start.toFormat('yyyy-MM-dd'),
    to: DateTime.fromJSDate(to).setZone(club.timezone).toFormat('yyyy-MM-dd'),
    ...report,
  });
});

const pnlQuery = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

const hoursOf = (b: { startTime: Date; endTime: Date }) =>
  Math.max(0, (b.endTime.getTime() - b.startTime.getTime()) / 3_600_000);

/**
 * GET /api/admin/finance/pnl?month=YYYY-MM
 *
 * Дванадцять місяців до вказаного: каса, витрати, прибуток. І точка
 * беззбитковості вказаного місяця в годинах корту.
 */
financeRouter.get('/pnl', async (req, res) => {
  const parsed = pnlQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const clubId = req.auth!.clubId;
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });
  const tz = club.timezone;

  const last = parsed.data.month
    ? DateTime.fromFormat(parsed.data.month, 'yyyy-MM', { zone: tz }).startOf('month')
    : DateTime.now().setZone(tz).startOf('month');
  if (!last.isValid) return res.status(400).json({ error: 'BAD_PERIOD' });

  const first = last.minus({ months: 11 });
  const months: string[] = [];
  for (let m = first; m <= last; m = m.plus({ months: 1 })) months.push(m.toFormat('yyyy-MM'));

  const from = first.toJSDate();
  const monthEnd = last.endOf('month').toJSDate();
  const now = new Date();
  /* Для поточного місяця «90 днів» рахуємо до сьогодні, не до кінця місяця. */
  const anchor = monthEnd < now ? monthEnd : now;
  const from90 = new Date(anchor.getTime() - 90 * 86_400_000);

  const [rows, expenses, recent, inMonth] = await Promise.all([
    loadCashRows(clubId, from, monthEnd, tz),
    prisma.clubExpense.findMany({
      where: { clubId, month: { gte: new Date(`${months[0]}-01T00:00:00Z`), lte: new Date(`${months.at(-1)}-01T00:00:00Z`) } },
      select: { month: true, category: true, amount: true },
    }),
    prisma.booking.findMany({
      where: { clubId, status: 'CONFIRMED', capacity: null, priceTotal: { gt: 0 }, startTime: { gte: from90, lt: anchor } },
      select: { startTime: true, endTime: true, priceTotal: true },
    }),
    prisma.booking.findMany({
      where: { clubId, status: 'CONFIRMED', startTime: { gte: last.toJSDate(), lte: monthEnd } },
      select: { startTime: true, endTime: true },
    }),
  ]);

  const pnl = monthlyPnl(rows, expenses, months, tz);
  const current = pnl.at(-1)!;

  res.json({
    months: pnl,
    total: {
      income: pnl.reduce((s, m) => s + m.income, 0),
      expenses: pnl.reduce((s, m) => s + m.expenses, 0),
      profit: pnl.reduce((s, m) => s + m.profit, 0),
    },
    breakEven: {
      month: current.month,
      ...breakEven({
        monthExpenses: current.expenses,
        fallbackExpenses: pnl.slice(-4, -1).map((m) => m.expenses),
        soldHours90: recent.reduce((s, b) => s + hoursOf(b), 0),
        revenue90: recent.reduce((s, b) => s + b.priceTotal, 0),
        soldHoursMonth: inMonth.reduce((s, b) => s + hoursOf(b), 0),
      }),
    },
  });
});
