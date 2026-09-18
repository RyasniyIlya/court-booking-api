import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { requireAuth, requireRole, param } from './shared';
import { calendarDateText, birthDateValue } from '../../lib/birthday';
import { shiftForDate, shiftMinutes, type ShiftKind } from '../../lib/staffShift';

export const staffShiftsRouter = Router();

/* STAFF SHIFTS — табель змін співробітників кабінету                         */
/* -------------------------------------------------------------------------- */

/**
 * Хто пише і хто читає.
 *
 * Пише тільки OWNER. Це головне правило файлу: модератор веде клуб майже
 * нарівні з власником, але графік — це не операційна дія, а домовленість
 * про роботу. Людина, яка може переписати власну зміну, робить табель
 * марним рівно в той момент, коли він уперше знадобився.
 *
 * Читає власник (усіх) і співробітник (тільки себе). Тренер сюди не
 * ходить: у нього свій графік і свої роути.
 */

const HOURS = z.array(z.object({
  weekday: z.number().int().min(0).max(6),
  openMinute: z.number().int().min(0).max(1799),
  closeMinute: z.number().int().min(0).max(1800),
  isClosed: z.boolean(),
}).superRefine((row, ctx) => {
  if (!row.isClosed && row.closeMinute <= row.openMinute) {
    ctx.addIssue({ code: 'custom', message: 'closeMinute must be after openMinute' });
  }
})).length(7).superRefine((rows, ctx) => {
  if (new Set(rows.map((row) => row.weekday)).size !== 7) {
    ctx.addIssue({ code: 'custom', message: 'Every weekday must be present once' });
  }
});

const INTERVAL = z.object({
  startMinute: z.number().int().min(0).max(1799),
  endMinute: z.number().int().min(1).max(1800),
}).refine((row) => row.endMinute > row.startMinute, 'end must be after start');

const SHIFT = z.object({
  kind: z.enum(['WORKING', 'UNAVAILABLE', 'DAY_OFF', 'VACATION']),
  intervals: z.array(INTERVAL).max(8),
  note: z.string().trim().max(200).nullable().optional(),
}).superRefine((value, ctx) => {
  const closed = value.kind === 'DAY_OFF' || value.kind === 'VACATION';
  if (!closed && value.intervals.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'interval required' });
  }
  const sorted = [...value.intervals].sort((a, b) => a.startMinute - b.startMinute);
  if (sorted.some((row, index) => index > 0 && row.startMinute < sorted[index - 1].endMinute)) {
    ctx.addIssue({ code: 'custom', message: 'intervals overlap' });
  }
});

const closedKind = (kind: ShiftKind) => kind === 'DAY_OFF' || kind === 'VACATION';

/**
 * Співробітник цього клубу, якому взагалі можна вести табель.
 *
 * Тренер сюди не потрапляє навмисно: його години живуть на картці
 * тренера й керують тим, кого бачить гравець у віджеті. Два графіки на
 * одну людину — це два джерела правди, і питання «чому мене немає в
 * розкладі» отримало б дві різні відповіді.
 */
async function rosterUser(clubId: string, id: string) {
  return prisma.user.findFirst({
    where: { id, clubId, role: { in: ['OWNER', 'ADMIN'] } },
    select: { id: true, email: true, name: true, role: true },
  });
}

/** Власник бачить будь-кого, решта — тільки себе. */
const mayRead = (auth: { role: string; userId: string }, id: string) =>
  auth.role === 'OWNER' || auth.userId === id;

/**
 * GET /api/admin/staff/:id/shifts?from=&to=
 *
 * Тижневий шаблон і винятки на діапазон дат — усе, з чого кабінет малює
 * табель. Дні не розгортаємо: діапазон у рік — це 365 рядків на людину,
 * і клієнт усе одно малює місяць за раз.
 */
staffShiftsRouter.get('/staff/:id/shifts', requireAuth, async (req, res) => {
  const id = z.string().uuid().safeParse(param(req, 'id'));
  if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  if (!mayRead(req.auth!, id.data)) return res.status(403).json({ error: 'FORBIDDEN' });

  const range = z.object({ from: calendarDateText, to: calendarDateText }).safeParse(req.query);
  if (!range.success || range.data.to < range.data.from) return res.status(400).json({ error: 'BAD_REQUEST' });

  const user = await rosterUser(req.auth!.clubId, id.data);
  if (!user) return res.status(404).json({ error: 'NOT_FOUND' });

  const [hours, shifts] = await Promise.all([
    prisma.staffHours.findMany({ where: { userId: user.id }, orderBy: { weekday: 'asc' } }),
    prisma.staffShift.findMany({
      where: { userId: user.id, date: { gte: birthDateValue(range.data.from), lte: birthDateValue(range.data.to) } },
      orderBy: { date: 'asc' },
    }),
  ]);

  res.json({
    user,
    /* configured — чи графік узагалі заповнено. Порожній шаблон означає
       «ще не вели табель», а не «людина не працює жодного дня», і кабінет
       має сказати саме це. */
    configured: hours.length > 0,
    hours,
    shifts: shifts.map((row) => ({ ...row, date: row.date.toISOString().slice(0, 10) })),
    /* Хто може правити — щоб кабінет не малював кнопок, які отримають 403. */
    canEdit: req.auth!.role === 'OWNER',
  });
});

