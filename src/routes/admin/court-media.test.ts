import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { parseCourtVideo, courtVideoUrl } from '../../lib/courtMedia';

/**
 * Фото й відео корту.
 *
 * Три речі, які тут дорожчі за «завантажилось»: список кортів не тягне
 * байти знімків, чужий клуб не дістає чужі фото, а в базу не лягає адреса
 * ролика з хоста, якого ми не знаємо.
 */

const prisma = {
  court: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  courtPhoto: {
    findMany: vi.fn(), aggregate: vi.fn(), create: vi.fn(),
    update: vi.fn(), deleteMany: vi.fn(),
  },
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
  };
});

const { courtsRouter } = await import('./courts');

const app = express().use(express.json()).use('/api/admin', courtsRouter);

const COURT = '11111111-1111-4111-8111-111111111111';
const P1 = '22222222-2222-4222-8222-222222222222';
const P2 = '33333333-3333-4333-8333-333333333333';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.court.findFirst.mockResolvedValue({ id: COURT });
  prisma.court.updateMany.mockResolvedValue({ count: 1 });
  prisma.courtPhoto.findMany.mockResolvedValue([{ id: P1 }, { id: P2 }]);
  prisma.courtPhoto.aggregate.mockResolvedValue({ _count: 2, _max: { sortOrder: 1 } });
  prisma.courtPhoto.create.mockResolvedValue({ id: P2 });
  prisma.courtPhoto.deleteMany.mockResolvedValue({ count: 1 });
});

describe('GET /courts', () => {
  it('віддає адреси знімків і не просить у бази байти', async () => {
    prisma.court.findMany.mockResolvedValue([
      { id: COURT, name: 'Корт 1', videoUrl: null, photos: [{ id: P1 }] },
    ]);

    const res = await request(app).get('/api/admin/courts');

    expect(res.status).toBe(200);
    expect(res.body[0].photos).toEqual([{ id: P1, url: `/api/public/courts/photos/${P1}` }]);
    expect(prisma.court.findMany.mock.calls[0][0].include.photos.select).toEqual({ id: true });
  });
});

describe('POST /courts/:id/photos', () => {
  it('зберігає знімок останнім у черзі й у межах клубу', async () => {
    const res = await request(app)
      .post(`/api/admin/courts/${COURT}/photos`)
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(201);
    expect(res.body.photos).toHaveLength(2);
    expect(prisma.court.findFirst.mock.calls[0][0].where).toEqual({ id: COURT, clubId: 'club-1' });
    expect(prisma.courtPhoto.create.mock.calls[0][0].data).toMatchObject({
      courtId: COURT, clubId: 'club-1', mime: 'image/png', sortOrder: 2,
    });
  });

  it('не вірить заголовку: HTML під виглядом картинки — 415', async () => {
    const res = await request(app)
      .post(`/api/admin/courts/${COURT}/photos`)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('<html><script>alert(1)</script></html>'));

    expect(res.status).toBe(415);
    expect(prisma.courtPhoto.create).not.toHaveBeenCalled();
  });

  it('чужий корт — 404, знімок не створюється', async () => {
    prisma.court.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/admin/courts/${COURT}/photos`)
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(404);
    expect(prisma.courtPhoto.create).not.toHaveBeenCalled();
  });

  it('дев\'ятий знімок — 409 PHOTO_LIMIT', async () => {
    prisma.courtPhoto.aggregate.mockResolvedValue({ _count: 8, _max: { sortOrder: 7 } });

    const res = await request(app)
      .post(`/api/admin/courts/${COURT}/photos`)
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PHOTO_LIMIT');
    expect(prisma.courtPhoto.create).not.toHaveBeenCalled();
  });

  it('тренер знімки не вантажить', async () => {
    const res = await request(app)
      .post(`/api/admin/courts/${COURT}/photos`)
      .set('x-role', 'TRAINER')
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(403);
  });
});

describe('PUT /courts/:id/photos/order', () => {
  it('перший у списку стає обкладинкою', async () => {
    const res = await request(app)
      .put(`/api/admin/courts/${COURT}/photos/order`)
      .send({ ids: [P2, P1] });

    expect(res.status).toBe(200);
    expect(prisma.courtPhoto.update.mock.calls.map((c) => c[0])).toEqual([
      { where: { id: P2 }, data: { sortOrder: 0 } },
      { where: { id: P1 }, data: { sortOrder: 1 } },
    ]);
  });

  it('неповний список — 409, нічого не змінюється', async () => {
    const res = await request(app)
      .put(`/api/admin/courts/${COURT}/photos/order`)
      .send({ ids: [P1] });

    expect(res.status).toBe(409);
    expect(prisma.courtPhoto.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /courts/:id/photos/:photoId', () => {
  it('видаляє тільки в межах свого клубу й корту', async () => {
    const res = await request(app).delete(`/api/admin/courts/${COURT}/photos/${P1}`);

    expect(res.status).toBe(200);
    expect(prisma.courtPhoto.deleteMany.mock.calls[0][0].where).toEqual({
      id: P1, courtId: COURT, clubId: 'club-1',
    });
  });

  it('чужий знімок — 404', async () => {
    prisma.courtPhoto.deleteMany.mockResolvedValue({ count: 0 });

    const res = await request(app).delete(`/api/admin/courts/${COURT}/photos/${P1}`);

    expect(res.status).toBe(404);
  });
});

describe('PATCH /courts/:id — videoUrl', () => {
  it('у базу лягає канонічна адреса, а не вписана', async () => {
    const res = await request(app)
      .patch(`/api/admin/courts/${COURT}`)
      .send({ videoUrl: 'youtu.be/dQw4w9WgXcQ?si=tracking&t=10' });

    expect(res.status).toBe(200);
    expect(prisma.court.updateMany.mock.calls[0][0].data.videoUrl)
      .toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('невідомий хост — 400 BAD_VIDEO_URL', async () => {
    const res = await request(app)
      .patch(`/api/admin/courts/${COURT}`)
      .send({ videoUrl: 'https://evil.example/watch?v=dQw4w9WgXcQ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BAD_VIDEO_URL');
    expect(prisma.court.updateMany).not.toHaveBeenCalled();
  });

  it('порожній рядок прибирає ролик', async () => {
    await request(app).patch(`/api/admin/courts/${COURT}`).send({ videoUrl: '' });

    expect(prisma.court.updateMany.mock.calls[0][0].data.videoUrl).toBeNull();
  });

  it('правка ціни ролик не чіпає', async () => {
    await request(app).patch(`/api/admin/courts/${COURT}`).send({ pricePerHour: 50000 });

    expect(prisma.court.updateMany.mock.calls[0][0].data).toEqual({ pricePerHour: 50000 });
  });
});

describe('parseCourtVideo', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://vimeo.com/123456789', 'vimeo', '123456789'],
    ['https://player.vimeo.com/video/123456789', 'vimeo', '123456789'],
  ])('%s', (url, provider, id) => {
    expect(parseCourtVideo(url)).toEqual({ provider, id });
  });

  it.each([
    'javascript:alert(1)',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v="><script>',
    'https://vimeo.com/channels/staff',
    '',
  ])('відкидає %s', (url) => {
    expect(parseCourtVideo(url)).toBeNull();
  });

  it('канонічна адреса розбирається назад у те саме', () => {
    const video = { provider: 'vimeo' as const, id: '123456789' };
    expect(parseCourtVideo(courtVideoUrl(video))).toEqual(video);
  });
});
