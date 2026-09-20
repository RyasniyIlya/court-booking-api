import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /admin/analytics/customers/export — вивантаження картотеки.
 *
 * Тут перевіряється не формат файла (це робить customerRoster.test.ts), а
 * три речі, у яких помилка коштує найдорожче:
 *
 *   1. базу може винести лише власник;
 *   2. клуб береться з токена і нізвідки більше;
 *   3. факт вивантаження лишає слід у журналі.
 *
 * Роль перевіряє справжній requireRole, а не заглушка: саме він тут і є
 * предметом тесту.
 */

const prisma = {
  club: { findUnique: vi.fn() },
  user: { findFirst: vi.fn() },
  customer: { findMany: vi.fn() },
  booking: { findMany: vi.fn() },
  bookingSeat: { findMany: vi.fn() },
  changeLog: { createMany: vi.fn() },
};

vi.mock('../lib/db', () => ({ prisma }));

/* Роль у токені задає тест; решта вартових пропускає — план і сама
   авторизація мають власні тести й до питання «кому можна базу» не
   стосуються. */
let role = 'OWNER';
vi.mock('./admin', async () => {
  const shared = await vi.importActual<typeof import('./admin/shared')>('./admin/shared');
  return {
    requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
      req.auth = { userId: 'user-1', clubId: 'club-1', role, trainerId: null };
      next();
    },
    requireRole: shared.requireRole,
    requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

const { analyticsRouter } = await import('./analytics');
const app = express().use(analyticsRouter);

const get = (query = '') => request(app).get(`/customers/export${query}`);

beforeEach(() => {
  role = 'OWNER';
  vi.resetAllMocks();
  prisma.club.findUnique.mockResolvedValue({ name: 'Корт на Січових', timezone: 'Europe/Kyiv' });
  prisma.user.findFirst.mockResolvedValue({ email: 'owner@club.test' });
  prisma.customer.findMany.mockResolvedValue([{
    id: 'c1', name: 'Іван', phone: '+380671234567', email: null, note: null,
    tags: [], isBlocked: false, requiresPrepay: false, createdAt: new Date('2025-01-01'),
    telegramChatId: null, birthDate: null, discountPercent: 0, bonusBalance: 0,
  }]);
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.bookingSeat.findMany.mockResolvedValue([]);
  prisma.changeLog.createMany.mockResolvedValue({ count: 1 });
});

describe('хто може винести базу', () => {
  it('власник — може', async () => {
    expect((await get()).status).toBe(200);
  });

  /* ADMIN бачить усю решту аналітики й працює з картками щодня — але
     поштучно, через пошук на ресепшені. Уся база одним файлом — це те, що
     виносять із клубу, і це рішення власника. */
  it('адміністратор — ні, хоча решту аналітики бачить', async () => {
    role = 'ADMIN';
    const res = await get();

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('відмова не лишає сліду в журналі — бо нічого не сталось', async () => {
    role = 'ADMIN';
    await get();

    expect(prisma.changeLog.createMany).not.toHaveBeenCalled();
  });
});

describe('межі клубу', () => {
  it('клуб береться з токена', async () => {
    await get();

    expect(prisma.club.findUnique.mock.calls[0][0].where.id).toBe('club-1');
    expect(prisma.customer.findMany.mock.calls[0][0].where.clubId).toBe('club-1');
  });

  /* Параметра «вивантажити інший клуб» не існує — але спроба його
     підставити не повинна нічого змінити навіть випадково. */
  it('чужий clubId у запиті ігнорується', async () => {
    await get('?clubId=club-2&club=club-2');

    expect(prisma.customer.findMany.mock.calls[0][0].where.clubId).toBe('club-1');
  });
});

describe('журнал', () => {
  it('записує, хто і скільки вивантажив', async () => {
    await get('?format=csv');
    const [row] = prisma.changeLog.createMany.mock.calls[0][0].data;

    expect(row).toMatchObject({
      clubId: 'club-1',
      entity: 'CustomerExport',
      actorId: 'user-1',
      actorEmail: 'owner@club.test',
      actorRole: 'OWNER',
    });
    expect(row.after).toMatchObject({ format: 'csv', rows: 1 });
  });

  it('зберігає відбір — щоб було видно, кого саме взяли', async () => {
    await get('?tag=діти');
    const [row] = prisma.changeLog.createMany.mock.calls[0][0].data;

    expect(row.after.filter).toMatchObject({ tag: 'діти' });
  });
});

describe('віддача файла', () => {
  it('xlsx — типовий формат', async () => {
    /* responseType('blob') — щоб supertest віддав тіло байтами, а не
       спробував прочитати двійковий файл як текст. */
    const res = await get().responseType('blob');

    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    /* PK — сигнатура zip: .xlsx і є zip-контейнером. */
    expect(res.body.subarray(0, 2).toString()).toBe('PK');
  });

  it('csv — коли попросили', async () => {
    const res = await get('?format=csv');

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Телефон');
  });

  it('віддає як завантаження, з кирилицею в назві', async () => {
    const disposition = (await get()).headers['content-disposition'];

    expect(disposition).toContain('attachment');
    expect(disposition).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(disposition)).toContain('Корт-на-Січових');
  });

  /* Картотека — персональні дані, а не сторінка каталогу: проміжні кеші
     не повинні лишати її в себе. */
  it('забороняє кешування', async () => {
    expect((await get()).headers['cache-control']).toBe('no-store');
  });

  it('невідомий формат — 400, а не мовчазний xlsx', async () => {
    expect((await get('?format=pdf')).status).toBe(400);
  });

  it('порожня картотека — це файл із шапкою, а не 404', async () => {
    prisma.customer.findMany.mockResolvedValue([]);
    const res = await get('?format=csv');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Телефон');
  });
});
