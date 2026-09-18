import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const prisma = {
  booking: { findFirst: vi.fn(), update: vi.fn() },
  court: { findFirst: vi.fn() },
  club: { findUniqueOrThrow: vi.fn() },
  customer: { findUnique: vi.fn() },
  trainer: { findFirst: vi.fn() },
  changeLog: { createMany: vi.fn(async () => ({ count: 1 })) },
  user: { findUniqueOrThrow: vi.fn(async () => ({ email: 'moder@club.test', role: 'ADMIN', name: 'Оля' })) },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
};

const auth = { userId: 'moder', clubId: 'club', role: 'ADMIN', trainerId: null as string | null };

vi.mock('../../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../../lib/notifyBooking', () => ({ notifyBooking: vi.fn(), notifySeriesCancelled: vi.fn() }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => { req.auth = auth; next(); },
  requireStaff: (_req: unknown, _res: unknown, next: () => void) => next(),
  hasFeature: () => true,
  param: (req: { params: Record<string, string> }, key: string) => req.params[key],
}));

const { bookingsRouter } = await import('./bookings');
const app = express().use(express.json()).use(bookingsRouter);

const COURT = '11111111-1111-4111-8111-111111111111';

const tournament = {
  id: 'booking', clubId: 'club', courtId: COURT, status: 'CONFIRMED',
  capacity: 16, title: '🏆 Осінній кубок', pricePerSeat: 20000,
  customerId: null, trainerId: null, trainerPrice: 0,
  priceTotal: 0, rentalTotal: 0, rentals: [], promoNames: [], promoDiscount: 0,
  comment: null, ledgerEntries: [], payment: null, expiresAt: null,
  startTime: new Date('2030-01-01T08:00:00Z'), endTime: new Date('2030-01-01T12:00:00Z'),
};

const patch = (body: unknown) => request(app).patch('/bookings/booking').send(body);
const logged = () => prisma.changeLog.createMany.mock.calls[0]?.[0]?.data ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = 'ADMIN';
  auth.trainerId = null;
  prisma.booking.findFirst.mockResolvedValue(tournament);
  prisma.booking.update.mockResolvedValue({});
  prisma.changeLog.createMany.mockResolvedValue({ count: 1 });
});

describe('назва й внесок турніру', () => {
  it('перейменовує турнір, лишаючи маркер на місці', async () => {
    /* Людина, яка стерла емодзі з поля назви, не мала на увазі
       «перетвори це на звичайну йогу». */
    const r = await patch({ title: 'Кубок памʼяті' });
    expect(r.status).toBe(200);
    expect(prisma.booking.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ title: '🏆 Кубок памʼяті' }),
    }));
  });

  it('міняє внесок і НЕ чіпає вже продані місця', async () => {
    const r = await patch({ pricePerSeat: 25000 });
    expect(r.status).toBe(200);
    expect(prisma.booking.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pricePerSeat: 25000 }),
    }));
    /* Жодного дотику до BookingSeat: ціна місця — знімок на момент
       запису, і піднімати її заднім числом означало б зробити боржником
       того, хто заплатив рівно стільки, скільки в нього попросили. */
    expect(JSON.stringify(prisma.booking.update.mock.calls)).not.toContain('seats');
  });

  it('у приватної броні назви й внеску немає', async () => {
    prisma.booking.findFirst.mockResolvedValue({ ...tournament, capacity: null, title: null });
    const r = await patch({ title: 'Будь-що' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('NOT_A_GROUP_BOOKING');
  });

  it('тренер турнір не перейменовує', async () => {
    auth.role = 'TRAINER';
    auth.trainerId = 'trainer-1';
    prisma.booking.findFirst.mockResolvedValue({ ...tournament, trainerId: 'trainer-1' });
    const r = await patch({ title: 'Моє' });
    expect(r.status).toBe(403);
  });
});

describe('журнал змін', () => {
  it('записує хто, що і з чого на що', async () => {
    await patch({ title: 'Кубок памʼяті', pricePerSeat: 25000 });

    expect(logged()).toEqual([
      expect.objectContaining({
        entity: 'TOURNAMENT', entityId: 'booking', field: 'title',
        before: '🏆 Осінній кубок', after: '🏆 Кубок памʼяті',
        actorEmail: 'moder@club.test', actorRole: 'ADMIN',
      }),
      expect.objectContaining({ field: 'pricePerSeat', before: 20000, after: 25000 }),
    ]);
  });

  it('мовчить, коли нічого не змінилось', async () => {
    /* PATCH, переcланий тим самим тілом удруге, не має лишати рядок
       «нічого не сталось». */
    await patch({ title: 'Осінній кубок', pricePerSeat: 20000 });
    expect(prisma.changeLog.createMany).not.toHaveBeenCalled();
  });

  it('не дублює скасування — у нього своя мітка часу', async () => {
    await patch({ status: 'CANCELLED' });
    expect(logged().map((row: { field: string }) => row.field)).not.toContain('status');
  });

  it('пише замітку разом із тим, хто її поставив', async () => {
    prisma.booking.findFirst.mockResolvedValue({ ...tournament, capacity: null, title: null, comment: null });
    await patch({ comment: 'Сітка о 9:00' });
    expect(logged()).toEqual([
      expect.objectContaining({ entity: 'BOOKING', field: 'comment', before: null, after: 'Сітка о 9:00' }),
    ]);
  });

  it('збій журналу не ламає саму правку', async () => {
    /* Бронь уже змінена, і 500 замість «готово» тут — гірша брехня, ніж
       пропущений рядок. */
    prisma.changeLog.createMany.mockRejectedValue(new Error('db down'));
    const r = await patch({ title: 'Кубок памʼяті' });
    expect(r.status).toBe(200);
  });
});
