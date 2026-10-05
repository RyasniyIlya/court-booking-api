import { Router, raw } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { requireAuth, requireStaff, requireFeature, param } from './shared';
import { mountNoteRoutes } from './notes';
import { calendarDateText, birthDateValue } from '../../lib/birthday';
import {
  COURT_PHOTO_MAX_BYTES, COURT_PHOTO_MIMES, TRAINER_PHOTO_LIMIT, sniffImage, trainerPhotoUrl,
} from '../../lib/courtMedia';
import { adminRating, listTrainerRatings, ratingSummaries } from '../../lib/trainerRating';

/** Фото тренера в списку — тільки id, без байтів. Аватар перший. */
const PHOTO_LIST = {
  select: { id: true },
  orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }],
};

const photosToApi = (photos: { id: string }[]) =>
  photos.map((p) => ({ id: p.id, url: trainerPhotoUrl(p.id) }));

export const trainersRouter = Router();

/* TRAINERS                                                                   */
/* -------------------------------------------------------------------------- */

trainersRouter.get(
  '/trainers',
  requireAuth,
  async (req, res) => {
    const trainers =
      await prisma.trainer.findMany({
        where: {
          clubId:
            req.auth!.clubId,
        },
        orderBy: [
          {
            isActive:
              'desc',
          },
          {
            sortOrder:
              'asc',
          },
          {
            name:
              'asc',
          },
        ],
        include: {
          photos: PHOTO_LIST,
        },
      });

    /* Середні всіх тренерів одним groupBy, а не запитом на кожного. */
    const ratings =
      await ratingSummaries(
        trainers.map((t) => t.id),
        req.auth!.clubId,
      );

    res.json(
      trainers.map((t) => ({
        ...t,
        photos: photosToApi(t.photos),
        rating: adminRating(ratings.get(t.id)),
      })),
    );
  },
);

/**
 * GET /api/admin/trainers/:id/ratings?limit=50 — відгуки про тренера.
 *
 * Імена гравців і коментарі бачить тільки персонал: гравцям віджет віддає
 * лише середню (і то від трьох оцінок). Відмови сюди не потрапляють.
 */
trainersRouter.get(
  '/trainers/:id/ratings',
  requireAuth,
  requireStaff,
  requireFeature('trainers'),
  async (req, res) => {
    const id = z.string().uuid().safeParse(param(req, 'id'));
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).safeParse(req.query);
    if (!id.success || !query.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const result = await listTrainerRatings(id.data, req.auth!.clubId, query.data.limit);
    if (!result) return res.status(404).json({ error: 'NOT_FOUND' });

    res.json(result);
  },
);

