import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * /admin/finance — касова книга й боржники.
 *
 * Перевіряється те, де помилка коштує найдорожче: клуб лише з токена,
 * файл лише власнику з записом у журнал, відсутність журналу не видається
 * за «боргів нема» чи «грошей нуль».
 */

const prisma = {
  club: { findUnique: vi.fn(), update: vi.fn() },
  user: { findFirst: vi.fn() },
  bookingLedgerEntry: { findMany: vi.fn(), findFirst: vi.fn() },
  payment: { findMany: vi.fn() },
  pass: { findMany: vi.fn() },
  booking: { findMany: vi.fn() },
  bookingSeat: { findMany: vi.fn() },
  passUsage: { findMany: vi.fn() },
  changeLog: { createMany: vi.fn() },
  clubExpense: { findMany: vi.fn() },
};

vi.mock('../lib/db', () => ({ prisma }));

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

const { financeRouter, cashRange } = await import('./finance');
const app = express().use(express.json()).use(financeRouter);

beforeEach(() => {
  role = 'OWNER';
  vi.resetAllMocks();
  prisma.club.findUnique.mockResolvedValue({
    name: 'Клуб', timezone: 'Europe/Kyiv', taxRegime: 'FOP_3', vatPayer: false, taxFixedMonthly: null,
  });
  prisma.clubExpense.findMany.mockResolvedValue([]);
  prisma.user.findFirst.mockResolvedValue({ email: 'owner@club.test' });
  prisma.bookingLedgerEntry.findMany.mockResolvedValue([{
    id: 'l1', createdAt: new Date('2026-05-10T09:00:00Z'), kind: 'PAYMENT', method: 'CASH', amount: 60000,
    account: 'Каса', note: '', actorEmail: 'admin@club.test', seatId: null,
    booking: { customerName: 'Іван', title: null, startTime: new Date('2026-05-10T15:00:00Z'), court: { name: 'Корт 1' } },
    seat: null,
  }]);
  prisma.bookingLedgerEntry.findFirst.mockResolvedValue({ createdAt: new Date('2026-04-01T00:00:00Z') });
  prisma.payment.findMany.mockResolvedValue([]);
  prisma.pass.findMany.mockResolvedValue([]);
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.bookingSeat.findMany.mockResolvedValue([]);
  prisma.passUsage.findMany.mockResolvedValue([]);
  prisma.changeLog.createMany.mockResolvedValue({ count: 1 });
});

describe('cashRange', () => {
  it('одна дата без другої чи понад рік — не читається', () => {
    expect(cashRange({ from: '2026-05-01' }, 'Europe/Kyiv')).toBeNull();
    expect(cashRange({ from: '2025-01-01', to: '2026-05-01' }, 'Europe/Kyiv')).toBeNull();
    expect(cashRange({ from: '2026-05-02', to: '2026-05-01' }, 'Europe/Kyiv')).toBeNull();
  });
});

