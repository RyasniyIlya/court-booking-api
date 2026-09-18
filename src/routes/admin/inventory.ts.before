import { Router, raw } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { requireAuth, requireStaff, param } from './shared';

/**
 * /api/admin/inventory — комора клубу.
 *
 * Питання «скільки в нас цілих ракеток» виникає рівно тоді, коли відповідь
 * потрібна негайно: перед турніром або коли гравець біля стійки просить
 * інвентар напрокат. Досі відповідь жила в голові адміністратора й у
 * зошиті, тобто була недоступна другій зміні.
 *
 * Фото — окремим запитом і окремим роутом, і це головне архітектурне
 * рішення тут: картинки лежать байтами в тому ж рядку, і якби список
 * тягнув їх разом із назвами, кожне відкриття вкладки качало б з бази
 * мегабайти заради двадцяти рядків тексту. Той самий урок, що й з
 * логотипом клубу (`omit: { logoData: true }` у публічному роуті).
 */
export const inventoryRouter = Router();

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * 1 МБ на фото.
 *
 * Більше за логотип (512 КБ), бо це знімок із телефона, а не іконка в
 * шапці; менше за «скільки дадуть», бо двадцять позицій по 5 МБ — це вже
 * сто мегабайт у базі на один клуб.
 */
const MAX_BYTES = 1024 * 1024;

/**
 * Перевірка за вмістом, а не за заявленим Content-Type: заголовок надсилає
 * клієнт, і він може збрехати. SVG не приймаємо навмисно — він виконує
 * скрипти, а віддається з нашого домену.
 */
function sniff(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** Список і картка — без байтів фото. Замість них адреса й мітка часу. */
const LIST_SELECT = {
  id: true,
  name: true,
  category: true,
  quantity: true,
  unit: true,
  note: true,
  photoMime: true,
  photoUpdatedAt: true,
  sortOrder: true,
} as const;

type Row = {
  photoMime: string | null;
  photoUpdatedAt: Date | null;
  id: string;
};

/**
 * Мітка часу в адресі — щоб браузер, який тримає картинку рік, побачив нову
 * одразу після заміни. Той самий прийом, що й у логотипа.
 */
const toApi = <T extends Row>(item: T) => ({
  ...item,
  photoUrl: item.photoMime
    ? `/api/public/inventory/${item.id}/photo?v=${item.photoUpdatedAt?.getTime() ?? 0}`
    : null,
});

const itemShape = {
  name: z.string().trim().min(1).max(80),
  category: z.string().trim().max(40).nullable(),
  quantity: z.number().int().min(0).max(1_000_000),
  unit: z.string().trim().max(16).nullable(),
  note: z.string().trim().max(300).nullable(),
  sortOrder: z.number().int().min(0).max(10_000),
};

const createSchema = z.object({
  ...itemShape,
  category: itemShape.category.default(null),
  quantity: itemShape.quantity.default(0),
  unit: itemShape.unit.default(null),
  note: itemShape.note.default(null),
  sortOrder: itemShape.sortOrder.default(0),
});

const patchSchema = z.object(itemShape).partial();

/** Порожній рядок із форми — це «не вказано», а не значення. */
const blankToNull = (v: string | null | undefined) => (v ? v : null);

inventoryRouter.get('/inventory', requireAuth, async (req, res) => {
  const items = await prisma.inventoryItem.findMany({
    where: { clubId: req.auth!.clubId },
    select: LIST_SELECT,
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

  res.json(items.map(toApi));
});

inventoryRouter.post('/inventory', requireAuth, requireStaff, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const d = parsed.data;
  const item = await prisma.inventoryItem.create({
    data: {
      clubId: req.auth!.clubId,
      name: d.name,
      category: blankToNull(d.category),
      quantity: d.quantity,
      unit: blankToNull(d.unit),
      note: blankToNull(d.note),
      sortOrder: d.sortOrder,
    },
    select: LIST_SELECT,
  });

  res.status(201).json(toApi(item));
});

inventoryRouter.patch('/inventory/:id', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().safeParse(param(req, 'id'));
  if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const current = await prisma.inventoryItem.findFirst({
    where: { id: id.data, clubId: req.auth!.clubId },
    select: { id: true },
  });
  if (!current) return res.status(404).json({ error: 'NOT_FOUND' });

  const p = parsed.data;
  const item = await prisma.inventoryItem.update({
    where: { id: id.data },
    data: {
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.category !== undefined ? { category: blankToNull(p.category) } : {}),
      ...(p.quantity !== undefined ? { quantity: p.quantity } : {}),
      ...(p.unit !== undefined ? { unit: blankToNull(p.unit) } : {}),
      ...(p.note !== undefined ? { note: blankToNull(p.note) } : {}),
      ...(p.sortOrder !== undefined ? { sortOrder: p.sortOrder } : {}),
    },
    select: LIST_SELECT,
  });

  res.json(toApi(item));
});

inventoryRouter.delete('/inventory/:id', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().safeParse(param(req, 'id'));
  if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const result = await prisma.inventoryItem.deleteMany({
    where: { id: id.data, clubId: req.auth!.clubId },
  });
  if (result.count === 0) return res.status(404).json({ error: 'NOT_FOUND' });

  res.json({ ok: true });
});

/**
 * POST /api/admin/inventory/:id/photo — сирим тілом, як логотип.
 *
 * multipart тут не потрібен: у формі рівно один файл, а multer приніс би
 * тимчасові файли на диску заради нього одного.
 */
inventoryRouter.post(
  '/inventory/:id/photo',
  requireAuth,
  requireStaff,
  raw({ type: '*/*', limit: MAX_BYTES }),
  async (req, res) => {
    const id = z.string().uuid().safeParse(param(req, 'id'));
    if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: 'EMPTY_FILE' });
    }

    const mime = sniff(body);
    if (!mime || !ALLOWED.has(mime)) {
      return res.status(415).json({ error: 'UNSUPPORTED_TYPE', allowed: [...ALLOWED] });
    }

    const current = await prisma.inventoryItem.findFirst({
      where: { id: id.data, clubId: req.auth!.clubId },
      select: { id: true },
    });
    if (!current) return res.status(404).json({ error: 'NOT_FOUND' });

    const item = await prisma.inventoryItem.update({
      where: { id: id.data },
      data: { photoData: body, photoMime: mime, photoUpdatedAt: new Date() },
      select: LIST_SELECT,
    });

    res.json(toApi(item));
  },
);

inventoryRouter.delete('/inventory/:id/photo', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().safeParse(param(req, 'id'));
  if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const current = await prisma.inventoryItem.findFirst({
    where: { id: id.data, clubId: req.auth!.clubId },
    select: { id: true },
  });
  if (!current) return res.status(404).json({ error: 'NOT_FOUND' });

  const item = await prisma.inventoryItem.update({
    where: { id: id.data },
    data: { photoData: null, photoMime: null, photoUpdatedAt: null },
    select: LIST_SELECT,
  });

  res.json(toApi(item));
});
