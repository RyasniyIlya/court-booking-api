import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { planFeatures } from '../../lib/plans';
import { sendMessage } from '../../lib/telegram';
import { needsNote, shiftByAccount, shiftStart, shiftText, shiftTotals } from '../../lib/shift';
import { LEDGER_ENTRY_SELECT, dayRange, pageAfter, shiftPeriodTotals } from '../../lib/cashdesk';
import { requireAuth, requireStaff } from './shared';

export const shiftRouter = Router();

class ShiftError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/**
 * GET /api/admin/shift — поточна, ще не закрита зміна.
 *
 * Що має бути в касі за журналом, розбивка по касах і самі операції:
 * коли готівка не сходиться, модератор шукає пропущену оплату саме тут,
 * а не гортає день за днем.
 *
 * Без вартового плану: звірка каси потрібна клубу першого рівня так само,
 * як і третього. Закрито тільки від тренера — виручки клубу в нього немає.
 */
shiftRouter.get('/shift', requireAuth, requireStaff, async (req, res) => {
  const clubId = req.auth!.clubId;
  const [club, last] = await Promise.all([
    prisma.club.findUniqueOrThrow({ where: { id: clubId }, select: { timezone: true } }),
    prisma.shiftClose.findFirst({ where: { clubId }, orderBy: { closedAt: 'desc' } }),
  ]);

  const openedAt = shiftStart(last?.closedAt ?? null, club.timezone);
  const entries = await prisma.bookingLedgerEntry.findMany({
    where: { clubId, createdAt: { gt: openedAt } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, kind: true, method: true, amount: true, account: true, note: true,
      actorEmail: true, createdAt: true, bookingId: true,
      booking: { select: { customerName: true, title: true, startTime: true, court: { select: { name: true } } } },
      seat: { select: { customerName: true } },
    },
  });

  res.json({
    openedAt,
    lastClose: last,
    expected: shiftTotals(entries),
    byAccount: shiftByAccount(entries),
    entriesCount: entries.length,
    /* Сотня останніх — на екрані більше не читається, а сума вище вже
       порахована по всіх. */
    entries: entries.slice(0, 100),
  });
});

const closeSchema = z.object({
  requestId: z.string().uuid(),
  countedCash: z.number().int().min(0).max(1_000_000_000),
  countedCard: z.number().int().min(0).max(1_000_000_000),
  /* Що бачила людина, коли рахувала. Якщо за цей час у журнал упала ще
     одна оплата, закривати по старих цифрах не можна: розбіжність була б
     вигаданою. */
  expectedCash: z.number().int(),
  expectedCard: z.number().int(),
  entriesCount: z.number().int().min(0),
  note: z.string().trim().max(1000).default(''),
}).strict();

/**
 * POST /api/admin/shift/close
 *
 * «Очікувалось» рахує сервер, а не довіряє тілу запиту. Тіло лише
 * підтверджує, що людина бачила ті самі цифри.
 *
 * Той самий замок рядка клубу, що й у журналі розрахунків: поки зміна
 * закривається, нова оплата не прослизне між підрахунком і записом — вона
 * дочекається й ляже вже в наступну зміну.
 */
shiftRouter.post('/shift/close', requireAuth, requireStaff, async (req, res) => {
  const parsed = closeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const d = parsed.data;
  const auth = req.auth!;

  try {
    const { close, club, repeated } = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Club" WHERE id = ${auth.clubId}::uuid FOR UPDATE`;

      const club = await tx.club.findUniqueOrThrow({
        where: { id: auth.clubId },
        select: { name: true, timezone: true, plan: true },
      });

      const prior = await tx.shiftClose.findUnique({
        where: { clubId_requestId: { clubId: auth.clubId, requestId: d.requestId } },
      });
      if (prior) return { close: prior, club, repeated: true };

      const last = await tx.shiftClose.findFirst({
        where: { clubId: auth.clubId },
        orderBy: { closedAt: 'desc' },
        select: { closedAt: true },
      });
      const openedAt = shiftStart(last?.closedAt ?? null, club.timezone);
      /* Час беремо вже під замком: усе, що записалось до нього, — у цій
         зміні, усе після — у наступній. */
      const closedAt = new Date();

      const entries = await tx.bookingLedgerEntry.findMany({
        where: { clubId: auth.clubId, createdAt: { gt: openedAt, lte: closedAt } },
        select: { kind: true, method: true, amount: true, account: true },
      });
      const t = shiftTotals(entries);

      if (t.cash !== d.expectedCash || t.card !== d.expectedCard || entries.length !== d.entriesCount) {
        throw new ShiftError(409, 'SHIFT_CHANGED');
      }
      if (needsNote(d.countedCash - t.cash, d.countedCard - t.card, d.note)) {
        throw new ShiftError(400, 'NOTE_REQUIRED');
      }

      const actor = await tx.user.findFirst({
        where: { id: auth.userId, clubId: auth.clubId },
        select: { id: true, email: true, name: true, role: true },
      });
      if (!actor || !['OWNER', 'ADMIN'].includes(actor.role)) throw new ShiftError(403, 'FORBIDDEN');

      const close = await tx.shiftClose.create({
        data: {
          clubId: auth.clubId,
          requestId: d.requestId,
          openedAt,
          closedAt,
          expectedCash: t.cash,
          countedCash: d.countedCash,
          expectedCard: t.card,
          countedCard: d.countedCard,
          transferNet: t.transfer,
          bonusNet: t.bonus,
          entriesCount: entries.length,
          note: d.note,
          actorId: actor.id,
          actorEmail: actor.email,
          actorName: actor.name,
          actorRole: actor.role,
        },
      });

      return { close, club, repeated: false };
    });

    /* Власнику — у Telegram, якщо бот підключено й план це дає. Повтор
       запиту не шле друге повідомлення. Себе самого власник не сповіщає:
       він щойно бачив ці цифри на екрані. */
    let notified = 0;
    if (!repeated && planFeatures(club.plan).telegram) {
      const owners = await prisma.user.findMany({
        where: { clubId: auth.clubId, role: 'OWNER', tgChatId: { not: null }, id: { not: auth.userId } },
        select: { tgChatId: true },
      });
      const text = shiftText(club.name, close, club.timezone);
      for (const o of owners) {
        void sendMessage(o.tgChatId!, text).catch(() => {});
      }
      notified = owners.length;
    }

    res.json({ close, notified });
  } catch (e) {
    if (e instanceof ShiftError) return res.status(e.status).json({ error: e.code });
    throw e;
  }
});

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** Операцій у деталях однієї зміни: більше за зміну не набирається, а це захист від аварії. */
const DETAIL_MAX = 1000;