describe('GET /cashbook', () => {
  it('клуб з токена, підсумок і податок', async () => {
    const res = await request(app).get('/cashbook?from=2026-05-01&to=2026-05-31');
    expect(res.status).toBe(200);
    expect(prisma.bookingLedgerEntry.findMany.mock.calls[0][0].where.clubId).toBe('club-1');
    expect(res.body.summary.net).toBe(60000);
    expect(res.body.tax.total).toBe(3600);
    expect(res.body.partial).toBe(false);
    expect(res.body.limit.year).toBe(2026);
  });

  it('журналу ще нема — звіт позначено неповним', async () => {
    prisma.bookingLedgerEntry.findFirst.mockResolvedValue(null);
    const res = await request(app).get('/cashbook?from=2026-05-01&to=2026-05-31');
    expect(res.body.partial).toBe(true);
    expect(res.body.journalSince).toBeNull();
  });

  it('тренер не бачить грошей клубу', async () => {
    role = 'TRAINER';
    expect((await request(app).get('/cashbook')).status).toBe(403);
  });

  it('бухгалтер читає касу нарівні з власником', async () => {
    role = 'ACCOUNTANT';
    const res = await request(app).get('/cashbook?from=2026-05-01&to=2026-05-31');
    expect(res.status).toBe(200);
    expect(res.body.summary.net).toBe(60000);
  });

  it('поганий період — 400', async () => {
    expect((await request(app).get('/cashbook?from=2026-05-01')).status).toBe(400);
  });

  it('за замовчуванням (FOP_3) ClubExpense не читається — зайвий похід у базу', async () => {
    await request(app).get('/cashbook?from=2026-05-01&to=2026-05-31');
    expect(prisma.clubExpense.findMany).not.toHaveBeenCalled();
  });

  it('режим FOP_GENERAL: прибуток мінус витрати клубу (без TAX)', async () => {
    prisma.club.findUnique.mockResolvedValue({
      name: 'Клуб', timezone: 'Europe/Kyiv', taxRegime: 'FOP_GENERAL', vatPayer: false, taxFixedMonthly: null,
    });
    prisma.clubExpense.findMany.mockResolvedValue([
      { category: 'RENT', amount: 10000 },
      { category: 'TAX', amount: 999999 },
    ]);
    const res = await request(app).get('/cashbook?from=2026-05-01&to=2026-05-31');
    expect(res.status).toBe(200);
    expect(res.body.tax.regime).toBe('FOP_GENERAL');
    expect(res.body.tax.base).toBe(50000); // 60000 − 10000, TAX виключено
    expect(res.body.tax.total).toBe(50000 * 0.23); // 18% ПДФО + 5% збору
    expect(res.body.limit).toBeNull();
  });
});

describe('PATCH /tax-regime', () => {
  it('власник міняє режим', async () => {
    prisma.club.findUnique.mockResolvedValue({ taxRegime: 'FOP_3', vatPayer: false, taxFixedMonthly: null });
    prisma.club.update.mockResolvedValue({ taxRegime: 'TOV_GENERAL', vatPayer: false, taxFixedMonthly: null });
    const res = await request(app).patch('/tax-regime').send({ taxRegime: 'TOV_GENERAL' });
    expect(res.status).toBe(200);
    expect(res.body.taxRegime).toBe('TOV_GENERAL');
    expect(prisma.club.update.mock.calls[0][0].where.id).toBe('club-1');
  });

  it('бухгалтер теж може — саме він знає режим', async () => {
    role = 'ACCOUNTANT';
    prisma.club.findUnique.mockResolvedValue({ taxRegime: 'FOP_3', vatPayer: false, taxFixedMonthly: null });
    prisma.club.update.mockResolvedValue({ taxRegime: 'FOP_2', vatPayer: false, taxFixedMonthly: null });
    const res = await request(app).patch('/tax-regime').send({ taxRegime: 'FOP_2' });
    expect(res.status).toBe(200);
  });

  it('модератор — 403, хоча касу він і бачить', async () => {
    role = 'ADMIN';
    const res = await request(app).patch('/tax-regime').send({ taxRegime: 'FOP_2' });
    expect(res.status).toBe(403);
    expect(prisma.club.update).not.toHaveBeenCalled();
  });

  it('платник ПДВ примусово скидається там, де він не застосовний', async () => {
    prisma.club.findUnique.mockResolvedValue({ taxRegime: 'FOP_3', vatPayer: true, taxFixedMonthly: null });
    prisma.club.update.mockResolvedValue({ taxRegime: 'FOP_1', vatPayer: false, taxFixedMonthly: null });
    await request(app).patch('/tax-regime').send({ taxRegime: 'FOP_1' });
    expect(prisma.club.update.mock.calls[0][0].data.vatPayer).toBe(false);
  });

  it('невідомий режим і задовга фіксована ставка — 400', async () => {
    expect((await request(app).patch('/tax-regime').send({ taxRegime: 'FOP_9' })).status).toBe(400);
    expect((await request(app).patch('/tax-regime').send({ taxFixedMonthly: -1 })).status).toBe(400);
    expect((await request(app).patch('/tax-regime').send({ taxFixedMonthly: 50_000_000 })).status).toBe(400);
  });
});

