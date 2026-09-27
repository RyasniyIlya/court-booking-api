import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Композиція adminRouter — межа ролі ACCOUNTANT.
 *
 * Інші файли тестують кожен домен окремо, підмінюючи requireAuth/requireStaff
 * заглушкою (див. customers.test.ts, courts.test.ts тощо) — правильно для
 * бізнес-логіки, але сліпо до того, чи справді кожен файл підключений ЗА
 * вартовим blockAccountant у index.ts. Один пропущений `adminRouter.use(...)`
 * до нього — і роут відкритий бухгалтеру повз усі перевірки ролі всередині
 * файлу. Тому тут — справжній adminRouter, справжній requireAuth і справжній
 * JWT, а підмінена лише база.
 */

const prisma = {
  user: { findUnique: vi.fn(), findMany: vi.fn() },
  court: { findMany: vi.fn() },
  customer: { findMany: vi.fn() },
};
vi.mock('../../lib/db', () => ({ prisma }));

const { adminRouter } = await import('./index');
const { signToken } = await import('./shared');

const app = express().use(express.json()).use(adminRouter);

const clubId = '22222222-2222-4222-8222-222222222222';
const userId = '44444444-4444-4444-8444-444444444444';

function tokenFor(role: string) {
  prisma.user.findUnique.mockResolvedValue({ id: userId, clubId, role, trainerId: null, passwordHash: 'test-hash' });
  return `Bearer ${signToken({ userId, clubId, role, trainerId: null }, '1h', 'test-hash')}`;
}

beforeEach(() => {
  vi.resetAllMocks();
  prisma.court.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.customer.findMany.mockResolvedValue([]);
});

describe('бухгалтер поза adminRouter, крім /me й /password з authRouter', () => {
  const routes: [string, string][] = [
    ['GET', '/courts'],
    ['GET', '/staff'],
    ['GET', '/customers?q=an'],
  ];

  it.each(routes)('%s %s — 403 одразу на вході, ще до логіки роута', async (method, path) => {
    const res = await request(app)[method.toLowerCase() as 'get'](path).set('Authorization', tokenFor('ACCOUNTANT'));
    expect(res.status).toBe(403);
    /* Саме blockAccountant, а не requireRole/requireStaff усередині файлу:
       у тих завжди є requiredRole, тут — ні. Так тест ловить і випадок,
       коли хтось прибере внутрішній вартовий, вважаючи зовнішній зайвим. */
    expect(res.body).toEqual({ error: 'FORBIDDEN' });
  });

  it.each(routes)('%s %s — власника перше кільце не чіпає', async (method, path) => {
    const res = await request(app)[method.toLowerCase() as 'get'](path).set('Authorization', tokenFor('OWNER'));
    expect(res.status).not.toBe(403);
  });

  it('/me лишається доступним — бухгалтеру треба знати свою роль після входу', async () => {
    const header = tokenFor('ACCOUNTANT');
    /* requireAuth і сам /me по черзі читають user.findUnique — другий раз
       мокаємо повнішою формою, яку саме цей роут вибирає полями. */
    prisma.user.findUnique.mockResolvedValue({
      id: userId, email: 'buh@club.test', role: 'ACCOUNTANT', clubId, trainerId: null, passwordHash: 'test-hash',
      club: { plan: null },
    });
    const res = await request(app).get('/me').set('Authorization', header);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('ACCOUNTANT');
  });

  it('без токена — 401, а не 403: різні причини відмови не можна плутати', async () => {
    expect((await request(app).get('/courts')).status).toBe(401);
  });
});
