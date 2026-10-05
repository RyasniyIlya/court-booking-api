import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/** Ц-1/Ц-2: тільки згода, тільки свої клуби, тільки білий список полів. */

const A = '11111111-1111-4111-8111-111111111111';
const prisma = {
  partner: { findUnique: vi.fn(), update: vi.fn() },
  club: { findMany: vi.fn() },
  court: { findMany: vi.fn() },
  booking: { findMany: vi.fn() },
  block: { findMany: vi.fn() },
};
vi.mock('../lib/db', () => ({ prisma }));
vi.mock('../lib/partnerAuth', () => ({
  requirePartnerAuth: (req: { partnerAuth?: unknown }, _r: unknown, next: () => void) => { req.partnerAuth = { partnerId: A }; next(); },
  signPartnerToken: vi.fn(),
}));
const { partnerRouter } = await import('./partner');
const app = express().use(express.json()).use(partnerRouter);

const hours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, openMinute: 480, closeMinute: 1320, isClosed: false }));
const club = (id: string, shared: boolean) => ({ id, name: id, timezone: 'Europe/Kyiv', createdAt: new Date('2025-01-01'), shareStatsWithPartner: shared, hours });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.court.findMany.mockResolvedValue([{ id: 'k1', name: 'Корт 1' }]);
  prisma.booking.findMany.mockResolvedValue([
    { courtId: 'k1', startTime: new Date(Date.now() - 5 * 86_400_000 - 3_600_000), endTime: new Date(Date.now() - 5 * 86_400_000 + 3_600_000), status: 'CONFIRMED' },
  ]);
  prisma.block.findMany.mockResolvedValue([]);
});

describe('GET /courts-stats', () => {
  it('не поділився: без кортів і без жодного запиту до броней', async () => {
    prisma.club.findMany.mockResolvedValue([club('c1', false)]);
    const res = await request(app).get('/courts-stats');
    expect(res.status).toBe(200);
    expect(res.body.clubs).toEqual([{ clubId: 'c1', name: 'c1', shared: false }]);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
    expect(prisma.court.findMany).not.toHaveBeenCalled();
  });

  it('поділився: агрегати кортів', async () => {
    prisma.club.findMany.mockResolvedValue([club('c1', true)]);
    const res = await request(app).get('/courts-stats?months=3');
    const c = res.body.clubs[0];
    expect(c).toMatchObject({ clubId: 'c1', shared: true });
    expect(c.courts[0]).toMatchObject({ courtId: 'k1', name: 'Корт 1', hoursPlayed: 2, hoursLastPeriod: 2 });
    expect(c.courts[0].peakHours.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(/customer|price|payment/i);
  });

  it('тільки клуби цього партнера', async () => {
    prisma.club.findMany.mockResolvedValue([]);
    await request(app).get('/courts-stats');
    expect(prisma.club.findMany.mock.calls[0][0].where).toEqual({ partnerId: A });
  });

  it('select-и: тільки початок/кінець/корт/статус, без гравців і грошей', async () => {
    prisma.club.findMany.mockResolvedValue([club('c1', true)]);
    await request(app).get('/courts-stats');
    const sel = prisma.booking.findMany.mock.calls[0][0].select;
    expect(Object.keys(sel).sort()).toEqual(['courtId', 'endTime', 'startTime', 'status']);
    expect(Object.keys(prisma.block.findMany.mock.calls[0][0].select).sort()).toEqual(['courtId', 'endTime', 'startTime']);
    expect(prisma.booking.findMany.mock.calls[0][0]).not.toHaveProperty('include');
    for (const k of ['customer', 'customerId', 'priceTotal', 'payments', 'payment', 'phone']) expect(sel).not.toHaveProperty(k);
  });

  it('months поза межами: 400', async () => {
    expect((await request(app).get('/courts-stats?months=99')).status).toBe(400);
  });
});