/**
 * PUT /api/admin/staff/:id/shifts/hours — тижневий шаблон, сім рядків.
 * Тільки власник.
 */
staffShiftsRouter.put('/staff/:id/shifts/hours', requireAuth, requireRole('OWNER'), async (req, res) => {
  const id = z.string().uuid().safeParse(param(req, 'id'));
  const parsed = HOURS.safeParse(req.body?.hours);
  if (!id.success || !parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const user = await rosterUser(req.auth!.clubId, id.data);
  if (!user) return res.status(404).json({ error: 'NOT_FOUND' });

  /* Сім рядків одним рухом: половина збереженого шаблону — це графік,
     якому не можна вірити. */
  await prisma.$transaction(parsed.data.map((row) => prisma.staffHours.upsert({
    where: { userId_weekday: { userId: user.id, weekday: row.weekday } },
    create: { userId: user.id, ...row },
    update: { openMinute: row.openMinute, closeMinute: row.closeMinute, isClosed: row.isClosed },
  })));

  res.json({ ok: true });
});

/**
 * DELETE /api/admin/staff/:id/shifts/hours — прибрати шаблон цілком.
 *
 * Не те саме, що сім закритих днів: «графіка немає» і «людина не працює
 * жодного дня» читаються по-різному, і власник має могти повернутись до
 * першого стану.
 */
staffShiftsRouter.delete('/staff/:id/shifts/hours', requireAuth, requireRole('OWNER'), async (req, res) => {
  const id = z.string().uuid().safeParse(param(req, 'id'));
  if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const user = await rosterUser(req.auth!.clubId, id.data);
  if (!user) return res.status(404).json({ error: 'NOT_FOUND' });

  await prisma.staffHours.deleteMany({ where: { userId: user.id } });
  res.json({ ok: true });
});

/** PUT /api/admin/staff/:id/shifts/:date — підміна, вихідний, відпустка. */
staffShiftsRouter.put('/staff/:id/shifts/:date', requireAuth, requireRole('OWNER'), async (req, res) => {
  const id = z.string().uuid().safeParse(param(req, 'id'));
  const date = calendarDateText.safeParse(param(req, 'date'));
  const parsed = SHIFT.safeParse(req.body);
  if (!id.success || !date.success || !parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const user = await rosterUser(req.auth!.clubId, id.data);
  if (!user) return res.status(404).json({ error: 'NOT_FOUND' });

  const actor = await prisma.user.findUniqueOrThrow({
    where: { id: req.auth!.userId }, select: { email: true },
  });
  const { kind, note } = parsed.data;
  const isClosed = closedKind(kind);
  const intervals = isClosed ? [] : parsed.data.intervals;

  const value = await prisma.staffShift.upsert({
    where: { userId_date: { userId: user.id, date: birthDateValue(date.data) } },
    create: { userId: user.id, date: birthDateValue(date.data), kind, isClosed, intervals, note: note ?? null, updatedBy: actor.email },
    update: { kind, isClosed, intervals, note: note ?? null, updatedBy: actor.email },
  });

  res.json({ ...value, date: value.date.toISOString().slice(0, 10) });
});

/** DELETE /api/admin/staff/:id/shifts/:date — повернути день до шаблону. */
staffShiftsRouter.delete('/staff/:id/shifts/:date', requireAuth, requireRole('OWNER'), async (req, res) => {
  const id = z.string().uuid().safeParse(param(req, 'id'));
  const date = calendarDateText.safeParse(param(req, 'date'));
  if (!id.success || !date.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  /* deleteMany з клубом у where: підміна id в адресі не дає стерти чужий
     день у сусідньому клубі — просто нічого не знайдеться. */
  await prisma.staffShift.deleteMany({
    where: { userId: id.data, date: birthDateValue(date.data), user: { clubId: req.auth!.clubId } },
  });
  res.json({ ok: true });
});

/**
 * GET /api/admin/staff-shifts?date= — табель на день: хто сьогодні працює.
 *
 * Читають усі співробітники кабінету, не тільки власник: «хто сьогодні на
 * зміні» — питання, заради якого табель і заводять, і ховати відповідь
 * від самої зміни немає сенсу.
 */
staffShiftsRouter.get('/staff-shifts', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const date = calendarDateText.safeParse(req.query.date);
  if (!date.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const people = await prisma.user.findMany({
    where: { clubId: req.auth!.clubId, role: { in: ['OWNER', 'ADMIN'] } },
    select: {
      id: true, name: true, email: true, role: true,
      shiftHours: { orderBy: { weekday: 'asc' } },
      shiftExceptions: { where: { date: birthDateValue(date.data) } },
    },
    orderBy: { createdAt: 'asc' },
  });

  res.json({
    date: date.data,
    roster: people.map((person) => {
      const shift = shiftForDate(person.shiftHours, person.shiftExceptions, date.data);
      return {
        id: person.id,
        name: person.name,
        email: person.email,
        role: person.role,
        kind: shift.kind,
        source: shift.source,
        intervals: shift.intervals,
        minutes: shiftMinutes(shift),
        note: shift.note,
      };
    }),
  });
});
