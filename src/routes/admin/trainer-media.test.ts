import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Фото тренера й відгуки про нього в кабінеті.
 *
 * Те саме, що в court-media.test.ts, плюс одне: список тренерів не тягне
 * байти знімків, а відгуки (імена й коментарі) бачить тільки персонал свого
 * клубу.
 */

const prisma = {
  trainer: { findMany: vi.fn(), findFirst: vi.fn() },
  trainerPhoto: {
    findMany: vi.fn(), aggregate: vi.fn(), create: vi.fn(),
    update: vi.fn(), deleteMany: vi.fn(),
  },
  trainerRating: { groupBy: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
};

vi.mock('../../lib/db', () => ({ prisma }));

vi.mock('./shared', async () => {
  const actual = await vi.importActual<typeof import('./shared')>('./shared');
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.auth = {
        userId: 'u-1',
        clubId: 'club-1',
        role: String(req.headers['x-role'] ?? 'OWNER'),
        trainerId: null,
      };
      next();
    },
    requireFeature: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  };
});

const { trainersRouter } = await import('./trainers');

const app = express().use(express.json()).use('/api/admin', trainersRouter);

const TRAINER = '11111111-1111-4111-8111-111111111111';
const P1 = '22222222-2222-4222-8222-222222222222';
const P2 = '33333333-3333-4333-8333-333333333333';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.trainer.findFirst.mockResolvedValue({ id: TRAINER });
  prisma.trainerPhoto.findMany.mockResolvedValue([{ id: P1 }, { id: P2 }]);
  prisma.trainerPhoto.aggregate.mockResolvedValue({ _count: 2, _max: { sortOrder: 1 } });
  prisma.trainerPhoto.create.mockResolvedValue({ id: P2 });
  prisma.trainerPhoto.deleteMany.mockResolvedValue({ count: 1 });
  prisma.trainerRating.groupBy.mockResolvedValue([]);
  prisma.trainerRating.findMany.mockResolvedValue([]);
});

describe('GET /trainers', () => {
  it('віддає адреси фото й рейтинг, байтів у запиті немає', async () => {
    prisma.trainer.findMany.mockResolvedValue([
      { id: TRAINER, name: 'Олена', photos: [{ id: P1 }] },
      { id: 'other', name: 'Іван', photos: [] },
    ]);
    prisma.trainerRating.groupBy.mockResolvedValue([
      { trainerId: TRAINER, _avg: { score: 4.5 }, _count: { score: 1 } },
    ]);

    const res = await request(app).get('/api/admin/trainers');

    expect(res.status).toBe(200);
    expect(res.body[0].photos).toEqual([{ id: P1, url: `/api/public/trainers/photos/${P1}` }]);
    /* У кабінеті одна оцінка вже видна; null — тільки коли їх нема. */
    expect(res.body[0].rating).toEqual({ avg: 4.5, count: 1 });
    expect(res.body[1]).toMatchObject({ photos: [], rating: null });
    expect(prisma.trainer.findMany.mock.calls[0][0].include.photos.select).toEqual({ id: true });
    expect(prisma.trainer.findMany.mock.calls[0][0].where).toEqual({ clubId: 'club-1' });
    expect(prisma.trainerRating.groupBy).toHaveBeenCalledTimes(1);
  });
});

