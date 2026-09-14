import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const prisma = { booking: { findMany: vi.fn(async () => []) } };
const auth = { role: 'ADMIN' };

vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: 'u1', clubId: 'club-1', role: auth.role, trainerId: null };
    next();
  },
  requireStaff: (req: { auth: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    req.auth.role === 'TRAINER' ? res.status(403).json({ error: 'FORBIDDEN' }) : next(),
}));

const { bookingSearchRouter, phoneNeedle } = await import('./bookingSearch');
const app = express().use('/api/admin', bookingSearchRouter);
const search = (q: string) => request(app).get('/api/admin/bookings/search').query({ q });

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = 'ADMIN';
});

describe('phoneNeedle', () => {
  it('зрізає код країни й провідний нуль — у базі +380…', () => {
    expect(phoneNeedle('067 123 45 67')).toBe('671234567');
    expect(phoneNeedle('+38 (067) 123-45-67')).toBe('671234567');
    expect(phoneNeedle('4567')).toBe('4567');
  });
  it('імʼя й надто короткі цифри — не телефон', () => {
    expect(phoneNeedle('Петренко')).toBeNull();
    expect(phoneNeedle('Кім 067')).toBeNull();
    expect(phoneNeedle('067')).toBeNull();
  });
});

describe('GET /bookings/search', () => {
  it('шукає тільки в своєму клубі й ділить на майбутні та минулі', async () => {
    const res = await search('0671234567');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ upcoming: [], past: [] });
    const [up, past] = prisma.booking.findMany.mock.calls.map((c) => (c as unknown as [{ where: Record<string, unknown>; orderBy: unknown }])[0]);
    expect(up.where.clubId).toBe('club-1');
    expect(JSON.stringify(up.where.OR)).toContain('671234567');
    expect(up.orderBy).toEqual({ startTime: 'asc' });
    expect(past.orderBy).toEqual({ startTime: 'desc' });
  });

  it('за імʼям шукає без урахування регістру, зокрема серед учасників груп', async () => {
    await search('петренко');
    const where = (prisma.booking.findMany.mock.calls[0] as unknown as [{ where: { OR: unknown[] } }])[0].where;
    expect(where.OR).toContainEqual({ customerName: { contains: 'петренко', mode: 'insensitive' } });
    expect(where.OR).toContainEqual({ seats: { some: { customerName: { contains: 'петренко', mode: 'insensitive' } } } });
  });

  it('тренеру — 403, порожній запит — 400', async () => {
    expect((await search('x')).status).toBe(400);
    auth.role = 'TRAINER';
    expect((await search('петренко')).status).toBe(403);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });
});
