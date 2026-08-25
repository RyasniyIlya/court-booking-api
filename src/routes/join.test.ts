import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Запис у групове заняття — єдине місце в проєкті, де від гонки захищає
 * код, а не констрейнт бази. Тут воно перевіряється на моках: справжня
 * гонка перевіряється навантаженням (вісім одночасних запитів на два
 * місця), а ці тести стережуть решту правил, які в бою побачити важко —
 * скасоване заняття, повторний телефон, чужий клуб.
 *
 * Мокаємо шар даних цілком: тест про рішення обробника, а не про Postgres.
 */

const tx = {
  $queryRaw: vi.fn(),
  bookingSeat: {
    count: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  booking: { update: vi.fn() },
};

const prisma = {
  club: { findFirst: vi.fn() },
  booking: { findMany: vi.fn(), findUnique: vi.fn() },
  block: { findFirst: vi.fn() },
  bookingSeat: { findMany: vi.fn(), findUnique: vi.fn() },
  customer: { findUnique: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
};

vi.mock('../lib/db', () => ({
  prisma,
  isSlotTakenError: () => false,
  notifyClub: vi.fn(),
}));

vi.mock('../lib/customers', () => ({
  findOrCreateCustomer: vi.fn(async () => ({ id: 'cust-1', isBlocked: false })),
  getActivePass: vi.fn(),
  getActivePasses: vi.fn(async () => new Map()),
}));

vi.mock('../lib/billing', () => ({
  clubBilling: () => ({ online: true }),
}));

vi.mock('../lib/payments', () => ({
  providerFor: () => null,
  publicBase: () => 'https://example.test',
}));

const { publicRouter } = await import('./public');
const { findOrCreateCustomer } = await import('../lib/customers');

const app = express().use(express.json()).use('/api/public', publicRouter);

const CLUB = {
  id: 'club-1',
  slug: 'test-club',
  timezone: 'Europe/Kyiv',
  leadTimeMinutes: 60,
  hours: [],
  courts: [],
  trainers: [],
};

const GROUP_ID = '11111111-1111-4111-8111-111111111111';
/** Заняття далеко попереду — leadTime не має заважати */
const soon = () => new Date(Date.now() + 24 * 3600_000);

/** Рядок, який повертає SELECT ... FOR UPDATE */
const groupRow = (over: Record<string, unknown> = {}) => [{
  id: GROUP_ID,
  clubId: CLUB.id,
  capacity: 8,
  pricePerSeat: 25000,
  status: 'CONFIRMED',
  startTime: soon(),
  ...over,
}];

const join = (body: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/public/clubs/test-club/bookings/${GROUP_ID}/join`)
    .send({ customerName: 'Оксана', customerPhone: '+380671234567', ...body });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.club.findFirst.mockResolvedValue(CLUB);
  prisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
  tx.$queryRaw.mockResolvedValue(groupRow());
  tx.bookingSeat.count.mockResolvedValue(0);
  tx.bookingSeat.findFirst.mockResolvedValue(null);
  tx.bookingSeat.create.mockResolvedValue({ id: 'seat-1', cancelToken: 'tok-1', price: 25000 });
  tx.booking.update.mockResolvedValue({});
  vi.mocked(findOrCreateCustomer).mockResolvedValue({ id: 'cust-1', isBlocked: false } as never);
});

describe('POST /clubs/:slug/bookings/:id/join', () => {
  it('вільне місце — записує і віддає токен скасування', async () => {
    const res = await join();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'seat-1', cancelToken: 'tok-1', price: 25000 });
  });

  it('ціна місця фіксується на момент запису', async () => {
    await join();
    expect(tx.bookingSeat.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ price: 25000 }) }),
    );
  });

  it('виручка заняття росте разом із проданим місцем', async () => {
    await join();
    expect(tx.booking.update).toHaveBeenCalledWith({
      where: { id: GROUP_ID },
      data: { priceTotal: { increment: 25000 } },
    });
  });

  it('телефон нормалізується — інакше та сама людина стане двома', async () => {
    await join({ customerPhone: '067 123 45 67' });
    expect(tx.bookingSeat.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customerPhone: '+380671234567' }),
      }),
    );
  });

  it('усі місця зайняті — 409 GROUP_FULL і жодного запису', async () => {
    tx.bookingSeat.count.mockResolvedValue(8);
    const res = await join();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('GROUP_FULL');
    expect(tx.bookingSeat.create).not.toHaveBeenCalled();
  });

  it('той самий телефон удруге — 409 ALREADY_JOINED', async () => {
    tx.bookingSeat.findFirst.mockResolvedValue({ id: 'seat-old' });
    const res = await join();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ALREADY_JOINED');
    expect(tx.bookingSeat.create).not.toHaveBeenCalled();
  });

  it('це звичайна бронь, а не група — 400 NOT_A_GROUP', async () => {
    tx.$queryRaw.mockResolvedValue(groupRow({ capacity: null }));
    const res = await join();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NOT_A_GROUP');
  });

  it('заняття скасували — 409, а не мовчазний запис у нікуди', async () => {
    tx.$queryRaw.mockResolvedValue(groupRow({ status: 'CANCELLED' }));
    const res = await join();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('GROUP_CANCELLED');
  });

  it('до початку менше за leadTime — 400 TOO_LATE', async () => {
    tx.$queryRaw.mockResolvedValue(groupRow({ startTime: new Date(Date.now() + 10 * 60_000) }));
    const res = await join();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('TOO_LATE');
  });

  it('заняття чужого клубу не видно — 404, а не 403', async () => {
    // 403 підказав би, що таке заняття існує
    tx.$queryRaw.mockResolvedValue(groupRow({ clubId: 'other-club' }));
    const res = await join();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('заняття не існує — 404', async () => {
    tx.$queryRaw.mockResolvedValue([]);
    const res = await join();
    expect(res.status).toBe(404);
  });

  it('клієнт у чорному списку не записується', async () => {
    vi.mocked(findOrCreateCustomer).mockResolvedValue({ id: 'c', isBlocked: true } as never);
    const res = await join();
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CUSTOMER_BLOCKED');
  });

  it('невідомий клуб — 404', async () => {
    prisma.club.findFirst.mockResolvedValue(null);
    const res = await join();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CLUB_NOT_FOUND');
  });

  it('закоротке імʼя — 400', async () => {
    expect((await join({ customerName: 'О' })).status).toBe(400);
  });

  it('телефон не з цифр — 400', async () => {
    expect((await join({ customerPhone: 'абв' })).status).toBe(400);
  });

  it('без імені — 400', async () => {
    expect((await join({ customerName: undefined })).status).toBe(400);
  });

  it('заняття блокується FOR UPDATE — без цього двоє купили б останнє місце', async () => {
    await join();
    const sql = tx.$queryRaw.mock.calls[0][0] as { strings?: string[] } | string[];
    const text = Array.isArray(sql) ? sql.join('') : (sql.strings ?? []).join('');
    expect(text).toContain('FOR UPDATE');
  });

  it('перевірка й запис ідуть в одній транзакції', async () => {
    await join();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