describe('POST /trainers/:id/photos', () => {
  it('зберігає знімок останнім у черзі й у межах клубу', async () => {
    const res = await request(app)
      .post(`/api/admin/trainers/${TRAINER}/photos`)
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(201);
    expect(res.body.photos).toEqual([
      { id: P1, url: `/api/public/trainers/photos/${P1}` },
      { id: P2, url: `/api/public/trainers/photos/${P2}` },
    ]);
    expect(prisma.trainer.findFirst.mock.calls[0][0].where).toEqual({ id: TRAINER, clubId: 'club-1' });
    expect(prisma.trainerPhoto.create.mock.calls[0][0].data).toMatchObject({
      trainerId: TRAINER, clubId: 'club-1', mime: 'image/png', sortOrder: 2,
    });
  });

  it('не вірить заголовку: HTML під виглядом картинки — 415', async () => {
    const res = await request(app)
      .post(`/api/admin/trainers/${TRAINER}/photos`)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('<html><script>alert(1)</script></html>'));

    expect(res.status).toBe(415);
    expect(prisma.trainerPhoto.create).not.toHaveBeenCalled();
  });

  it('чужий тренер — 404, знімок не створюється', async () => {
    prisma.trainer.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/admin/trainers/${TRAINER}/photos`)
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(404);
    expect(prisma.trainerPhoto.create).not.toHaveBeenCalled();
  });

  it('п\'яте фото — 409 PHOTO_LIMIT', async () => {
    prisma.trainerPhoto.aggregate.mockResolvedValue({ _count: 4, _max: { sortOrder: 3 } });

    const res = await request(app)
      .post(`/api/admin/trainers/${TRAINER}/photos`)
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'PHOTO_LIMIT', limit: 4 });
    expect(prisma.trainerPhoto.create).not.toHaveBeenCalled();
  });

  it('тренер-акаунт фото не вантажить', async () => {
    const res = await request(app)
      .post(`/api/admin/trainers/${TRAINER}/photos`)
      .set('x-role', 'TRAINER')
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(403);
  });
});

describe('PUT /trainers/:id/photos/order', () => {
  it('перший у списку стає аватаром', async () => {
    const res = await request(app)
      .put(`/api/admin/trainers/${TRAINER}/photos/order`)
      .send({ ids: [P2, P1] });

    expect(res.status).toBe(200);
    expect(prisma.trainerPhoto.update.mock.calls.map((c) => c[0])).toEqual([
      { where: { id: P2 }, data: { sortOrder: 0 } },
      { where: { id: P1 }, data: { sortOrder: 1 } },
    ]);
  });

  it('неповний список — 409, нічого не змінюється', async () => {
    const res = await request(app)
      .put(`/api/admin/trainers/${TRAINER}/photos/order`)
      .send({ ids: [P1] });

    expect(res.status).toBe(409);
    expect(prisma.trainerPhoto.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /trainers/:id/photos/:photoId', () => {
  it('видаляє тільки в межах свого клубу й тренера', async () => {
    const res = await request(app).delete(`/api/admin/trainers/${TRAINER}/photos/${P1}`);

    expect(res.status).toBe(200);
    expect(prisma.trainerPhoto.deleteMany.mock.calls[0][0].where).toEqual({
      id: P1, trainerId: TRAINER, clubId: 'club-1',
    });
  });

  it('чуже фото — 404', async () => {
    prisma.trainerPhoto.deleteMany.mockResolvedValue({ count: 0 });

    const res = await request(app).delete(`/api/admin/trainers/${TRAINER}/photos/${P1}`);

    expect(res.status).toBe(404);
  });
});

describe('GET /trainers/:id/ratings', () => {
  it('віддає середню й відгуки без відмов, у межах клубу', async () => {
    prisma.trainerRating.groupBy.mockResolvedValue([
      { trainerId: TRAINER, _avg: { score: 4.5 }, _count: { score: 2 } },
    ]);
    prisma.trainerRating.findMany.mockResolvedValue([{
      id: 'r-1', score: 4, comment: 'Добре', source: 'TELEGRAM', createdAt: new Date('2026-10-04T10:00:00Z'),
      customer: { name: 'Марко' }, booking: { startTime: new Date('2026-10-04T08:00:00Z') },
    }]);

    const res = await request(app).get(`/api/admin/trainers/${TRAINER}/ratings?limit=10`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ avg: 4.5, count: 2 });
    expect(res.body.items[0]).toMatchObject({ id: 'r-1', score: 4, customerName: 'Марко', source: 'TELEGRAM' });
    expect(prisma.trainer.findFirst.mock.calls[0][0].where).toEqual({ id: TRAINER, clubId: 'club-1' });
    expect(prisma.trainerRating.findMany.mock.calls[0][0]).toMatchObject({
      where: { trainerId: TRAINER, clubId: 'club-1', score: { not: null } }, take: 10,
    });
  });

  it('чужий тренер — 404', async () => {
    prisma.trainer.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/admin/trainers/${TRAINER}/ratings`);

    expect(res.status).toBe(404);
    expect(prisma.trainerRating.findMany).not.toHaveBeenCalled();
  });

  it('тренер-акаунт чужих відгуків не бачить', async () => {
    const res = await request(app).get(`/api/admin/trainers/${TRAINER}/ratings`).set('x-role', 'TRAINER');

    expect(res.status).toBe(403);
  });

  it('кривий limit — 400', async () => {
    const res = await request(app).get(`/api/admin/trainers/${TRAINER}/ratings?limit=0`);

    expect(res.status).toBe(400);
  });
});
