import { Router, type Request } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import type { NoteSubject } from '@prisma/client';
import { requireAuth, requireStaff, param } from './shared';

/**
 * Один рушій нотаток на дві сутності — тренер і корт. Раніше окремий
 * TrainerNote тільки для тренерів; коли ту саму потребу озвучили для
 * кортів (розміри, для кого — і окремо відгук з оцінкою), дублювати
 * роути заради різниці в одному полі (courtId замість trainerId, і чи
 * можна лишити оцінку) сенсу не було. mountNoteRoutes монтує GET/POST/DELETE
 * під переданий path — trainers.ts і courts.ts викликають її кожен зі своїм
 * шляхом і своєю перевіркою "сутність належить клубу".
 *
 * Права й форма запису однакові для обох: журнал, а не чернетка — пише
 * персонал (OWNER/ADMIN) після входу, видаляє автор або власник. Читання
 * відкрите персоналу завжди; для тренера про самого себе — теж.
 */

type NoteScope = { trainerId: string | null; courtId: string | null };

export function mountNoteRoutes(
  router: Router,
  opts: {
    /** напр. '/trainers/:id/notes' — очікує параметр :id у шляху */
    path: string;
    subject: NoteSubject;
    /** Підтверджує, що сутність існує і належить клубу з токена. */
    findInClub: (clubId: string, id: string) => Promise<{ id: string } | null>;
    /** Куди писати id сутності — рівно одна з двох nullable-колонок Note. */
    scope: (id: string) => NoteScope;
    /** Тільки для відгуку на корт: чи дозволена оцінка 1–5. */
    ratingAllowed?: boolean;
    /**
     * Тільки для тренера: чия справа. Якщо роль TRAINER і це не її id —
     * 404 (не 403 — інакше сама відмінність кодів видала б, що чужий id
     * узагалі існує).
     */
    selfOnlyId?: (req: Request) => string | null;
    /**
     * Читання теж тільки персоналу. Для тренерської справи — false: сам
     * тренер читає (звужено до себе через selfOnlyId), для корту — true,
     * бо в корту немає "власного" акаунта, тільки OWNER/ADMIN.
     */
    readRequiresStaff?: boolean;
  },
) {
  const readGuards = opts.readRequiresStaff
    ? [requireAuth, requireStaff]
    : [requireAuth];

  const bodySchema = opts.ratingAllowed
    ? z.object({
        text: z.string().trim().min(1).max(1000),
        rating: z.number().int().min(1).max(5).nullable().optional(),
      })
    : z.object({
        text: z.string().trim().min(1).max(1000),
      });

  const noteSelect = {
    id: true,
    text: true,
    rating: true,
    authorEmail: true,
    authorRole: true,
    authorId: true,
    createdAt: true,
  } as const;

  router.get(opts.path, ...readGuards, async (req, res) => {
    const id = param(req, 'id');

    if (opts.selfOnlyId && req.auth!.role === 'TRAINER' && opts.selfOnlyId(req) !== id) {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }

    const subj = await opts.findInClub(req.auth!.clubId, id);

    if (!subj) {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }

    const notes = await prisma.note.findMany({
      where: { subject: opts.subject, ...opts.scope(id) },
      orderBy: { createdAt: 'desc' },
      select: noteSelect,
    });

    res.json(notes);
  });

  router.post(
    opts.path,
    requireAuth,
    requireStaff,
    async (req, res) => {
      const parsed = bodySchema.safeParse(req.body);

      if (!parsed.success) {
        return res.status(400).json({ error: 'BAD_REQUEST' });
      }

      const id = param(req, 'id');
      const subj = await opts.findInClub(req.auth!.clubId, id);

      if (!subj) {
        return res.status(404).json({ error: 'NOT_FOUND' });
      }

      const me = await prisma.user.findUnique({
        where: { id: req.auth!.userId },
        select: { email: true, role: true },
      });

      const rating = opts.ratingAllowed
        ? ((parsed.data as { rating?: number | null }).rating ?? null)
        : null;

      const note = await prisma.note.create({
        data: {
          subject: opts.subject,
          ...opts.scope(id),
          text: parsed.data.text,
          rating,
          authorId: req.auth!.userId,
          authorEmail: me?.email ?? '',
          authorRole: me?.role ?? 'ADMIN',
        },
        select: noteSelect,
      });

      res.status(201).json(note);
    },
  );

  router.delete(
    `${opts.path}/:noteId`,
    requireAuth,
    requireStaff,
    async (req, res) => {
      const id = param(req, 'id');
      const noteId = param(req, 'noteId');

      const subj = await opts.findInClub(req.auth!.clubId, id);

      if (!subj) {
        return res.status(404).json({ error: 'NOT_FOUND' });
      }

      const note = await prisma.note.findFirst({
        where: { id: noteId, subject: opts.subject, ...opts.scope(id) },
        select: { authorId: true },
      });

      if (!note) {
        return res.status(404).json({ error: 'NOT_FOUND' });
      }

      // Власник прибирає будь-який запис, модератор — тільки свій: інакше
      // модератор міг би підчистити зауваження, яке йому написав власник.
      if (req.auth!.role !== 'OWNER' && note.authorId !== req.auth!.userId) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }

      await prisma.note.delete({ where: { id: noteId } });

      res.json({ ok: true });
    },
  );
}
