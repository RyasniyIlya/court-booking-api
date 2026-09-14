import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { requireAuth, requireStaff } from './shared';

export const bookingSearchRouter = Router();

/** Скільки назад і вперед шукаємо. Рік уперед — абонементні серії. */
const BACK_DAYS = 90;
const AHEAD_DAYS = 365;

/**
 * Що шукати по телефону: хвіст цифр без коду країни й провідного нуля.
 *
 * У базі телефон лежить як +380671234567. Людина диктує «067 123 45 67»,
 * «+38 067…» або «4567» — тож обрізаємо 380 і нуль, а далі шукаємо входження.
 * null — запит не схожий на телефон, шукаємо за імʼям.
 */
export function phoneNeedle(q: string): string | null {
  if (/[^\d\s()+\-]/.test(q)) return null;
  let digits = q.replace(/\D/g, '');
  if (digits.startsWith('380')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return digits.length >= 4 ? digits : null;
}

/**
 * GET /api/admin/bookings/search?q=
 *
 * Дзвінок «я бронював на наступному тижні, хочу перенести» — і модератор
 * гортав дні по одному. Тепер один рядок: телефон або імʼя, броні корту й
 * записи в групи, на три місяці назад і на рік уперед.
 *
 * Без вартового плану навмисно. Картотека клієнтів — можливість плану, а
 * знайти бронь людини, яка дзвонить, мусить уміти будь-який клуб.
 */
bookingSearchRouter.get('/bookings/search', requireAuth, requireStaff, async (req, res) => {
  const parsed = z.object({ q: z.string().trim().min(2).max(60) }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const q = parsed.data.q;
  const needle = phoneNeedle(q);
  const now = new Date();
  const text = { contains: q, mode: 'insensitive' as const };

  const seatMatch = needle
    ? { customerPhone: { contains: needle } }
    : { customerName: text };

  const match = needle
    ? [
      { customerPhone: { contains: needle } },
      { customer: { phone: { contains: needle } } },
      { seats: { some: seatMatch } },
    ]
    : [
      { customerName: text },
      { title: text },
      { customer: { name: text } },
      { seats: { some: seatMatch } },
    ];

  const base = {
    clubId: req.auth!.clubId,
    OR: match,
    startTime: {
      gte: new Date(now.getTime() - BACK_DAYS * 86_400_000),
      lte: new Date(now.getTime() + AHEAD_DAYS * 86_400_000),
    },
  };

  const select = {
    id: true, startTime: true, endTime: true, status: true, attendance: true,
    customerName: true, customerPhone: true, title: true, capacity: true,
    priceTotal: true, pricePerSeat: true,
    court: { select: { name: true } },
    trainer: { select: { name: true } },
    /* Хто саме з групи підійшов під запит — інакше «Ранкова група» у
       видачі не пояснює, чому вона тут. */
    seats: { where: seatMatch, select: { id: true, customerName: true, customerPhone: true, status: true } },
  };

  const [upcoming, past] = await Promise.all([
    prisma.booking.findMany({ where: { ...base, endTime: { gt: now } }, orderBy: { startTime: 'asc' }, take: 25, select }),
    prisma.booking.findMany({ where: { ...base, endTime: { lte: now } }, orderBy: { startTime: 'desc' }, take: 15, select }),
  ]);

  res.json({ upcoming, past });
});
