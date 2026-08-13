import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma, isSlotTakenError } from '../lib/db';
import { normalizePhone, isSearchableTail } from '../lib/phone';
import { getActivePasses, getActivePass } from '../lib/customers';

export const adminRouter = Router();

type Auth = { userId: string; clubId: string; role: string };
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { auth?: Auth }
  }
}

const SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';

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

/** PATCH /api/admin/bookings/:id — підтвердити / скасувати */
adminRouter.patch('/bookings/:id', requireAuth, async (req, res) => {
  const parsed = z.object({ status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const result = await prisma.booking.updateMany({
    where: { id: req.params.id, clubId: req.auth!.clubId },
    data: {
      status: parsed.data.status,
      cancelledAt: parsed.data.status === 'CANCELLED' ? new Date() : null,
    },
  });
  if (result.count === 0) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true });
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
    where: { id: req.params.id, clubId: req.auth!.clubId },
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
    where: { id: req.params.id, clubId: req.auth!.clubId },
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
    where: { bookingId: req.params.id },
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