const trainerHoursSchema = z.array(z.object({
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

const intervalSchema = z.object({
  startMinute: z.number().int().min(0).max(1799),
  endMinute: z.number().int().min(1).max(1800),
}).refine((row) => row.endMinute > row.startMinute, 'end must be after start');
const exceptionSchema = z.object({
  date: calendarDateText,
  isClosed: z.boolean().optional(),
  kind: z.enum(['WORKING', 'UNAVAILABLE', 'DAY_OFF', 'VACATION']).optional(),
  intervals: z.array(intervalSchema).max(8),
  note: z.string().trim().max(200).nullable().optional(),
}).superRefine((value, ctx) => {
  const closed = value.kind === 'DAY_OFF' || value.kind === 'VACATION' || (value.kind === undefined && value.isClosed);
  if (!closed && value.intervals.length === 0) ctx.addIssue({ code: 'custom', message: 'interval required' });
  const sorted = [...value.intervals].sort((a, b) => a.startMinute - b.startMinute);
  if (sorted.some((row, index) => index > 0 && row.startMinute < sorted[index - 1].endMinute)) {
    ctx.addIssue({ code: 'custom', message: 'intervals overlap' });
  }
});

trainersRouter.get('/trainer-schedule/me', requireAuth, async (req, res) => {
  if (req.auth!.role !== 'TRAINER' || !req.auth!.trainerId) return res.status(403).json({ error: 'TRAINER_NOT_LINKED' });
  const parsed = z.object({ from: calendarDateText, to: calendarDateText }).safeParse(req.query);
  if (!parsed.success || parsed.data.to < parsed.data.from) return res.status(400).json({ error: 'BAD_REQUEST' });
  const exceptions = await prisma.trainerScheduleException.findMany({
    where: { trainerId: req.auth!.trainerId, date: { gte: birthDateValue(parsed.data.from), lte: birthDateValue(parsed.data.to) } },
    orderBy: { date: 'asc' },
  });
  res.json(exceptions.map((row) => ({ ...row, date: row.date.toISOString().slice(0, 10) })));
});

trainersRouter.put('/trainer-schedule/me/range', requireAuth, requireFeature('trainers'), async (req, res) => {
  if (req.auth!.role !== 'TRAINER' || !req.auth!.trainerId) return res.status(403).json({ error: 'TRAINER_NOT_LINKED' });
  const bounds = z.object({ from: calendarDateText, to: calendarDateText }).safeParse(req.body);
  if (!bounds.success || bounds.data.to < bounds.data.from) return res.status(400).json({ error: 'BAD_REQUEST' });
  const parsed = exceptionSchema.safeParse({ ...req.body, date: bounds.data.from });
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const first = birthDateValue(bounds.data.from);
  const last = birthDateValue(bounds.data.to);
  const count = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
  if (count > 366) return res.status(400).json({ error: 'RANGE_TOO_LARGE' });
  const trainer = await prisma.trainer.findFirst({ where: { id: req.auth!.trainerId, clubId: req.auth!.clubId } });
  if (!trainer) return res.status(404).json({ error: 'TRAINER_NOT_FOUND' });
  const actor = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId }, select: { email: true } });
  const d = parsed.data;
  const kind = d.kind ?? (d.isClosed ? 'DAY_OFF' : 'WORKING');
  const isClosed = kind === 'DAY_OFF' || kind === 'VACATION';
  const dates = Array.from({ length: count }, (_, index) => {
    const date = new Date(first);
    date.setUTCDate(date.getUTCDate() + index);
    return date;
  });
  await prisma.$transaction(dates.map((date) => prisma.trainerScheduleException.upsert({
    where: { trainerId_date: { trainerId: trainer.id, date } },
    create: { trainerId: trainer.id, date, isClosed, kind,
      intervals: isClosed ? [] : d.intervals, note: d.note, updatedBy: actor.email },
    update: { isClosed, kind, intervals: isClosed ? [] : d.intervals, note: d.note, updatedBy: actor.email },
  })));
  res.json({ ok: true, count });
});

trainersRouter.put('/trainer-schedule/me/:date', requireAuth, requireFeature('trainers'), async (req, res) => {
  if (req.auth!.role !== 'TRAINER' || !req.auth!.trainerId) return res.status(403).json({ error: 'TRAINER_NOT_LINKED' });
  const parsed = exceptionSchema.safeParse({ ...req.body, date: param(req, 'date') });
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const trainer = await prisma.trainer.findFirst({ where: { id: req.auth!.trainerId, clubId: req.auth!.clubId } });
  if (!trainer) return res.status(404).json({ error: 'TRAINER_NOT_FOUND' });
  const actor = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId }, select: { email: true } });
  const d = parsed.data;
  const kind = d.kind ?? (d.isClosed ? 'DAY_OFF' : 'WORKING');
  const isClosed = kind === 'DAY_OFF' || kind === 'VACATION';
  const value = await prisma.trainerScheduleException.upsert({
    where: { trainerId_date: { trainerId: trainer.id, date: birthDateValue(d.date) } },
    create: { trainerId: trainer.id, date: birthDateValue(d.date), isClosed, kind,
      intervals: isClosed ? [] : d.intervals, note: d.note, updatedBy: actor.email },
    update: { isClosed, kind, intervals: isClosed ? [] : d.intervals, note: d.note, updatedBy: actor.email },
  });
  res.json({ ...value, date: value.date.toISOString().slice(0, 10) });
});

