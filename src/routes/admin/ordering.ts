import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { requireAuth, requireStaff, requireFeature } from './shared';

export const orderingRouter = Router();

/**
 * Порядок кортів і тренерів, як його хоче бачити клуб: у сітці кабінету,
 * у віджеті й у випадайках.
 *
 * Весь список одним запросом, а не PATCH sortOrder по одному. Перестановка
 * двох рядків — це дві зміни, і якщо друга не дійде, у базі лишаться два
 * однакові номери, а порядок стане випадковим. Тут або весь новий порядок,
 * або нічого (транзакція).
 *
 * Список має бути ПОВНИМ — усі корти (тренери) клубу, включно зі схованими,
 * кожен рівно раз. Інакше незгаданий рядок лишився б зі старим номером
 * посеред нового порядку, і результат залежав би від того, що сервер
 * «додумав». Чужий id чи неповний список — 409, нічого не змінюється.
 */

const orderSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(200)
      .refine((ids) => new Set(ids).size === ids.length, 'duplicate ids'),
  })
  .strict();

type Model = 'court' | 'trainer';

function mountOrder(path: string, model: Model, guards: ReturnType<typeof requireFeature>[] = []) {
  orderingRouter.put(path, requireAuth, requireStaff, ...guards, async (req, res) => {
    const parsed = orderSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const clubId = req.auth!.clubId;
    const { ids } = parsed.data;

    /* Звичайний `prisma[model]` TypeScript не зводить до одного типу
       делегата, тому дві явні гілки — зате без any. */
    const existing = model === 'court'
      ? await prisma.court.findMany({ where: { clubId }, select: { id: true } })
      : await prisma.trainer.findMany({ where: { clubId }, select: { id: true } });

    const own = new Set(existing.map((row) => row.id));
    if (own.size !== ids.length || ids.some((id) => !own.has(id))) {
      return res.status(409).json({ error: 'ORDER_MISMATCH' });
    }

    await prisma.$transaction(ids.map((id, index) => (model === 'court'
      ? prisma.court.update({ where: { id }, data: { sortOrder: index } })
      : prisma.trainer.update({ where: { id }, data: { sortOrder: index } }))));

    res.json({ ok: true });
  });
}

mountOrder('/courts/order', 'court');
mountOrder('/trainers/order', 'trainer', [requireFeature('trainers')]);
