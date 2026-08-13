import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { prisma, isSlotTakenError, notifyClub } from '../lib/db';
import { buildSlots, isAlignedToGrid, type Interval } from '../lib/slots';
import { normalizePhone } from '../lib/phone';
import { findOrCreateCustomer } from '../lib/customers';

export const publicRouter = Router();

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

async function loadClub(slug: string) {
  return prisma.club.findFirst({
    where: { slug, isActive: true },
    include: {
      hours: true,
      courts: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
    },
  });
}

/** GET /api/public/clubs/:slug — дані для віджета */
publicRouter.get('/clubs/:slug', async (req, res) => {
  const club = await loadClub(req.params.slug);
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });

  res.json({
    name: club.name,
    slug: club.slug,
    timezone: club.timezone,
    slotMinutes: club.slotMinutes,
    horizonDays: club.horizonDays,
    courts: club.courts.map((c) => ({
      id: c.id,
      name: c.name,
      pricePerHour: c.pricePerHour,
      slotMinutes: c.slotMinutes ?? club.slotMinutes,
    })),
  });
});

/**
 * GET /api/public/clubs/:slug/availability?date=2026-08-15[&courtId=...]
 * Порожні слоти не зберігаються в БД — сітка рахується на льоту.
 */
publicRouter.get('/clubs/:slug/availability', async (req, res) => {
  const parsed = z.object({ date: dateSchema, courtId: z.string().uuid().optional() })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST', details: parsed.error.flatten() });
  const { date, courtId } = parsed.data;

  const club = await loadClub(req.params.slug);
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });

  const day = DateTime.fromISO(date, { zone: club.timezone });
  if (!day.isValid) return res.status(400).json({ error: 'BAD_DATE' });

  const today = DateTime.now().setZone(club.timezone).startOf('day');
  if (day < today || day > today.plus({ days: club.horizonDays })) {
    return res.status(400).json({ error: 'DATE_OUT_OF_RANGE' });
  }

  // weekday: Luxon 1=Пн..7=Нд -> наша схема 0=Нд..6=Сб
  const weekday = day.weekday % 7;
  const hours = club.hours.find((h) => h.weekday === weekday);
  if (!hours || hours.isClosed) return res.json({ date, closed: true, courts: [] });

  // Межі доби з запасом ±1 доба — щоб зловити броні, що переходять через північ
  const from = day.startOf('day').minus({ days: 1 }).toJSDate();
  const to = day.startOf('day').plus({ days: 2 }).toJSDate();

  const courts = courtId ? club.courts.filter((c) => c.id === courtId) : club.courts;
  if (courtId && courts.length === 0) return res.status(404).json({ error: 'COURT_NOT_FOUND' });

  const [bookings, blocks] = await Promise.all([
    prisma.booking.findMany({
      where: {
        clubId: club.id,
        status: { not: 'CANCELLED' },
        startTime: { lt: to },
        endTime: { gt: from },
      },
      select: { courtId: true, startTime: true, endTime: true },
    }),
    prisma.block.findMany({
      where: { clubId: club.id, startTime: { lt: to }, endTime: { gt: from } },
      select: { courtId: true, startTime: true, endTime: true },
    }),
  ]);

  const now = new Date();
  const result = courts.map((court) => {
    const busy: Interval[] = [
      ...bookings.filter((b) => b.courtId === court.id),
      // courtId === null -> блокування всього клубу
      ...blocks.filter((b) => b.courtId === null || b.courtId === court.id),
    ];

    return {
      courtId: court.id,
      courtName: court.name,
      pricePerHour: court.pricePerHour,
      slots: buildSlots({
        date,
        timezone: club.timezone,
        openMinute: hours.openMinute,
        closeMinute: hours.closeMinute,
        slotMinutes: court.slotMinutes ?? club.slotMinutes,
        leadTimeMinutes: club.leadTimeMinutes,
        busy,
        now,
      }),
    };
  });

  res.json({ date, closed: false, timezone: club.timezone, courts: result });
});

const bookingSchema = z.object({
  courtId: z.string().uuid(),
  /** ISO 8601 з таймзоною, напр. 2026-08-15T16:00:00Z */
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  customerName: z.string().trim().min(2).max(80),
  customerPhone: z.string().trim().regex(/^\+?[0-9\s()-]{9,20}$/, 'invalid phone'),
  comment: z.string().trim().max(300).optional(),
});

