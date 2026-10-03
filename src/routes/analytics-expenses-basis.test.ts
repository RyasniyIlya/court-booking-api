import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Ф-1: /analytics/expenses і /finance/pnl - один прибуток, база за параметром
 * basis=accrual|cash (за замовчуванням accrual), однакова форма й однакове число.
 */
const prisma = {
  club: { findUnique: vi.fn() },
  user: { findFirst: vi.fn() },
  bookingLedgerEntry: { findMany: vi.fn(), findFirst: vi.fn() },
  payment: { findMany: vi.fn() },
  pass: { findMany: vi.fn() },
  booking: { findMany: vi.fn() },
  bookingSeat: { findMany: vi.fn() },
  passUsage: { findMany: vi.fn() },
  clubExpense: { findMany: vi.fn() },
};
vi.mock('../lib/db', () => ({ prisma }));

let role = 'OWNER';
vi.mock('./admin', async () => {
  const shared = await vi.importActual<typeof import('./admin/shared')>('./admin/shared');
  return {
    requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
      req.auth = { userId: 'u1', clubId: 'club-1', role, trainerId: null };
      next();
    },
    requireRole: shared.requireRole,
    requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

const { analyticsRouter } = await import('./analytics');
const { financeRouter } = await import('./finance');
const app = express().use(express.json()).use('/analytics', analyticsRouter).use('/finance', financeRouter);

beforeEach(() => {
  role = 'OWNER';
  vi.resetAllMocks();
  prisma.club.findUnique.mockResolvedValue({ timezone: 'Europe/Kyiv' });
  prisma.clubExpense.findMany.mockResolvedValue([
    { id: 'e1', month: new Date('2026-08-01T00:00:00Z'), category: 'RENT', label: 'Оренда', amount: 400000 },
  ]);
  /* 700 000 нарахованих: одна бронь, з тренером 30 000 усередині priceTotal. */
  prisma.booking.findMany.mockResolvedValue([
    {
      id: 'b1', startTime: new Date('2026-08-10T09:00:00Z'), endTime: new Date('2026-08-10T10:00:00Z'),
      priceTotal: 700000, rentalTotal: 0, trainerPrice: 30000, capacity: null, customer: null,
    },
  ]);
  prisma.passUsage.findMany.mockResolvedValue([]);
  prisma.bookingSeat.findMany.mockResolvedValue([]);
  prisma.bookingLedgerEntry.findMany.mockResolvedValue([{
    id: 'l1', createdAt: new Date('2026-08-11T09:00:00Z'), kind: 'PAYMENT', method: 'CASH', amount: 900000,
    account: 'Каса', note: '', actorEmail: 'a@b.c', seatId: null, booking: null, seat: null,
  }]);
  prisma.bookingLedgerEntry.findFirst.mockResolvedValue(null);
  prisma.payment.findMany.mockResolvedValue([]);
  prisma.pass.findMany.mockResolvedValue([]);
});

describe('GET /analytics/expenses - basis', () => {
  it('за замовчуванням accrual; alt - каса; netProfit = profit', async () => {
    const res = await request(app).get('/analytics/expenses?month=2026-08');
    expect(res.status).toBe(200);
    expect(res.body.basis).toBe('accrual');
    expect(res.body.pnl).toEqual({
      basis: 'accrual', revenue: 700000, expenses: 400000, profit: 300000,
      alt: { basis: 'cash', revenue: 900000, profit: 500000 },
    });
    expect(res.body).toMatchObject({ revenue: 700000, totalExpenses: 400000, profit: 300000, netProfit: 300000 });
    expect(Array.isArray(res.body.expenses)).toBe(true);
  });

  it('basis=cash міняє базу, витрати ті самі', async () => {
    const res = await request(app).get('/analytics/expenses?month=2026-08&basis=cash');
    expect(res.body.pnl).toMatchObject({ basis: 'cash', revenue: 900000, profit: 500000, alt: { basis: 'accrual', profit: 300000 } });
    expect(res.body.netProfit).toBe(500000);
  });

  it('невідома база - 400', async () => {
    expect((await request(app).get('/analytics/expenses?basis=gross')).status).toBe(400);
  });

  it('ADMIN і ACCOUNTANT - 403', async () => {
    for (const r of ['ADMIN', 'ACCOUNTANT']) {
      role = r;
      expect((await request(app).get('/analytics/expenses?basis=cash')).status, r).toBe(403);
    }
  });
});

describe('GET /finance/pnl - basis, те саме число', () => {
  it('однаковий прибуток місяця й форма pnl на обох ендпоінтах для обох баз', async () => {
    for (const basis of ['accrual', 'cash'] as const) {
      const a = await request(app).get(`/analytics/expenses?month=2026-08&basis=${basis}`);
      const f = await request(app).get(`/finance/pnl?month=2026-08&basis=${basis}`);
      expect(f.status).toBe(200);
      expect(f.body.pnl).toEqual(a.body.pnl);
      expect(f.body.months.at(-1).profit).toBe(a.body.netProfit);
    }
  });

  it('за замовчуванням accrual, alt-блок, 400 на погану базу, ADMIN 403', async () => {
    const f = await request(app).get('/finance/pnl?month=2026-08');
    expect(f.body).toMatchObject({ basis: 'accrual', profit: 300000, alt: { basis: 'cash', profit: 500000 } });
    expect(f.body.months).toHaveLength(12);
    expect((await request(app).get('/finance/pnl?basis=x')).status).toBe(400);
    role = 'ADMIN';
    expect((await request(app).get('/finance/pnl')).status).toBe(403);
  });
});
