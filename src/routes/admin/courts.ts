import { Router, raw } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { requireAuth, requireStaff, param } from './shared';
import { mountNoteRoutes } from './notes';
import {
  COURT_PHOTO_LIMIT, COURT_PHOTO_MAX_BYTES, COURT_PHOTO_MIMES,
  courtPhotoUrl, courtVideoUrl, parseCourtVideo, sniffImage,
} from '../../lib/courtMedia';

/** Знімки корту в списку — тільки id, без байтів. Обкладинка перша. */
const PHOTO_LIST = {
  select: { id: true },
  orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }],
};

const photosToApi = (photos: { id: string }[]) =>
  photos.map((p) => ({ id: p.id, url: courtPhotoUrl(p.id) }));

export const courtsRouter = Router();

/* COURTS                                                                     */
/* -------------------------------------------------------------------------- */

courtsRouter.get(
  '/courts',
  requireAuth,
  async (req, res) => {
    const courts =
      await prisma.court.findMany({
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

    res.json(
      courts.map((c) => ({
        ...c,
        photos: photosToApi(c.photos),
      })),
    );
  },
);

courtsRouter.post(
  '/courts',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const parsed = z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(60),

        pricePerHour:
          z
            .number()
            .int()
            .min(0)
            .default(0),

        slotMinutes:
          z
            .number()
            .int()
            .min(15)
            .max(240)
            .nullable()
            .optional(),

        sortOrder:
          z
            .number()
            .int()
            .default(0),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const court =
      await prisma.court.create({
        data: {
          ...parsed.data,
          slotMinutes:
            parsed.data
              .slotMinutes ??
            null,
          clubId:
            req.auth!.clubId,
        },
      });

    res.status(201).json(
      court,
    );
  },
);

courtsRouter.patch(
  '/courts/:id',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const parsed =
      z.object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .optional(),

        pricePerHour:
          z
            .number()
            .int()
            .min(0)
            .max(100_000_00)
            .optional(),

        slotMinutes:
          z
            .number()
            .int()
            .min(15)
            .max(240)
            .nullable()
            .optional(),

        sortOrder:
          z
            .number()
            .int()
            .min(0)
            .max(999)
            .optional(),

        isActive:
          z
            .boolean()
            .optional(),

        /* Порожній рядок і null — «ролика немає». */
        videoUrl:
          z
            .string()
            .trim()
            .max(300)
            .nullable()
            .optional(),
      })
      .safeParse(
        req.body,
      );

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const data: Omit<typeof parsed.data, 'videoUrl'> & { videoUrl?: string | null } = {
      ...parsed.data,
    };

    /* У базу лягає не те, що вписав клуб, а канонічна адреса, зібрана з
       розпізнаного ідентифікатора: віджет кладе її в <iframe>, і чужому
       хосту там не місце. */
    if (parsed.data.videoUrl !== undefined) {
      const rawUrl = parsed.data.videoUrl;
      if (!rawUrl) {
        data.videoUrl = null;
      } else {
        const video = parseCourtVideo(rawUrl);
        if (!video) {
          return res.status(400).json({
            error: 'BAD_VIDEO_URL',
          });
        }
        data.videoUrl = courtVideoUrl(video);
      }
    }

    const result =
      await prisma.court.updateMany({
        where: {
          id: param(
            req,
            'id',
          ),
          clubId:
            req.auth!.clubId,
        },
        data,
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

courtsRouter.delete(
  '/courts/:id',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const court =
      await prisma.court.findFirst({
        where: {
          id: param(
            req,
            'id',
          ),
          clubId:
            req.auth!.clubId,
        },
      });

    if (!court) {
      return res.status(404).json({
        error: 'NOT_FOUND',
      });
    }

    const used =
      await prisma.booking.count({
        where: {
          courtId:
            court.id,
        },
      });

    if (used > 0) {
      await prisma.court.update({
        where: {
          id: court.id,
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

    await prisma.court.delete({
      where: {
        id: court.id,
      },
    });

    res.json({
      ok: true,
      hidden: false,
    });
  },
);

/* ФОТО КОРТУ                                                                 */
/* -------------------------------------------------------------------------- */
//
// Знімок їде сирим тілом, як логотип і фото з комори: у запиті рівно один
// файл, і multer з тимчасовими файлами заради нього не потрібен. Кілька
// знімків кабінет шле кількома запитами — так відмова одного файлу не
// валить решту.

const photoList = (clubId: string, courtId: string) =>
  prisma.courtPhoto.findMany({ where: { courtId, clubId }, ...PHOTO_LIST });

courtsRouter.post(
  '/courts/:id/photos',
  requireAuth,
  requireStaff,
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
    const court = await prisma.court.findFirst({
      where: { id: id.data, clubId },
      select: { id: true },
    });
    if (!court) return res.status(404).json({ error: 'NOT_FOUND' });

    const last = await prisma.courtPhoto.aggregate({
      where: { courtId: court.id, clubId },
      _count: true,
      _max: { sortOrder: true },
    });
    if (last._count >= COURT_PHOTO_LIMIT) {
      return res.status(409).json({ error: 'PHOTO_LIMIT', limit: COURT_PHOTO_LIMIT });
    }

    await prisma.courtPhoto.create({
      data: {
        courtId: court.id,
        clubId,
        data: body,
        mime,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
      select: { id: true },
    });

    res.status(201).json({ photos: photosToApi(await photoList(clubId, court.id)) });
  },
);

/**
 * PUT /api/admin/courts/:id/photos/order  { ids }
 *
 * Весь порядок одним запитом — як у кортів і тренерів (ordering.ts). Перший
 * у списку стає обкладинкою. Неповний список або чужий id — 409.
 */
courtsRouter.put(
  '/courts/:id/photos/order',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const id = z.string().uuid().safeParse(param(req, 'id'));
    const parsed = z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(COURT_PHOTO_LIMIT)
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
      prisma.courtPhoto.update({ where: { id: photoId }, data: { sortOrder: index } })));

    res.json({ photos: photosToApi(await photoList(clubId, id.data)) });
  },
);

courtsRouter.delete(
  '/courts/:id/photos/:photoId',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const id = z.string().uuid().safeParse(param(req, 'id'));
    const photoId = z.string().uuid().safeParse(param(req, 'photoId'));
    if (!id.success || !photoId.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const clubId = req.auth!.clubId;
    const result = await prisma.courtPhoto.deleteMany({
      where: { id: photoId.data, courtId: id.data, clubId },
    });
    if (result.count === 0) return res.status(404).json({ error: 'NOT_FOUND' });

    res.json({ photos: photosToApi(await photoList(clubId, id.data)) });
  },
);

/* НОТАТКИ Й ВІДГУКИ (Note, subject = COURT)                                  */
/* -------------------------------------------------------------------------- */
//
// Той самий рушій, що й в особовій справі тренера — див. notes.ts. Запис без
// rating — довідкова замітка («20×40, ґрунт, для дітей»); запис з rating
// (1–5) — відгук персоналу про стан корту. Одна стрічка, а не дві вкладки:
// відгук — це та сама замітка, просто з оцінкою. У корту немає "власного"
// акаунта на кшталт тренерського, тому читання теж тільки персоналу.

mountNoteRoutes(courtsRouter, {
  path: '/courts/:id/notes',
  subject: 'COURT',
  findInClub: (clubId, id) =>
    prisma.court.findFirst({
      where: { id, clubId },
      select: { id: true },
    }),
  scope: (id) => ({ trainerId: null, courtId: id }),
  ratingAllowed: true,
  readRequiresStaff: true,
});
