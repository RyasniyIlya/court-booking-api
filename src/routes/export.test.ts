import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /api/admin/export/{customers,bookings} — ті самі вивантаження, що й
 * на аналітичному шляху (customers-export.test.ts, bookings-export.test.ts),
 * але БЕЗ вартового плану: власник дістає базу клубу на будь-якому тарифі.
 *
 * Тут не повторюється перевірка формату файла й колонок — вона вже є в
 * тестах старого шляху, а обробник той самий (customersExportHandler /
 * bookingsExportHandler з analytics.ts). Тут — тільки те, що відрізняє
 * новий роутер: доступ не залежить від плану, роль лишається OWNER-only,
 * і клуб так само береться з токена.
 */

const prisma = {
  club: { findUnique: vi.fn() },
  user: { findFirst: vi.fn() },
  customer: { findMany: vi.fn() },
  booking: { findMany: vi.fn() },
  bookingSeat: { findMany: vi.fn() },
  passUsage: { findMany: vi.fn() },
  changeLog: { createMany: vi.fn() },
};

vi.mock('../lib/db', () => ({ prisma }));

/* Роль у токені задає тест; requireRole лишається справжнім — саме він тут
   і перевіряється. requireAuth підмінено, щоб не морочитись із JWT. */
let role = 'OWNER';
vi.mock('./admin/shared', async () => {
  const actual = await vi.importActual<typeof import('./admin/shared')>('./admin/shared');
  return {
    ...actual,
    requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
      req.auth = { userId: 'user-1', clubId: 'club-1', role, trainerId: null };
      next();
    },
  };
});

const { exportRouter } = await import('./export');
const app = express().use(exportRouter);

beforeEach(() => {
  role = 'OWNER';
  vi.resetAllMocks();
  /* План без аналітики — саме той випадок, який тут перевіряється: тариф
     «Броні» / «Команда», featAnalytics: false. Обробники плану взагалі не
     читають — але клуб тут навмисно на найдешевшому тарифі, щоб було видно,
     що це справді нічого не важить. */
  prisma.club.findUnique.mockResolvedValue({
    name: 'Корт на Січових',
    timezone: 'Europe/Kyiv',
    plan: { featTrainers: false, featGroups: false, featAnalytics: false, tier: 'BASIC' },
  });
  prisma.user.findFirst.mockResolvedValue({ email: 'owner@club.test' });
  prisma.customer.findMany.mockResolvedValue([]);
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.bookingSeat.findMany.mockResolvedValue([]);
  prisma.passUsage.findMany.mockResolvedValue([]);
  prisma.changeLog.createMany.mockResolvedValue({ count: 1 });
});

describe('GET /customers — картотека без плану «Аналітика»', () => {
  it('власник на тарифі без аналітики — 200', async () => {
    const res = await request(app).get('/customers');
    expect(res.status).toBe(200);
  });

  it('адміністратор — 403, навіть на будь-якому тарифі', async () => {
    role = 'ADMIN';
    const res = await request(app).get('/customers');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('клуб береться з токена', async () => {
    await request(app).get('/customers');
    expect(prisma.club.findUnique.mock.calls[0][0].where.id).toBe('club-1');
    expect(prisma.customer.findMany.mock.calls[0][0].where.clubId).toBe('club-1');
  });

  it('пишеться в журнал так само, як і на старому шляху', async () => {
    await request(app).get('/customers?format=csv');
    const [row] = prisma.changeLog.createMany.mock.calls[0][0].data;
    expect(row).toMatchObject({ clubId: 'club-1', entity: 'CustomerExport', actorRole: 'OWNER' });
  });
});

describe('GET /bookings — історія броней без плану «Аналітика»', () => {
  it('власник на тарифі без аналітики — 200', async () => {
    const res = await request(app).get('/bookings');
    expect(res.status).toBe(200);
  });

  it('адміністратор — 403', async () => {
    role = 'ADMIN';
    const res = await request(app).get('/bookings');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('клуб береться з токена', async () => {
    await request(app).get('/bookings');
    expect(prisma.club.findUnique.mock.calls[0][0].where.id).toBe('club-1');
    expect(prisma.booking.findMany.mock.calls[0][0].where.clubId).toBe('club-1');
  });

  it('пишеться в журнал так само, як і на старому шляху', async () => {
    await request(app).get('/bookings?format=csv');
    const [row] = prisma.changeLog.createMany.mock.calls[0][0].data;
    expect(row).toMatchObject({ clubId: 'club-1', entity: 'BookingExport', actorRole: 'OWNER' });
  });
});
