import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Конструктор акцій.
 *
 * Головне тут не «збереглось», а те, що НЕ має зберегтись. Акція з
 * порожнім списком днів, з вивернутим часом або на корт чужого клубу
 * лягає в базу без жодної помилки і просто ніколи не спрацьовує — клуб
 * дізнається про це з виторгу наприкінці місяця, а не з екрана.
 */

const prisma = {
  promo: {
    findMany: vi.fn(), findFirst: vi.fn(),
    create: vi.fn(), update: vi.fn(), deleteMany: vi.fn(),
  },
  court: { count: vi.fn() },
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

const { promosRouter } = await import('./promos');

const app = express().use(express.json()).use('/api/admin', promosRouter);

const PROMO_ID = '44444444-4444-4444-8444-444444444444';
const COURT_ID = '55555555-5555-4555-8555-555555555555';

const weekly = {
  title: 'Щасливі години',
  kind: 'WEEKLY',
  weekdays: [1, 2, 3],
  startMinute: 600,
  endMinute: 840,
  discountType: 'PERCENT',
  discountValue: 30,
  courtIds: [],
};

const stored = (over: Record<string, unknown> = {}) => ({
  id: PROMO_ID,
  clubId: 'club-1',
  title: 'Щасливі години',
  kind: 'WEEKLY',
  weekdays: [1, 2, 3],
  dateFrom: null,
  dateTo: null,
  daysBefore: 0,
  daysAfter: 0,
  startMinute: 600,
  endMinute: 840,
  discountType: 'PERCENT',
  discountValue: 30,
  courtIds: [],
  isActive: true,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.promo.create.mockImplementation(({ data }: any) => ({ ...stored(), ...data }));
  prisma.promo.update.mockImplementation(({ data }: any) => ({ ...stored(), ...data }));
  prisma.court.count.mockResolvedValue(1);
});

describe('GET /promos', () => {
  it('віддає дати рядком, а не міткою часу — кабінет кладе їх у input[type=date]', async () => {
    prisma.promo.findMany.mockResolvedValue([
      stored({
        kind: 'DATES',
        dateFrom: new Date('2026-12-24T00:00:00.000Z'),
        dateTo: new Date('2027-01-07T00:00:00.000Z'),
      }),
    ]);

    const res = await request(app).get('/api/admin/promos');
    expect(res.status).toBe(200);
    expect(res.body[0].dateFrom).toBe('2026-12-24');
    expect(res.body[0].dateTo).toBe('2027-01-07');
  });
});

describe('POST /promos', () => {
  it('створює щотижневу акцію', async () => {
    const res = await request(app).post('/api/admin/promos').send(weekly);
    expect(res.status).toBe(201);
    expect(prisma.promo.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ clubId: 'club-1', weekdays: [1, 2, 3] }) }),
    );
  });

  it('створює акцію на день народження без днів тижня і без дат', async () => {
    const res = await request(app).post('/api/admin/promos').send({
      title: 'Іменинникам',
      kind: 'BIRTHDAY',
      daysBefore: 7,
      daysAfter: 7,
      startMinute: 0,
      endMinute: 1439,
      discountType: 'PERCENT',
      discountValue: 30,
    });

    expect(res.status).toBe(201);
    expect(prisma.promo.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ daysBefore: 7, daysAfter: 7, weekdays: [] }) }),
    );
  });

  /* 0/0 — це рівно день народження. Теж правило, а не помилка вводу. */
  it('приймає нульове вікно дня народження', async () => {
    const res = await request(app).post('/api/admin/promos').send({
      title: 'Тільки в сам день',
      kind: 'BIRTHDAY',
      startMinute: 0,
      endMinute: 1439,
      discountType: 'PERCENT',
      discountValue: 20,
    });
    expect(res.status).toBe(201);
  });

  it('не зберігає акцію, яка ніколи не спрацює', async () => {
    const bad = async (patch: Record<string, unknown>) =>
      (await request(app).post('/api/admin/promos').send({ ...weekly, ...patch })).status;

    expect(await bad({ weekdays: [] })).toBe(400);
    expect(await bad({ startMinute: 900, endMinute: 600 })).toBe(400);
    expect(await bad({ kind: 'DATES', dateFrom: '2026-09-09', dateTo: '2026-09-07' })).toBe(400);
    expect(await bad({ kind: 'DATES', dateFrom: null, dateTo: null })).toBe(400);
    expect(prisma.promo.create).not.toHaveBeenCalled();
  });

  /* Стеля 90%: «безкоштовно» майже завжди не акція, а зайвий нуль у полі. */
  it('не пускає знижку понад стелю і нульову знижку', async () => {
    expect((await request(app).post('/api/admin/promos').send({ ...weekly, discountValue: 95 })).status).toBe(400);
    expect((await request(app).post('/api/admin/promos').send({ ...weekly, discountValue: 0 })).status).toBe(400);
    expect((await request(app).post('/api/admin/promos').send({
      ...weekly, discountType: 'PRICE', discountValue: 25000,
    })).status).toBe(201);
  });

  it('не пускає вікно дня народження ширше за стелю', async () => {
    const res = await request(app).post('/api/admin/promos').send({
      title: 'Пів року іменин', kind: 'BIRTHDAY', daysBefore: 180, daysAfter: 180,
      startMinute: 0, endMinute: 1439, discountType: 'PERCENT', discountValue: 20,
    });
    expect(res.status).toBe(400);
  });

  /* Знижка на корт чужого клубу — це знижка, якої ніхто не побачить. */
  it('не бере корти чужого клубу', async () => {
    prisma.court.count.mockResolvedValue(0);
    const res = await request(app).post('/api/admin/promos').send({ ...weekly, courtIds: [COURT_ID] });
    expect(res.status).toBe(404);
  });

  it('тренера до правил знижок не пускає', async () => {
    const res = await request(app).post('/api/admin/promos').set('x-role', 'TRAINER').send(weekly);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /promos/:id', () => {
  it('вимикає акцію однією галочкою', async () => {
    prisma.promo.findFirst.mockResolvedValue(stored());
    const res = await request(app).patch(`/api/admin/promos/${PROMO_ID}`).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(prisma.promo.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isActive: false }) }),
    );
  });

  /* Патч міряємо разом із тим, що вже лежить у базі: зміна виду правила
     без нових полів не має тихо створити акцію, яка ніколи не спрацює. */
  it('перевіряє правило після злиття з наявним', async () => {
    prisma.promo.findFirst.mockResolvedValue(stored());
    const res = await request(app).patch(`/api/admin/promos/${PROMO_ID}`).send({ kind: 'DATES' });
    expect(res.status).toBe(400);
    expect(prisma.promo.update).not.toHaveBeenCalled();
  });

  it('переводить акцію на день народження і прибирає дні тижня', async () => {
    prisma.promo.findFirst.mockResolvedValue(stored());
    const res = await request(app)
      .patch(`/api/admin/promos/${PROMO_ID}`)
      .send({ kind: 'BIRTHDAY', daysBefore: 7, daysAfter: 7 });

    expect(res.status).toBe(200);
    expect(prisma.promo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'BIRTHDAY', weekdays: [], daysBefore: 7, daysAfter: 7 }),
      }),
    );
  });

  it('чужу акцію не чіпає', async () => {
    prisma.promo.findFirst.mockResolvedValue(null);
    const res = await request(app).patch(`/api/admin/promos/${PROMO_ID}`).send({ isActive: false });
    expect(res.status).toBe(404);
    expect(prisma.promo.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /promos/:id', () => {
  it('видаляє свою акцію', async () => {
    prisma.promo.deleteMany.mockResolvedValue({ count: 1 });
    const res = await request(app).delete(`/api/admin/promos/${PROMO_ID}`);
    expect(res.status).toBe(200);
    expect(prisma.promo.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ clubId: 'club-1' }) }),
    );
  });

  it('чужу — ні', async () => {
    prisma.promo.deleteMany.mockResolvedValue({ count: 0 });
    expect((await request(app).delete(`/api/admin/promos/${PROMO_ID}`)).status).toBe(404);
  });
});
