import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { ATTENDANCE, attendanceError } from '../../lib/attendance';
import { requireAuth, param } from './shared';

export const attendanceRouter = Router();

/**
 * PATCH /api/admin/bookings/:id/attendance  { attendance }
 *
 * Окремий роут, а не ще одне поле в загальному PATCH броні: там статус
 * керується грошима і пересчитується ціна, а відмітка приходу не має
 * права зачепити ні те, ні інше.
 *
 * .strict() — зайве поле в тілі означає 400, а не мовчазне ігнорування:
 * під виглядом відмітки не пронести status чи priceTotal.
 */
attendanceRouter.patch(
  '/bookings/:id/attendance',
  requireAuth,
  async (req, res) => {
    const id = z.string().uuid().safeParse(param(req, 'id'));
    const parsed = z
      .object({ attendance: z.enum(ATTENDANCE) })
      .strict()
      .safeParse(req.body);

    if (!id.success || !parsed.success) {
      return res.status(400).json({ error: 'BAD_REQUEST' });
    }

    const auth = req.auth!;
    const booking = await prisma.booking.findFirst({
      where: { id: id.data, clubId: auth.clubId },
      select: { id: true, status: true, capacity: true, startTime: true, trainerId: true },
    });

    /* Тренер відмічає тільки своє заняття. Чуже — 404, а не 403: так само,
       як у загальному PATCH, не підтверджуємо, що такий id взагалі існує. */
    if (!booking || (auth.role === 'TRAINER' && (!auth.trainerId || booking.trainerId !== auth.trainerId))) {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }

    const next = parsed.data.attendance;
    const error = attendanceError(booking, next);
    if (error) return res.status(409).json({ error });

    const actor = await prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { email: true },
    });

    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data: next === 'UNKNOWN'
        ? { attendance: next, attendanceAt: null, attendanceBy: null }
        : { attendance: next, attendanceAt: new Date(), attendanceBy: actor.email },
      select: { attendance: true, attendanceAt: true, attendanceBy: true },
    });

    res.json(updated);
  },
);
