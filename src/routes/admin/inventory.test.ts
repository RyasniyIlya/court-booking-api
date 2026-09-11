import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Комора клубу.
 *
 * Два питання тут важливіші за «створилось»: чи не тягне список байти фото
 * (двадцять позицій по мегабайту на кожне відкриття вкладки) і чи не
 * приймаємо ми за картинку те, що нею не є.
 */

const prisma = {
  inventoryItem: {
    findMany: vi.fn(), findFirst: vi.fn(),
    create: vi.fn(), update: vi.fn(), deleteMany: vi.fn(),
  },
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

const { inventoryRouter } = await import('./inventory');

const app = express().use(express.json()).use('/api/admin', inventoryRouter);

const ID = '66666666-6666-4666-8666-666666666666';

const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  name: 'Ракетка Wilson',
  category: 'Ракетки',
  quantity: 12,
  unit: 'шт',
  note: null,
  photoMime: null,
  photoUpdatedAt: null,
  sortOrder: 0,
  ...over,
});

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.inventoryItem.create.mockImplementation(({ data }: any) => ({ ...row(), ...data }));
  prisma.inventoryItem.update.mockImplementation(({ data }: any) => ({ ...row(), ...data }));
  prisma.inventoryItem.findFirst.mockResolvedValue({ id: ID });
});

describe('GET /inventory', () => {
  /* Найдорожча помилка в цьому роуті — тиха: список працює, просто качає
     з бази мегабайти картинок, яких ніхто на цьому екрані не побачить. */
  it('не тягне байти фото у список', async () => {
    prisma.inventoryItem.findMany.mockResolvedValue([row()]);
    await request(app).get('/api/admin/inventory');

    const select = prisma.inventoryItem.findMany.mock.calls[0][0].select;
    expect(select.photoData).toBeUndefined();
    expect(select.name).toBe(true);
  });

  it('віддає адресу фото з міткою часу, щоб браузер побачив заміну', async () => {
    prisma.inventoryItem.findMany.mockResolvedValue([
      row({ photoMime: 'image/png', photoUpdatedAt: new Date(1_700_000_000_000) }),
    ]);

    const res = await request(app).get('/api/admin/inventory');
    expect(res.body[0].photoUrl).toBe(`/api/public/inventory/${ID}/photo?v=1700000000000`);
  });

  it('без фото адреси немає — щоб картка не малювала биту картинку', async () => {
    prisma.inventoryItem.findMany.mockResolvedValue([row()]);
    const res = await request(app).get('/api/admin/inventory');
    expect(res.body[0].photoUrl).toBeNull();
  });
});

describe('POST /inventory', () => {
  it('створює позицію', async () => {
    const res = await request(app).post('/api/admin/inventory')
      .send({ name: 'Мʼячі Head', category: 'Мʼячі', quantity: 40, unit: 'шт' });

    expect(res.status).toBe(201);
    expect(prisma.inventoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clubId: 'club-1', name: 'Мʼячі Head', quantity: 40 }),
      }),
    );
  });

  it('порожню категорію зберігає як «не вказано», а не порожнім рядком', async () => {
    await request(app).post('/api/admin/inventory').send({ name: 'Сітка', category: '', unit: '' });
    expect(prisma.inventoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ category: null, unit: null }) }),
    );
  });

  /* Відʼємної кількості ракеток не буває, і мільйона теж. */
  it('не бере відʼємну й завелику кількість', async () => {
    expect((await request(app).post('/api/admin/inventory').send({ name: 'Стіл', quantity: -1 })).status).toBe(400);
    expect((await request(app).post('/api/admin/inventory').send({ name: 'Стіл', quantity: 10_000_000 })).status).toBe(400);
    expect((await request(app).post('/api/admin/inventory').send({ name: '' })).status).toBe(400);
  });

  it('тренера до комори не пускає', async () => {
    const res = await request(app).post('/api/admin/inventory')
      .set('x-role', 'TRAINER').send({ name: 'Ракетка' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH і DELETE', () => {
  it('оновлює кількість', async () => {
    const res = await request(app).patch(`/api/admin/inventory/${ID}`).send({ quantity: 9 });
    expect(res.status).toBe(200);
    expect(prisma.inventoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { quantity: 9 } }),
    );
  });

  it('чужу позицію не чіпає', async () => {
    prisma.inventoryItem.findFirst.mockResolvedValue(null);
    expect((await request(app).patch(`/api/admin/inventory/${ID}`).send({ quantity: 1 })).status).toBe(404);
    expect(prisma.inventoryItem.update).not.toHaveBeenCalled();
  });

  it('видаляє тільки в межах свого клубу', async () => {
    prisma.inventoryItem.deleteMany.mockResolvedValue({ count: 1 });
    await request(app).delete(`/api/admin/inventory/${ID}`);
    expect(prisma.inventoryItem.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ clubId: 'club-1' }) }),
    );
  });
});

describe('фото', () => {
  it('приймає PNG і запамʼятовує тип', async () => {
    const res = await request(app).post(`/api/admin/inventory/${ID}/photo`)
      .set('Content-Type', 'image/png').send(png);

    expect(res.status).toBe(200);
    expect(prisma.inventoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ photoMime: 'image/png' }) }),
    );
  });

  /* Заголовок надсилає клієнт, і він може збрехати: назвати .html
     картинкою і отримати наш домен для довільного вмісту. */
  it('не вірить заявленому типу — дивиться у вміст', async () => {
    const res = await request(app).post(`/api/admin/inventory/${ID}/photo`)
      .set('Content-Type', 'image/png').send(Buffer.from('<html>not a picture at all</html>'));

    expect(res.status).toBe(415);
    expect(prisma.inventoryItem.update).not.toHaveBeenCalled();
  });

  it('порожнє тіло — не фото', async () => {
    const res = await request(app).post(`/api/admin/inventory/${ID}/photo`)
      .set('Content-Type', 'image/png').send(Buffer.alloc(0));
    expect(res.status).toBe(400);
  });

  it('знімає фото, лишаючи саму позицію', async () => {
    const res = await request(app).delete(`/api/admin/inventory/${ID}/photo`);
    expect(res.status).toBe(200);
    expect(prisma.inventoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { photoData: null, photoMime: null, photoUpdatedAt: null } }),
    );
  });

  it('у чужу позицію фото не кладе', async () => {
    prisma.inventoryItem.findFirst.mockResolvedValue(null);
    const res = await request(app).post(`/api/admin/inventory/${ID}/photo`)
      .set('Content-Type', 'image/png').send(png);
    expect(res.status).toBe(404);
  });
});