describe('GET /cashbook/export', () => {
  it('власник отримує xlsx, вивантаження записано', async () => {
    const res = await request(app).get('/cashbook/export?from=2026-05-01&to=2026-05-31');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(prisma.changeLog.createMany).toHaveBeenCalledTimes(1);
  });

  it('модератор файл не вивантажує', async () => {
    role = 'ADMIN';
    const res = await request(app).get('/cashbook/export');
    expect(res.status).toBe(403);
    expect(prisma.changeLog.createMany).not.toHaveBeenCalled();
  });

  it('бухгалтер вивантажує файл сам — саме для цього й заведений акаунт', async () => {
    role = 'ACCOUNTANT';
    const res = await request(app).get('/cashbook/export?from=2026-05-01&to=2026-05-31');
    expect(res.status).toBe(200);
    expect(prisma.changeLog.createMany).toHaveBeenCalledTimes(1);
  });
});

describe('GET /debtors', () => {
  it('без журналу боржників не вигадуємо', async () => {
    prisma.bookingLedgerEntry.findFirst.mockResolvedValue(null);
    const res = await request(app).get('/debtors');
    expect(res.body).toEqual({ journalSince: null, total: 0, debtors: [] });
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it('списане з абонемента — не борг, недоплата — борг', async () => {
    const b = (id: string) => ({
      id, startTime: new Date('2026-05-10T15:00:00Z'), customerId: 'c1', customerName: 'Іван',
      customerPhone: '+380671234567', title: null, priceTotal: 60000, court: { name: 'Корт 1' },
      ledgerEntries: [], payment: null,
    });
    prisma.booking.findMany.mockResolvedValue([b('paid-by-pass'), b('unpaid')]);
    prisma.passUsage.findMany.mockResolvedValue([{ bookingId: 'paid-by-pass' }]);

    const res = await request(app).get('/debtors');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(60000);
    expect(res.body.debtors[0].items.map((i: { id: string }) => i.id)).toEqual(['unpaid']);
    expect(prisma.booking.findMany.mock.calls[0][0].where.clubId).toBe('club-1');
  });
});

describe('нові звіти', () => {
  it('абонементи: лише свого клубу, знятих не беремо', async () => {
    prisma.pass.findMany.mockResolvedValue([]);
    const res = await request(app).get('/passes');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 0, count: 0 });
    expect(prisma.pass.findMany.mock.calls[0][0].where).toMatchObject({ clubId: 'club-1', revokedAt: null });
  });

  it('тренери: лише проведені підтверджені заняття свого клубу', async () => {
    prisma.booking.findMany.mockResolvedValue([{
      trainerId: 't1', trainerPrice: 40000, attendance: 'ATTENDED',
      startTime: new Date('2026-05-10T10:00:00Z'), endTime: new Date('2026-05-10T11:00:00Z'),
      trainer: { name: 'Андрій', pricePerHour: 40000 },
    }]);
    const res = await request(app).get('/trainers?from=2026-05-01&to=2026-05-31');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(40000);
    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ clubId: 'club-1', status: 'CONFIRMED' });
  });

  it('P&L: дванадцять місяців і точка беззбитковості', async () => {
    Object.assign(prisma, { clubExpense: { findMany: vi.fn().mockResolvedValue([
      { month: new Date('2026-05-01T00:00:00Z'), category: 'RENT', amount: 30000 },
    ]) } });
    prisma.booking.findMany.mockResolvedValue([
      { startTime: new Date('2026-05-10T10:00:00Z'), endTime: new Date('2026-05-10T11:00:00Z'), priceTotal: 60000 },
    ]);
    const res = await request(app).get('/pnl?month=2026-05');
    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(12);
    expect(res.body.months.at(-1)).toMatchObject({ month: '2026-05', income: 60000, expenses: 30000, profit: 30000 });
    expect(res.body.breakEven).toMatchObject({ available: true, avgHour: 60000, hoursNeeded: 1 });
  });

  it('P&L: поганий місяць — 400', async () => {
    expect((await request(app).get('/pnl?month=2026-13')).status).toBe(400);
  });
});
