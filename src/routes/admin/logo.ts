import { Router, raw } from 'express';

import { prisma } from '../../lib/db';
import { requireAuth, requireStaff } from './shared';

export const logoRouter = Router();

/* -------------------------------------------------------------------------- */
/* LOGO                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Логотип клуба — байти, а не файл.
 *
 * Приймаємо сирим тілом (express.raw), а не multipart: у формі рівно одне
 * поле, і тягнути заради нього multer із тимчасовими файлами на диску немає
 * сенсу. Клієнт шле сам файл і ставить Content-Type — тобто рівно те, що
 * віддасть <input type="file">.
 *
 * SVG не приймаємо навмисно. Він виконує скрипти, а віддається з нашого
 * домену — тобто чужий логотип став би XSS у кабінеті сусіднього клуба.
 * Растр таких можливостей не має.
 */
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** 512 КБ. Логотип у шапці показується 34–44 px, більше просто ні до чого. */
const MAX_BYTES = 512 * 1024;

/**
 * Перевірка за вмістом, а не за заявленим Content-Type.
 *
 * Заголовок надсилає клієнт, і він може збрехати: назвати .html «картинкою»
 * і отримати наш домен для довільного вмісту. Сигнатури коротші за будь-яку
 * бібліотеку і закривають рівно цей випадок.
 */
function sniff(buf: Buffer): string | null {
  if (buf.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // WEBP: 'RIFF' .... 'WEBP'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }

  return null;
}

/**
 * POST /api/admin/club/logo
 *
 * Персонал — та сама межа, що й у решти змін клубу. Логотип не гроші, а
 * помилку видно одразу й виправляється вона повторним завантаженням.
 */
logoRouter.post(
  '/club/logo',
  requireAuth,
  requireStaff,
  raw({ type: '*/*', limit: MAX_BYTES }),
  async (req, res) => {
    const body = req.body;

    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({
        error: 'EMPTY_FILE',
      });
    }

    const mime = sniff(body);

    if (!mime || !ALLOWED.has(mime)) {
      return res.status(415).json({
        error: 'UNSUPPORTED_TYPE',
        allowed: [...ALLOWED],
      });
    }

    const now = new Date();

    /* Завантаження одразу вмикає показ картинки: інакше клуб вивантажує
       логотип, нічого не змінюється, і він іде шукати, що ще натиснути.
       Повернутись до літер можна перемикачем — файл при цьому лишається. */
    await prisma.club.update({
      where: {
        id: req.auth!.clubId,
      },
      data: {
        logoData: body,
        logoMime: mime,
        logoUpdatedAt: now,
        logoMode: 'IMAGE',
      },
    });

    res.json({
      logoMime: mime,
      logoUpdatedAt: now,
      logoMode: 'IMAGE',
      bytes: body.length,
    });
  },
);

/**
 * DELETE /api/admin/club/logo
 *
 * Прибирає файл і повертає монограму. Окремо від перемикача режиму: одна
 * дія — «показувати літери, файл лишити», інша — «файла більше немає».
 */
logoRouter.delete(
  '/club/logo',
  requireAuth,
  requireStaff,
  async (req, res) => {
    await prisma.club.update({
      where: {
        id: req.auth!.clubId,
      },
      data: {
        logoData: null,
        logoMime: null,
        logoUpdatedAt: null,
        logoMode: 'MONOGRAM',
      },
    });

    res.status(204).end();
  },
);
