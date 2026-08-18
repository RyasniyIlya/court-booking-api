import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DateTime } from 'luxon';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma, isSlotTakenError } from '../lib/db';
import { normalizePhone, isSearchableTail } from '../lib/phone';
import { getActivePasses, getActivePass, findOrCreateCustomer } from '../lib/customers';
import { KNOWN_PROVIDERS, publicBase } from '../lib/payments';
import { encryptSecret, paymentsSecretReady } from '../lib/crypto';

export const adminRouter = Router();

type Auth = { userId: string; clubId: string; role: string };
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { auth?: Auth }
  }
}

const SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';

/**
 * Значення req.params у типах Express 5 — це string | string[]:
 * один параметр може повторитись у шляху. Нам завжди потрібен рядок.
 * Без цього tsc падає з TS2322 на кожному where по id з параметра шляху.
 */
function param(req: Request, name: string): string {
  const v = (req.params as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'UNAUTHORIZED' });
  try {
    req.auth = jwt.verify(header.slice(7), SECRET) as Auth;
    next();
  } catch {
    res.status(401).json({ error: 'UNAUTHORIZED' });
  }
}

/** POST /api/admin/login */
adminRouter.post('/login', async (req, res) => {
  const parsed = z.object({ email: z.string().email(), password: z.string().min(6) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
  const ok = user && (await bcrypt.compare(parsed.data.password, user.passwordHash));
  if (!user || !ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  const token = jwt.sign(
    { userId: user.id, clubId: user.clubId, role: user.role } satisfies Auth,
    SECRET,
    { expiresIn: '7d' },
  );
  res.json({ token });
});

/** GET /api/admin/bookings?from=&to= — тільки свій клуб (ізоляція тенанта) */
adminRouter.get('/bookings', requireAuth, async (req, res) => {
  const parsed = z.object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const bookings = await prisma.booking.findMany({
    where: {
      clubId: req.auth!.clubId,
      startTime: { lt: new Date(parsed.data.to) },
      endTime: { gt: new Date(parsed.data.from) },
    },
    include: {
      court: { select: { name: true } },
      trainer: { select: { id: true, name: true, phone: true } },
      payment: { select: { status: true, paidAt: true, amount: true } },
      customer: { select: { id: true, telegramChatId: true, isBlocked: true, note: true } },
    },
    orderBy: { startTime: 'asc' },
  });

  // Один запит на всі абонементи дня, а не N запитів по кожній броні
  const ids = [...new Set(bookings.map((b) => b.customerId).filter(Boolean))] as string[];
  const passes = await getActivePasses(ids);

  res.json(bookings.map((b) => ({
    ...b,
    pass: b.customerId ? passes.get(b.customerId) ?? null : null,
    /// Нагадування не дійде — адміну доведеться дзвонити самому
    reminderReachable: Boolean(b.customer?.telegramChatId),
  })));
});

/** Статуси, що займають час. EXPIRED і CANCELLED час звільняють. */
const BUSY = ['PENDING', 'CONFIRMED'] as const;

/** Скільки коштує тренер за цей інтервал */
const trainerCost = (pricePerHour: number, start: Date, end: Date) =>
  Math.round((pricePerHour * ((end.getTime() - start.getTime()) / 60_000)) / 60);

/**
 * POST /api/admin/bookings — бронь від адміністратора.
 *
 * Гравець прийшов без телефону, домовились по дзвінку, записали постійного
 * клієнта — усе це раніше не мало куди подітись, бо створювати броню вмів
 * тільки віджет.
 *
 * Правила тут свідомо мʼякші, ніж у публічному роуті: адміністратору можна
 * записати минуле (зафіксувати факт гри), можна не по сітці, можна поверх
 * закритого часу — він сам його і закривав. Що НЕ можна — накласти дві броні
 * на один корт: це ловить EXCLUDE-констрейнт у базі, а не перевірка в коді.
 */
adminRouter.post('/bookings', requireAuth, async (req, res) => {
  const parsed = z.object({
    courtId: z.string().uuid(),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    customerName: z.string().trim().min(1).max(80),
    /// Порожньо — записуємо без картки клієнта. Буває: людина зайшла з вулиці.
    customerPhone: z.string().trim().max(30).optional(),
    trainerId: z.string().uuid().nullable().optional(),
    comment: z.string().trim().max(300).optional(),
    status: z.enum(['PENDING', 'CONFIRMED']).default('CONFIRMED'),
    /// Своя ціна — знижки й домовленості бувають. Копійки.
    priceTotal: z.number().int().min(0).max(1_000_000_00).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const d = parsed.data;
  const clubId = req.auth!.clubId;
  const start = new Date(d.start);
  const end = new Date(d.end);

  if (end <= start) return res.status(400).json({ error: 'BAD_INTERVAL' });
  if (end.getTime() - start.getTime() > 12 * 3600_000) {
    return res.status(400).json({ error: 'TOO_LONG' });
  }

  const court = await prisma.court.findFirst({ where: { id: d.courtId, clubId } });
  if (!court) return res.status(404).json({ error: 'COURT_NOT_FOUND' });

  let trainer = null;
  if (d.trainerId) {
    trainer = await prisma.trainer.findFirst({
      where: { id: d.trainerId, clubId, isActive: true },
    });
    if (!trainer) return res.status(404).json({ error: 'TRAINER_NOT_FOUND' });

    const clash = await prisma.booking.findFirst({
      where: {
        trainerId: trainer.id,
        status: { in: [...BUSY] },
        startTime: { lt: end },
        endTime: { gt: start },
      },
      select: { id: true },
    });
    if (clash) return res.status(409).json({ error: 'TRAINER_BUSY' });
  }

  const minutes = (end.getTime() - start.getTime()) / 60_000;
  const trainerPrice = trainer ? trainerCost(trainer.pricePerHour, start, end) : 0;
  const courtPrice = Math.round((court.pricePerHour * minutes) / 60);
  const priceTotal = d.priceTotal ?? courtPrice + trainerPrice;

  // Картка клієнта тільки якщо телефон нормалізувався. Без телефону
  // ідентифікувати людину все одно нічим — картку не плодимо.
  const phone = d.customerPhone ? normalizePhone(d.customerPhone) : null;
  const customer = phone
    ? await findOrCreateCustomer({ clubId, name: d.customerName, rawPhone: d.customerPhone! })
    : null;

  try {
    const booking = await prisma.booking.create({
      data: {
        clubId,
        courtId: court.id,
        customerName: d.customerName,
        customerPhone: phone?.e164 ?? '',
        customerId: customer?.id ?? null,
        trainerId: trainer?.id ?? null,
        trainerPrice,
        comment: d.comment,
        startTime: start,
        endTime: end,
        priceTotal,
        status: d.status,
        source: 'ADMIN',
      },
      include: { court: { select: { name: true } }, trainer: { select: { id: true, name: true } } },
    });
    res.status(201).json(booking);
  } catch (e) {
    if (isSlotTakenError(e)) return res.status(409).json({ error: 'SLOT_TAKEN' });
    console.error('[admin booking] create failed', e);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

/**
 * PATCH /api/admin/bookings/:id — статус, тренер, перенос.
 *
 * Перенос (courtId / start / end) потрібен для перетягування броні в сітці.
 * Ціна корту при переносі перераховується під новий корт і нову тривалість,
 * частка тренера — теж. Якщо адміністратор виставляв свою ціну, після
 * переносу вона зникне: інакше перенос на дорожчий корт залишав би клуб
 * без грошей, і це помітили б не одразу.
 */
adminRouter.patch('/bookings/:id', requireAuth, async (req, res) => {
  const parsed = z.object({
    status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED']).optional(),
    /// null знімає тренера з броні
    trainerId: z.string().uuid().nullable().optional(),
    /// Замітка до заняття: «принести мʼячі», «оплата готівкою», «спізнюється».
    /// Порожній рядок стирає замітку.
    comment: z.string().trim().max(300).nullable().optional(),
    // Перенос. start і end передаються тільки разом.
    courtId: z.string().uuid().optional(),
    start: z.string().datetime({ offset: true }).optional(),
    end: z.string().datetime({ offset: true }).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const p = parsed.data;
  const clubId = req.auth!.clubId;

  if (Object.keys(p).length === 0) return res.status(400).json({ error: 'NOTHING_TO_UPDATE' });
  if ((p.start === undefined) !== (p.end === undefined)) {
    return res.status(400).json({ error: 'START_AND_END_TOGETHER' });
  }

  const booking = await prisma.booking.findFirst({
    where: { id: param(req, 'id'), clubId },
  });
  if (!booking) return res.status(404).json({ error: 'NOT_FOUND' });

  const data: Record<string, unknown> = {};

  // Куда і коли бронь стане після цього запиту — потрібно для перевірок
  const start = p.start ? new Date(p.start) : booking.startTime;
  const end = p.end ? new Date(p.end) : booking.endTime;
  const moved = Boolean(p.start || p.courtId);

  if (moved) {
    if (end <= start) return res.status(400).json({ error: 'BAD_INTERVAL' });

    const courtId = p.courtId ?? booking.courtId;
    const court = await prisma.court.findFirst({ where: { id: courtId, clubId } });
    if (!court) return res.status(404).json({ error: 'COURT_NOT_FOUND' });

    data.courtId = court.id;
    data.startTime = start;
    data.endTime = end;

    const minutes = (end.getTime() - start.getTime()) / 60_000;
    data.priceTotal = Math.round((court.pricePerHour * minutes) / 60) + booking.trainerPrice;
  }

  if (p.status !== undefined) {
    data.status = p.status;
    data.cancelledAt = p.status === 'CANCELLED' ? new Date() : null;
  }

  if (p.comment !== undefined) {
    data.comment = p.comment === null || p.comment === '' ? null : p.comment;
  }

  if (p.trainerId !== undefined) {
    if (p.trainerId === null) {
      // Знімаємо тренера — і його частку з суми
      data.trainerId = null;
      data.trainerPrice = 0;
      data.priceTotal = (data.priceTotal as number ?? booking.priceTotal) - booking.trainerPrice;
    } else {
      const trainer = await prisma.trainer.findFirst({
        where: { id: p.trainerId, clubId, isActive: true },
      });
      if (!trainer) return res.status(404).json({ error: 'TRAINER_NOT_FOUND' });

      const price = trainerCost(trainer.pricePerHour, start, end);
      data.trainerId = trainer.id;
      data.trainerPrice = price;
      data.priceTotal =
        (data.priceTotal as number ?? booking.priceTotal) - booking.trainerPrice + price;
    }
  }

  // Тренер не може вести дві броні одночасно. Перевіряємо і коли міняють
  // тренера, і коли переносять бронь: у новий час він може бути зайнятий.
  const finalTrainerId = p.trainerId !== undefined ? p.trainerId : booking.trainerId;
  if (finalTrainerId && (moved || p.trainerId !== undefined)) {
    const clash = await prisma.booking.findFirst({
      where: {
        id: { not: booking.id },
        trainerId: finalTrainerId,
        status: { in: [...BUSY] },
        startTime: { lt: end },
        endTime: { gt: start },
      },
      select: { id: true },
    });
    if (clash) return res.status(409).json({ error: 'TRAINER_BUSY' });
  }

  try {
    await prisma.booking.update({ where: { id: booking.id }, data });
    res.json({ ok: true });
  } catch (e) {
    // Перенос на зайнятий час — той самий EXCLUDE-констрейнт
    if (isSlotTakenError(e)) return res.status(409).json({ error: 'SLOT_TAKEN' });
    throw e;
  }
});

/**
 * POST /api/admin/bookings/series — повторювані заняття.
 *
 * «Щовівторка о 19:00 на вісім тижнів» — типова регулярна тренерська група.
 * Кожен тиждень створюється окремою бронню з тим самим seriesId: заняття
 * можна перенести чи скасувати поштучно, не ламаючи решту.
 *
 * Зайняті дати не валять весь запит, а просто пропускаються — і повертаються
 * у відповіді списком. Клуб має побачити «створено 6 з 8, дві дати зайняті»,
 * а не ловити помилку і гадати, що встигло записатись.
 */
adminRouter.post('/bookings/series', requireAuth, async (req, res) => {
  const parsed = z.object({
    courtId: z.string().uuid(),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    customerName: z.string().trim().min(1).max(80),
    customerPhone: z.string().trim().max(30).optional(),
    trainerId: z.string().uuid().nullable().optional(),
    comment: z.string().trim().max(300).optional(),
    /// Скільки тижнів поспіль, включно з першим
    weeks: z.number().int().min(2).max(52),
    status: z.enum(['PENDING', 'CONFIRMED']).default('CONFIRMED'),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const d = parsed.data;
  const clubId = req.auth!.clubId;
  const first = new Date(d.start);
  const firstEnd = new Date(d.end);

  if (firstEnd <= first) return res.status(400).json({ error: 'BAD_INTERVAL' });
  if (firstEnd.getTime() - first.getTime() > 12 * 3600_000) {
    return res.status(400).json({ error: 'TOO_LONG' });
  }

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { timezone: true },
  });
  const court = await prisma.court.findFirst({ where: { id: d.courtId, clubId } });
  if (!court) return res.status(404).json({ error: 'COURT_NOT_FOUND' });

  let trainer = null;
  if (d.trainerId) {
    trainer = await prisma.trainer.findFirst({
      where: { id: d.trainerId, clubId, isActive: true },
    });
    if (!trainer) return res.status(404).json({ error: 'TRAINER_NOT_FOUND' });
  }

  const minutes = (firstEnd.getTime() - first.getTime()) / 60_000;
  const trainerPrice = trainer ? trainerCost(trainer.pricePerHour, first, firstEnd) : 0;
  const priceTotal = Math.round((court.pricePerHour * minutes) / 60) + trainerPrice;

  const phone = d.customerPhone ? normalizePhone(d.customerPhone) : null;
  const customer = phone
    ? await findOrCreateCustomer({ clubId, name: d.customerName, rawPhone: d.customerPhone! })
    : null;

  const seriesId = randomUUID();
  const tz = club?.timezone ?? 'Europe/Kyiv';

  // Через Luxon у таймзоні клубу, а не +7*24 години: інакше після переходу
  // на зимовий час заняття поїхало б на годину. Гравець приходить о 19:00
  // за годинником на стіні, і так має лишатись весь сезон.
  const startLocal = DateTime.fromJSDate(first).setZone(tz);
  const endLocal = DateTime.fromJSDate(firstEnd).setZone(tz);

  const created: { start: string; id: string }[] = [];
  const skipped: { start: string; reason: 'SLOT_TAKEN' | 'TRAINER_BUSY' }[] = [];

  for (let i = 0; i < d.weeks; i++) {
    const s = startLocal.plus({ weeks: i }).toJSDate();
    const e = endLocal.plus({ weeks: i }).toJSDate();

    if (trainer) {
      const clash = await prisma.booking.findFirst({
        where: {
          trainerId: trainer.id,
          status: { in: [...BUSY] },
          startTime: { lt: e },
          endTime: { gt: s },
        },
        select: { id: true },
      });
      if (clash) {
        skipped.push({ start: s.toISOString(), reason: 'TRAINER_BUSY' });
        continue;
      }
    }

    try {
      const b = await prisma.booking.create({
        data: {
          clubId,
          courtId: court.id,
          customerName: d.customerName,
          customerPhone: phone?.e164 ?? '',
          customerId: customer?.id ?? null,
          trainerId: trainer?.id ?? null,
          trainerPrice,
          comment: d.comment,
          startTime: s,
          endTime: e,
          priceTotal,
          status: d.status,
          source: 'ADMIN',
          seriesId,
        },
        select: { id: true },
      });
      created.push({ start: s.toISOString(), id: b.id });
    } catch (err) {
      if (isSlotTakenError(err)) {
        skipped.push({ start: s.toISOString(), reason: 'SLOT_TAKEN' });
        continue;
      }
      console.error('[series] create failed', err);
      return res.status(500).json({ error: 'INTERNAL', created, skipped });
    }
  }

  if (created.length === 0) {
    return res.status(409).json({ error: 'ALL_TAKEN', created, skipped });
  }
  res.status(201).json({ seriesId, created, skipped });
});

/**
 * POST /api/admin/series/:seriesId/cancel — скасувати серію.
 *
 * Тільки майбутні заняття. Минулі лишаємо як є: це історія, і в ній були
 * гроші. «Скасувати те, що вже відбулось» — не те, чого хоче адміністратор,
 * навіть якщо натиснув на минуле заняття.
 */
adminRouter.post('/series/:seriesId/cancel', requireAuth, async (req, res) => {
  const parsed = z.string().uuid().safeParse(param(req, 'seriesId'));
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const result = await prisma.booking.updateMany({
    where: {
      seriesId: parsed.data,
      clubId: req.auth!.clubId,
      status: { in: [...BUSY] },
      startTime: { gte: new Date() },
    },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });

  res.json({ ok: true, cancelled: result.count });
});

/* ── Тренери ─────────────────────────────────────────────────────────────
   Розкладу тренерів немає свідомо: клуб сам знає, хто коли працює.
   Від накладок захищає перевірка при створенні та призначенні броні. */

/** GET /api/admin/trainers — усі, включно з прихованими */
adminRouter.get('/trainers', requireAuth, async (req, res) => {
  const trainers = await prisma.trainer.findMany({
    where: { clubId: req.auth!.clubId },
    orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  });
  res.json(trainers);
});

const trainerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().max(30).nullable().optional(),
  /// Копійки за годину
  pricePerHour: z.number().int().min(0).max(10_000_00).default(0),
  note: z.string().trim().max(200).nullable().optional(),
  sortOrder: z.number().int().min(0).max(999).default(0),
  isActive: z.boolean().default(true),
});

/** POST /api/admin/trainers */
adminRouter.post('/trainers', requireAuth, async (req, res) => {
  const parsed = trainerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const trainer = await prisma.trainer.create({
    data: { ...parsed.data, clubId: req.auth!.clubId },
  });
  res.status(201).json(trainer);
});

/** PATCH /api/admin/trainers/:id */
adminRouter.patch('/trainers/:id', requireAuth, async (req, res) => {
  const parsed = trainerSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const result = await prisma.trainer.updateMany({
    where: { id: param(req, 'id'), clubId: req.auth!.clubId },
    data: parsed.data,
  });
  if (result.count === 0) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true });
});

/**
 * DELETE /api/admin/trainers/:id
 * Якщо на тренері висять броні — не стираємо, а ховаємо: історія і звіти
 * мають лишитись цілими.
 */
adminRouter.delete('/trainers/:id', requireAuth, async (req, res) => {
  const trainer = await prisma.trainer.findFirst({
    where: { id: param(req, 'id'), clubId: req.auth!.clubId },
  });
  if (!trainer) return res.status(404).json({ error: 'NOT_FOUND' });

  const used = await prisma.booking.count({ where: { trainerId: trainer.id } });
  if (used > 0) {
    await prisma.trainer.update({ where: { id: trainer.id }, data: { isActive: false } });
    return res.json({ ok: true, hidden: true, bookings: used });
  }

  await prisma.trainer.delete({ where: { id: trainer.id } });
  res.json({ ok: true, hidden: false });
});

/* ── Корти ──────────────────────────────────────────────────────────────── */

/** GET /api/admin/courts — усі, включно з прихованими */
adminRouter.get('/courts', requireAuth, async (req, res) => {
  const courts = await prisma.court.findMany({
    where: { clubId: req.auth!.clubId },
    orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  });
  res.json(courts);
});

/** PATCH /api/admin/courts/:id */
adminRouter.patch('/courts/:id', requireAuth, async (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(60).optional(),
    pricePerHour: z.number().int().min(0).max(100_000_00).optional(),
    slotMinutes: z.number().int().min(15).max(240).nullable().optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
    isActive: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const result = await prisma.court.updateMany({
    where: { id: param(req, 'id'), clubId: req.auth!.clubId },
    data: parsed.data,
  });
  if (result.count === 0) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true });
});

/**
 * DELETE /api/admin/courts/:id
 * Корт з бронями ховаємо, а не стираємо: у Booking стоїть Cascade,
 * і видалення корту забрало б із собою всю історію броней разом з грошима.
 */
adminRouter.delete('/courts/:id', requireAuth, async (req, res) => {
  const court = await prisma.court.findFirst({
    where: { id: param(req, 'id'), clubId: req.auth!.clubId },
  });
  if (!court) return res.status(404).json({ error: 'NOT_FOUND' });

  const used = await prisma.booking.count({ where: { courtId: court.id } });
  if (used > 0) {
    await prisma.court.update({ where: { id: court.id }, data: { isActive: false } });
    return res.json({ ok: true, hidden: true, bookings: used });
  }

  await prisma.court.delete({ where: { id: court.id } });
  res.json({ ok: true, hidden: false });
});

/** GET /api/admin/hours — розклад роботи на тиждень */
adminRouter.get('/hours', requireAuth, async (req, res) => {
  const hours = await prisma.clubHours.findMany({
    where: { clubId: req.auth!.clubId },
    orderBy: { weekday: 'asc' },
  });
  res.json(hours);
});

/** GET /api/admin/club — налаштування клубу для екрана в кабінеті */
adminRouter.get('/club', requireAuth, async (req, res) => {
  const club = await prisma.club.findUnique({ where: { id: req.auth!.clubId } });
  if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

  res.json({
    name: club.name,
    slug: club.slug,
    timezone: club.timezone,
    phone: club.phone,
    address: club.address,
    logoUrl: club.logoUrl,
    telegramChatId: club.telegramChatId,
    slotMinutes: club.slotMinutes,
    leadTimeMinutes: club.leadTimeMinutes,
    horizonDays: club.horizonDays,
    autoConfirm: club.autoConfirm,
    prepayEnabled: club.prepayEnabled,
    paymentProvider: club.paymentProvider,
    payHoldMinutes: club.payHoldMinutes,
    // Токен не віддаємо навіть власнику — тільки факт наявності
    hasPaymentToken: Boolean(club.paymentTokenEnc),
    webhookUrl: `${publicBase()}/api/pay/webhook/${club.id}`,
  });
});

/** POST /api/admin/blocks — закрити час (ремонт, турнір, тривога) */
adminRouter.post('/blocks', requireAuth, async (req, res) => {
  const parsed = z.object({
    courtId: z.string().uuid().nullable().optional(),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    reason: z.string().max(200).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const { courtId, start, end, reason } = parsed.data;
  if (new Date(end) <= new Date(start)) return res.status(400).json({ error: 'BAD_INTERVAL' });

  if (courtId) {
    const court = await prisma.court.findFirst({ where: { id: courtId, clubId: req.auth!.clubId } });
    if (!court) return res.status(404).json({ error: 'COURT_NOT_FOUND' });
  }

  try {
    const block = await prisma.block.create({
      data: {
        clubId: req.auth!.clubId,
        courtId: courtId ?? null,
        startTime: new Date(start),
        endTime: new Date(end),
        reason,
      },
    });
    res.status(201).json(block);
  } catch (e) {
    if (isSlotTakenError(e)) return res.status(409).json({ error: 'BLOCK_OVERLAP' });
    throw e;
  }
});

/**
 * PATCH /api/admin/club — реквізити клубу.
 * Через CLI заводиться новий клуб, а вже заведеному ці поля треба міняти
 * без походу в базу: клуб переїхав, змінив телефон, нарешті прислав логотип.
 */
adminRouter.patch('/club', requireAuth, async (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    address: z.string().trim().max(200).nullable().optional(),
    // Тільки https: http зламає замок у браузері на сайті клубу,
    // data: роздує кожну відповідь API.
    logoUrl: z.string().trim().max(500).regex(/^https:\/\/\S+$/).nullable().optional(),
    telegramChatId: z.string().trim().max(60).nullable().optional(),

    // Передоплата
    prepayEnabled: z.boolean().optional(),
    paymentProvider: z.enum(KNOWN_PROVIDERS).nullable().optional(),
    payHoldMinutes: z.number().int().min(5).max(60).optional(),
    /// Токен еквайрингу клубу. Приймаємо, шифруємо, назад ніколи не віддаємо.
    paymentToken: z.string().trim().min(10).max(400).nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const { paymentToken, ...rest } = parsed.data;

  const data: Record<string, unknown> = { ...rest };
  if (paymentToken !== undefined) {
    if (paymentToken === null) {
      data.paymentTokenEnc = null;
    } else {
      if (!paymentsSecretReady()) {
        return res.status(503).json({ error: 'PAYMENTS_SECRET_MISSING' });
      }
      data.paymentTokenEnc = encryptSecret(paymentToken);
    }
  }

  const club = await prisma.club.update({ where: { id: req.auth!.clubId }, data });

  res.json({
    name: club.name,
    slug: club.slug,
    phone: club.phone,
    address: club.address,
    logoUrl: club.logoUrl,
    telegramChatId: club.telegramChatId,
    prepayEnabled: club.prepayEnabled,
    paymentProvider: club.paymentProvider,
    payHoldMinutes: club.payHoldMinutes,
    // Сам токен не віддаємо навіть власнику клубу — тільки факт наявності
    hasPaymentToken: Boolean(club.paymentTokenEnc),
    webhookUrl: `${publicBase()}/api/pay/webhook/${club.id}`,
  });
});

/** GET /api/admin/blocks?from=&to= — закриті проміжки за період */
adminRouter.get('/blocks', requireAuth, async (req, res) => {
  const parsed = z.object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const blocks = await prisma.block.findMany({
    where: {
      clubId: req.auth!.clubId,
      startTime: { lt: new Date(parsed.data.to) },
      endTime: { gt: new Date(parsed.data.from) },
    },
    include: { court: { select: { name: true } } },
    orderBy: { startTime: 'asc' },
  });

  res.json(blocks);
});

/**
 * DELETE /api/admin/blocks/:id — відкрити час назад.
 * Турнір перенесли, тривогу відбили, ремонт закінчився раніше — час має
 * повернутись у сітку без походу в базу.
 */
adminRouter.delete('/blocks/:id', requireAuth, async (req, res) => {
  const parsed = z.string().uuid().safeParse(param(req, 'id'));
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  // deleteMany з clubId у where, а не delete по id: інакше, знаючи id,
  // можна було б зняти блокування чужого клубу.
  const result = await prisma.block.deleteMany({
    where: { id: parsed.data, clubId: req.auth!.clubId },
  });
  if (result.count === 0) return res.status(404).json({ error: 'NOT_FOUND' });

  res.json({ ok: true });
});

/** POST /api/admin/courts */
adminRouter.post('/courts', requireAuth, async (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(60),
    pricePerHour: z.number().int().min(0).default(0),
    slotMinutes: z.number().int().min(15).max(240).nullable().optional(),
    sortOrder: z.number().int().default(0),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const court = await prisma.court.create({
    data: { ...parsed.data, slotMinutes: parsed.data.slotMinutes ?? null, clubId: req.auth!.clubId },
  });
  res.status(201).json(court);
});

/** PUT /api/admin/hours — розклад роботи на тиждень */
adminRouter.put('/hours', requireAuth, async (req, res) => {
  const parsed = z.array(z.object({
    weekday: z.number().int().min(0).max(6),
    openMinute: z.number().int().min(0).max(1440),
    closeMinute: z.number().int().min(0).max(1680),
    isClosed: z.boolean().default(false),
  })).length(7).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const clubId = req.auth!.clubId;
  await prisma.$transaction(
    parsed.data.map((h) => prisma.clubHours.upsert({
      where: { clubId_weekday: { clubId, weekday: h.weekday } },
      update: h,
      create: { ...h, clubId },
    })),
  );
  res.json({ ok: true });
});

/** GET /api/admin/customers?q= — пошук на ресепшені за 4+ останніми цифрами або імʼям */
adminRouter.get('/customers', requireAuth, async (req, res) => {
  const parsed = z.object({ q: z.string().trim().min(2).max(40) }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const q = parsed.data.q;

  const digits = q.replace(/\D/g, '');
  const where = digits.length >= 4 && isSearchableTail(digits)
    ? { clubId: req.auth!.clubId, phoneTail: { endsWith: digits.slice(-7) } }
    : { clubId: req.auth!.clubId, name: { contains: q, mode: 'insensitive' as const } };

  const customers = await prisma.customer.findMany({ where, take: 10, orderBy: { name: 'asc' } });
  const passes = await getActivePasses(customers.map((c) => c.id));

  res.json(customers.map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
    isBlocked: c.isBlocked,
    note: c.note,
    pass: passes.get(c.id) ?? null,
  })));
});

/** POST /api/admin/customers/:id/passes — продати абонемент */
adminRouter.post('/customers/:id/passes', requireAuth, async (req, res) => {
  const parsed = z.object({
    type: z.enum(['PACKAGE', 'UNLIMITED']),
    totalSessions: z.number().int().min(1).max(200).nullable().optional(),
    validFrom: z.string().datetime({ offset: true }),
    validUntil: z.string().datetime({ offset: true }),
    price: z.number().int().min(0).default(0),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const d = parsed.data;
  if (d.type === 'PACKAGE' && !d.totalSessions) {
    return res.status(400).json({ error: 'SESSIONS_REQUIRED' });
  }
  if (new Date(d.validUntil) <= new Date(d.validFrom)) {
    return res.status(400).json({ error: 'BAD_PERIOD' });
  }

  const customer = await prisma.customer.findFirst({
    where: { id: param(req, 'id'), clubId: req.auth!.clubId },
  });
  if (!customer) return res.status(404).json({ error: 'NOT_FOUND' });

  const pass = await prisma.pass.create({
    data: {
      clubId: req.auth!.clubId,
      customerId: customer.id,
      type: d.type,
      totalSessions: d.type === 'PACKAGE' ? d.totalSessions! : null,
      validFrom: new Date(d.validFrom),
      validUntil: new Date(d.validUntil),
      price: d.price,
    },
  });
  res.status(201).json(pass);
});

/**
 * POST /api/admin/bookings/:id/use-pass — списати заняття вручну.
 * Автоматичне списання поки не вмикаємо: правило згорання (за скільки годин
 * до заняття скасування вже не рятує) різне в кожному клубі — питаємо на обдзвоні.
 */
adminRouter.post('/bookings/:id/use-pass', requireAuth, async (req, res) => {
  const booking = await prisma.booking.findFirst({
    where: { id: param(req, 'id'), clubId: req.auth!.clubId },
  });
  if (!booking || !booking.customerId) return res.status(404).json({ error: 'NOT_FOUND' });

  const existing = await prisma.passUsage.findUnique({ where: { bookingId: booking.id } });
  if (existing && !existing.revertedAt) return res.status(409).json({ error: 'ALREADY_USED' });

  const balance = await getActivePass(booking.customerId, booking.startTime);
  if (!balance) return res.status(409).json({ error: 'NO_ACTIVE_PASS' });

  // Інкремент і запис списання — однією транзакцією, щоб лічильник
  // не розʼїхався з історією
  await prisma.$transaction([
    prisma.pass.update({
      where: { id: balance.passId },
      data: { usedSessions: { increment: 1 } },
    }),
    prisma.passUsage.create({
      data: { passId: balance.passId, bookingId: booking.id, by: req.auth!.userId },
    }),
  ]);

  res.json({ ok: true, left: balance.left === null ? null : balance.left - 1 });
});

/** DELETE /api/admin/bookings/:id/use-pass — повернути списане заняття */
adminRouter.delete('/bookings/:id/use-pass', requireAuth, async (req, res) => {
  const usage = await prisma.passUsage.findUnique({
    where: { bookingId: param(req, 'id') },
    include: { pass: true },
  });
  if (!usage || usage.revertedAt || usage.pass.clubId !== req.auth!.clubId) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }

  await prisma.$transaction([
    prisma.pass.update({
      where: { id: usage.passId },
      data: { usedSessions: { decrement: 1 } },
    }),
    prisma.passUsage.update({
      where: { id: usage.id },
      data: { revertedAt: new Date() },
    }),
  ]);

  res.json({ ok: true });
});