const shiftsQuery = z.object({
  from: z.string().regex(DATE_ONLY).optional(),
  to: z.string().regex(DATE_ONLY).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).catch(30),
});

/**
 * GET /api/admin/shifts — закриті зміни, найновіші зверху.
 *
 * Без `from`/`to` — як і раніше: масив останніх змін (`?limit` до 60), на цьому
 * тримається вікно закриття зміни. З періодом — обʼєкт: сторінка змін за
 * курсором і підсумок по ВСІХ змінах періоду, не лише по сторінці.
 *
 * Період — локальні дати клубу, `to` включно; межі доби беруться в таймзоні
 * клубу, а не сервера. Зміну відносимо до періоду за моментом закриття:
 * вона «належить» вечору, коли її звірили.
 */
shiftRouter.get('/shifts', requireAuth, requireStaff, async (req, res) => {
  const clubId = req.auth!.clubId;

  if (req.query.from === undefined && req.query.to === undefined) {
    const limit = z.coerce.number().int().min(1).max(60).catch(20).parse(req.query.limit);
    const items = await prisma.shiftClose.findMany({
      where: { clubId },
      orderBy: { closedAt: 'desc' },
      take: limit,
    });
    return res.json(items);
  }

  const parsed = shiftsQuery.safeParse(req.query);
  if (!parsed.success || !parsed.data.from || !parsed.data.to) return res.status(400).json({ error: 'BAD_REQUEST' });
  const q = parsed.data;

  const club = await prisma.club.findUniqueOrThrow({ where: { id: clubId }, select: { timezone: true } });
  const range = dayRange(q.from!, q.to!, club.timezone);
  if (!range) return res.status(400).json({ error: 'BAD_PERIOD' });

  /* Увесь період одним читанням: підсумок однаково потребує всіх змін, а
     їх за рік — кілька сотень рядків. Сторінка — зріз цього ж списку. */
  const all = await prisma.shiftClose.findMany({
    where: { clubId, closedAt: { gte: range.start, lt: range.endExclusive } },
    orderBy: [{ closedAt: 'desc' }, { id: 'desc' }],
  });
  const page = pageAfter(all, q.cursor, q.limit);
  if (!page) return res.status(400).json({ error: 'BAD_CURSOR' });

  res.json({ items: page.items, totals: shiftPeriodTotals(all), nextCursor: page.nextCursor });
});

/**
 * GET /api/admin/shifts/:id — закрита зміна з усіма операціями.
 *
 * Операції зміни — ті, що лягли в журнал після відкриття й до закриття
 * включно (так само, як їх рахувало закриття). Підсумки тут — по
 * операціях, а не копія полів закриття: якщо вони розійшлися, розбіжність
 * видно, а не сховано.
 *
 * Чужа зміна — 404, а не 403: клуб не повинен дізнаватись, що такий id існує.
 */
shiftRouter.get('/shifts/:id', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: 'NOT_FOUND' });
  const clubId = req.auth!.clubId;

  const close = await prisma.shiftClose.findFirst({ where: { id: id.data, clubId } });
  if (!close) return res.status(404).json({ error: 'NOT_FOUND' });

  const found = await prisma.bookingLedgerEntry.findMany({
    where: { clubId, createdAt: { gt: close.openedAt, lte: close.closedAt } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: DETAIL_MAX + 1,
    select: LEDGER_ENTRY_SELECT,
  });
  const truncated = found.length > DETAIL_MAX;
  const entries = truncated ? found.slice(0, DETAIL_MAX) : found;

  res.json({
    close,
    totals: shiftTotals(entries),
    byAccount: shiftByAccount(entries),
    entries,
    truncated,
  });
});