trainersRouter.delete('/trainer-schedule/me/:date', requireAuth, requireFeature('trainers'), async (req, res) => {
  if (req.auth!.role !== 'TRAINER' || !req.auth!.trainerId) return res.status(403).json({ error: 'TRAINER_NOT_LINKED' });
  const date = calendarDateText.safeParse(param(req, 'date'));
  if (!date.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  await prisma.trainerScheduleException.deleteMany({
    where: { trainerId: req.auth!.trainerId, date: birthDateValue(date.data), trainer: { clubId: req.auth!.clubId } },
  });
  res.json({ ok: true });
});

/**
 * Особистий графік тренера. Окремий `/me`, а не довільний id: навіть
 * підмінивши адресу запиту, тренер фізично не зможе переписати чужі години.
 */
trainersRouter.get('/trainer-hours/me', requireAuth, async (req, res) => {
  if (req.auth!.role !== 'TRAINER' || !req.auth!.trainerId) {
    return res.status(403).json({ error: 'TRAINER_NOT_LINKED' });
  }

  const trainer = await prisma.trainer.findFirst({
    where: { id: req.auth!.trainerId, clubId: req.auth!.clubId },
    select: {
      id: true,
      hours: { orderBy: { weekday: 'asc' } },
      club: { select: { hours: { orderBy: { weekday: 'asc' } } } },
    },
  });
  if (!trainer) return res.status(404).json({ error: 'TRAINER_NOT_FOUND' });

  res.json({
    configured: trainer.hours.length > 0,
    hours: trainer.hours.length > 0 ? trainer.hours : trainer.club.hours,
  });
});

trainersRouter.put(
  '/trainer-hours/me',
  requireAuth,
  requireFeature('trainers'),
  async (req, res) => {
    if (req.auth!.role !== 'TRAINER' || !req.auth!.trainerId) {
      return res.status(403).json({ error: 'TRAINER_NOT_LINKED' });
    }

    const parsed = trainerHoursSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const trainer = await prisma.trainer.findFirst({
      where: { id: req.auth!.trainerId, clubId: req.auth!.clubId },
      select: { id: true },
    });
    if (!trainer) return res.status(404).json({ error: 'TRAINER_NOT_FOUND' });

    await prisma.$transaction([
      prisma.trainerHours.deleteMany({ where: { trainerId: trainer.id } }),
      prisma.trainerHours.createMany({
        data: parsed.data.map((row) => ({ ...row, trainerId: trainer.id })),
      }),
    ]);

    res.json({ ok: true });
  },
);

const trainerSchema =
  z.object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(80),

    phone: z
      .string()
      .trim()
      .max(30)
      .nullable()
      .optional(),

    pricePerHour: z
      .number()
      .int()
      .min(0)
      .max(10_000_00)
      .default(0),

    note: z
      .string()
      .trim()
      .max(200)
      .nullable()
      .optional(),

    sortOrder: z
      .number()
      .int()
      .min(0)
      .max(999)
      .default(0),

    isActive: z
      .boolean()
      .default(true),
  });

trainersRouter.post(
  '/trainers',
  requireAuth,
  requireStaff,
  requireFeature('trainers'),
  async (req, res) => {
    const parsed =
      trainerSchema.safeParse(
        req.body,
      );

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const trainer =
      await prisma.trainer.create({
        data: {
          ...parsed.data,
          clubId:
            req.auth!.clubId,
        },
      });

    res.status(201).json(
      trainer,
    );
  },
);

trainersRouter.patch(
  '/trainers/:id',
  requireAuth,
  requireStaff,
  requireFeature('trainers'),
  async (req, res) => {
    const parsed =
      trainerSchema
        .partial()
        .safeParse(
          req.body,
        );

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const result =
      await prisma.trainer.updateMany({
        where: {
          id: param(
            req,
            'id',
          ),
          clubId:
            req.auth!.clubId,
        },
        data:
          parsed.data,
      });

    if (
      result.count === 0
    ) {
      return res.status(404).json({
        error: 'NOT_FOUND',
      });
    }

    res.json({
      ok: true,
    });
  },
);

trainersRouter.delete(
  '/trainers/:id',
  requireAuth,
  requireStaff,
  requireFeature('trainers'),
  async (req, res) => {
    const trainer =
      await prisma.trainer.findFirst({
        where: {
          id: param(
            req,
            'id',
          ),
          clubId:
            req.auth!.clubId,
        },
      });

    if (!trainer) {
      return res.status(404).json({
        error: 'NOT_FOUND',
      });
    }

    const used =
      await prisma.booking.count({
        where: {
          trainerId:
            trainer.id,
        },
      });

    if (used > 0) {
      await prisma.trainer.update({
        where: {
          id: trainer.id,
        },
        data: {
          isActive:
            false,
        },
      });

      return res.json({
        ok: true,
        hidden: true,
        bookings:
          used,
      });
    }

    await prisma.trainer.delete({
      where: {
        id: trainer.id,
      },
    });

    res.json({
      ok: true,
      hidden: false,
    });
  },
);

/* ФОТО ТРЕНЕРА                                                              */
/* -------------------------------------------------------------------------- */
//
// Той самий механізм, що й фото корту (courts.ts): знімок їде сирим тілом,
// кілька знімків кабінет шле кількома запитами. Ліміт — чотири.