/** POST /api/public/clubs/:slug/bookings */
publicRouter.post('/clubs/:slug/bookings', async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST', details: parsed.error.flatten() });
  const body = parsed.data;

  const club = await loadClub(req.params.slug);
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });

  const court = club.courts.find((c) => c.id === body.courtId);
  if (!court) return res.status(404).json({ error: 'COURT_NOT_FOUND' });

  const start = new Date(body.start);
  const end = new Date(body.end);
  if (end <= start) return res.status(400).json({ error: 'BAD_INTERVAL' });

  if (start.getTime() < Date.now() + club.leadTimeMinutes * 60_000) {
    return res.status(400).json({ error: 'TOO_LATE' });
  }

  const local = DateTime.fromJSDate(start).setZone(club.timezone);
  const weekday = local.weekday % 7;
  const hours = club.hours.find((h) => h.weekday === weekday);
  if (!hours || hours.isClosed) return res.status(400).json({ error: 'CLUB_CLOSED' });

  const slotMinutes = court.slotMinutes ?? club.slotMinutes;
  if (!isAlignedToGrid({
    start, end, timezone: club.timezone,
    openMinute: hours.openMinute, closeMinute: hours.closeMinute, slotMinutes,
  })) {
    return res.status(400).json({ error: 'OUT_OF_GRID' });
  }

  // Блокування адміністратора перевіряємо явно (їх не покриває констрейнт на Booking)
  const block = await prisma.block.findFirst({
    where: {
      clubId: club.id,
      OR: [{ courtId: null }, { courtId: court.id }],
      startTime: { lt: end },
      endTime: { gt: start },
    },
  });
  if (block) return res.status(409).json({ error: 'SLOT_TAKEN' });

  const phone = normalizePhone(body.customerPhone);
  if (!phone) return res.status(400).json({ error: 'BAD_PHONE' });

  const customer = await findOrCreateCustomer({
    clubId: club.id,
    name: body.customerName,
    rawPhone: body.customerPhone,
  });
  if (customer?.isBlocked) return res.status(403).json({ error: 'CUSTOMER_BLOCKED' });

  const minutes = (end.getTime() - start.getTime()) / 60_000;
  const priceTotal = Math.round((court.pricePerHour * minutes) / 60);

  try {
    // Гонку двох одночасних запитів ловить EXCLUDE USING gist у БД,
    // а не перевірка в коді — тому окрема транзакція з SELECT ... не потрібна.
    const booking = await prisma.booking.create({
      data: {
        clubId: club.id,
        courtId: court.id,
        customerName: body.customerName,
        customerPhone: phone.e164,
        customerId: customer?.id ?? null,
        comment: body.comment,
        startTime: start,
        endTime: end,
        priceTotal,
        status: club.autoConfirm ? 'CONFIRMED' : 'PENDING',
        source: 'WIDGET',
      },
    });

    void notifyClub(
      club.telegramChatId,
      `<b>Нова бронь</b>\n${court.name}\n${local.toFormat('dd.MM HH:mm')}–` +
      `${DateTime.fromJSDate(end).setZone(club.timezone).toFormat('HH:mm')}\n` +
      `${body.customerName}, ${body.customerPhone}\n` +
      `${(priceTotal / 100).toFixed(2)} грн`,
    );

    res.status(201).json({
      id: booking.id,
      status: booking.status,
      cancelToken: booking.cancelToken,
      priceTotal,
    });
  } catch (e) {
    if (isSlotTakenError(e)) return res.status(409).json({ error: 'SLOT_TAKEN' });
    console.error('[booking] create failed', e);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

/** POST /api/public/bookings/:id/cancel  { token } — скасування клієнтом за посиланням */
publicRouter.post('/bookings/:id/cancel', async (req, res) => {
  const parsed = z.object({ token: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
  if (!booking || booking.cancelToken !== parsed.data.token) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }
  if (booking.status === 'CANCELLED') return res.json({ ok: true });
  if (booking.startTime.getTime() < Date.now()) {
    return res.status(400).json({ error: 'ALREADY_STARTED' });
  }

  await prisma.booking.update({
    where: { id: booking.id },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });
  res.json({ ok: true });
});