const photoList = (clubId: string, trainerId: string) =>
  prisma.trainerPhoto.findMany({ where: { trainerId, clubId }, ...PHOTO_LIST });

trainersRouter.post(
  '/trainers/:id/photos',
  requireAuth,
  requireStaff,
  requireFeature('trainers'),
  raw({ type: '*/*', limit: COURT_PHOTO_MAX_BYTES }),
  async (req, res) => {
    const id = z.string().uuid().safeParse(param(req, 'id'));
    if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: 'EMPTY_FILE' });
    }

    const mime = sniffImage(body);
    if (!mime || !COURT_PHOTO_MIMES.has(mime)) {
      return res.status(415).json({ error: 'UNSUPPORTED_TYPE', allowed: [...COURT_PHOTO_MIMES] });
    }

    const clubId = req.auth!.clubId;
    const trainer = await prisma.trainer.findFirst({
      where: { id: id.data, clubId },
      select: { id: true },
    });
    if (!trainer) return res.status(404).json({ error: 'NOT_FOUND' });

    const last = await prisma.trainerPhoto.aggregate({
      where: { trainerId: trainer.id, clubId },
      _count: true,
      _max: { sortOrder: true },
    });
    if (last._count >= TRAINER_PHOTO_LIMIT) {
      return res.status(409).json({ error: 'PHOTO_LIMIT', limit: TRAINER_PHOTO_LIMIT });
    }

    await prisma.trainerPhoto.create({
      data: {
        trainerId: trainer.id,
        clubId,
        data: body,
        mime,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
      select: { id: true },
    });

    res.status(201).json({ photos: photosToApi(await photoList(clubId, trainer.id)) });
  },
);

/**
 * PUT /api/admin/trainers/:id/photos/order  { ids }
 *
 * Весь порядок одним запитом. Перший у списку стає аватаром. Неповний
 * список або чужий id — 409.
 */
trainersRouter.put(
  '/trainers/:id/photos/order',
  requireAuth,
  requireStaff,
  requireFeature('trainers'),
  async (req, res) => {
    const id = z.string().uuid().safeParse(param(req, 'id'));
    const parsed = z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(TRAINER_PHOTO_LIMIT)
          .refine((ids) => new Set(ids).size === ids.length, 'duplicate ids'),
      })
      .strict()
      .safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const clubId = req.auth!.clubId;
    const { ids } = parsed.data;

    const own = new Set((await photoList(clubId, id.data)).map((p) => p.id));
    if (own.size !== ids.length || ids.some((photoId) => !own.has(photoId))) {
      return res.status(409).json({ error: 'ORDER_MISMATCH' });
    }

    await prisma.$transaction(ids.map((photoId, index) =>
      prisma.trainerPhoto.update({ where: { id: photoId }, data: { sortOrder: index } })));

    res.json({ photos: photosToApi(await photoList(clubId, id.data)) });
  },
);

trainersRouter.delete(
  '/trainers/:id/photos/:photoId',
  requireAuth,
  requireStaff,
  requireFeature('trainers'),
  async (req, res) => {
    const id = z.string().uuid().safeParse(param(req, 'id'));
    const photoId = z.string().uuid().safeParse(param(req, 'photoId'));
    if (!id.success || !photoId.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const clubId = req.auth!.clubId;
    const result = await prisma.trainerPhoto.deleteMany({
      where: { id: photoId.data, trainerId: id.data, clubId },
    });
    if (result.count === 0) return res.status(404).json({ error: 'NOT_FOUND' });

    res.json({ photos: photosToApi(await photoList(clubId, id.data)) });
  },
);

/* ОСОБОВА СПРАВА (Note, subject = TRAINER)                                   */
/* -------------------------------------------------------------------------- */
//
// Приватний журнал персоналу про тренера — не плутати з Trainer.note (та одна
// й публічна, летить у віджет). Той самий рушій, що й у courts.ts — див.
// notes.ts. Пише тільки OWNER/ADMIN, тренер про себе тільки читає.

mountNoteRoutes(trainersRouter, {
  path: '/trainers/:id/notes',
  subject: 'TRAINER',
  findInClub: (clubId, id) =>
    prisma.trainer.findFirst({
      where: { id, clubId },
      select: { id: true },
    }),
  scope: (id) => ({ trainerId: id, courtId: null }),
  selfOnlyId: (req) => req.auth!.trainerId,
});
