import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Запис у групове заняття з передоплатою.
 *
 * Окремий файл від join.test.ts свідомо: там провайдер вимкнений і
 * перевіряються правила самого запису, тут увімкнений — і перевіряється
 * рівно те, що додає оплата. Змішати їх означало б у кожному тесті
 * пояснювати, у якому з двох світів він живе.
 *
 * Головне, що тут стережеться: неоплачене місце тримає місткість, але НЕ
 * тримає виручку. Переплутати ці дві речі — значить або продати останній
 * стілець двічі, або показати клубу гроші, яких він не бачив.
 */

const tx = {
  $queryRaw: vi.fn(),
  bookingSeat: { count: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  booking: { update: vi.fn() },
};

const prisma = {
  club: { findFirst: vi.fn() },
  booking: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  block: { findFirst: vi.fn() },
  bookingSeat: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  payment: { create: vi.fn() },
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

vi.mock('../lib/billing', () => ({ clubBilling: () => ({ online: true }) }));

vi.mock('../lib/notifyBooking', () => ({ notifyBooking: vi.fn() }));

const createInvoice = vi.fn(async () => ({
  providerRef: 'inv-1',
  pageUrl: 'https://pay.test/inv-1',
}));

vi.mock('../lib/payments', () => ({
  providerFor: () => ({ name: 'mock', createInvoice }),
  publicBase: () => 'https://api.test',
}));

const { publicRouter } = await import('./public');

const app = express().use(express.json()).use('/api/public', publicRouter);

const CLUB = {
  id: 'club-1',
  slug: 'test-club',
  name: 'Сквош Арена',
  timezone: 'Europe/Kyiv',
  leadTimeMinutes: 60,
  payHoldMinutes: 15,
  prepayEnabled: true,
  prepayRequired: true,
  paymentProvider: 'mock',
  hours: [],
  courts: [],
  trainers: [],
};

const GROUP_ID = '11111111-1111-4111-8111-111111111111';
const soon = () => new Date(Date.now() + 24 * 3600_000);

const groupRow = (over: Record<string, unknown> = {}) => [{
  id: GROUP_ID,
  clubId: CLUB.id,
  capacity: 8,
  pricePerSeat: 25000,
  status: 'CONFIRMED',
  title: 'Ранкова йога',
  startTime: soon(),
  endTime: new Date(soon().getTime() + 3600_000),
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
  tx.bookingSeat.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'seat-1', cancelToken: '22222222-2222-4222-8222-222222222222', ...data,
  }));
  tx.booking.update.mockResolvedValue({});
  prisma.bookingSeat.update.mockResolvedValue({});
  prisma.booking.update.mockResolvedValue({});
  prisma.payment.create.mockResolvedValue({});
  createInvoice.mockResolvedValue({ providerRef: 'inv-1', pageUrl: 'https://pay.test/inv-1' });
});

describe('запис у групу з передоплатою', () => {
  it('віддає посилання на платіжку й тримає місце в PENDING', async () => {
    const res = await join();
    expect(res.status).toBe(201);
    expect(res.body.payUrl).toBe('https://pay.test/inv-1');
    expect(res.body.status).toBe('PENDING');
    expect(res.body.expiresAt).toBeTruthy();
  });

  it('місце створюється PENDING з холдом, а не одразу BOOKED', async () => {
    await join();
    const { data } = tx.bookingSeat.create.mock.calls[0][0];
    expect(data.status).toBe('PENDING');
    expect(data.expiresAt).toBeInstanceOf(Date);
  });

  /* Ключове правило: покинутий кошик не має підіймати підсумок дня.
     Виручку додає вебхук оплати, а не сам факт натискання кнопки. */
  it('виручка заняття НЕ росте, поки місце не оплачене', async () => {
    await join();
    expect(tx.booking.update).not.toHaveBeenCalled();
  });

  it('рахунок виставляється на ціну одного місця, а не всього заняття', async () => {
    await join();
    expect(createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ amountKop: 25000, reference: 'seat-1' }),
    );
  });

  it('платіж заводиться на місце, а не на бронь корту', async () => {
    await join();
    const { data } = prisma.payment.create.mock.calls[0][0];
    expect(data.seatId).toBe('seat-1');
    expect(data.bookingId).toBeUndefined();
  });

  /* Гравець має повернутись туди, звідки пішов, і віджет має зрозуміти,
     що перевіряти саме місце, а не бронь. */
  it('у зворотну адресу кладеться cbSeat з токеном місця', async () => {
    await join();
    const { redirectUrl } = createInvoice.mock.calls[0][0];
    expect(new URL(redirectUrl).searchParams.get('cbSeat'))
      .toBe('22222222-2222-4222-8222-222222222222');
  });

  /* Похід у банк займає сотні мілісекунд. Якби він стояв усередині
     транзакції, всі, хто записується в ту саму групу, чекали б на нього
     під рядковим замком. */
  it('рахунок виставляється ПІСЛЯ транзакції запису', async () => {
    await join();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const txOrder = prisma.$transaction.mock.invocationCallOrder[0];
    const invoiceOrder = createInvoice.mock.invocationCallOrder[0];
    expect(invoiceOrder).toBeGreaterThan(txOrder);
  });

  it('банк не відповів — місце лишається за гравцем з оплатою в клубі', async () => {
    createInvoice.mockRejectedValue(new Error('банк лежить'));
    const res = await join();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('BOOKED');
    expect(res.body.payUnavailable).toBe(true);
    expect(prisma.bookingSeat.update).toHaveBeenCalledWith({
      where: { id: 'seat-1' },
      data: { status: 'BOOKED', expiresAt: null },
    });
  });

  /* Місце під оплатою займає місткість — інакше восьмимісна група продала
     б дев'яте місце за ті самі п'ятнадцять хвилин холду. */
  it('PENDING рахується зайнятим при перевірці вільних місць', async () => {
    await join();
    expect(tx.bookingSeat.count).toHaveBeenCalledWith({
      where: { bookingId: GROUP_ID, status: { in: ['BOOKED', 'PENDING'] } },
    });
  });

  it('той самий телефон із незавершеною оплатою не записується вдруге', async () => {
    tx.bookingSeat.findFirst.mockResolvedValue({ id: 'seat-old' });
    const res = await join();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ALREADY_JOINED');
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it('безкоштовне місце платіжки не відкриває', async () => {
    tx.$queryRaw.mockResolvedValue(groupRow({ pricePerSeat: 0 }));
    const res = await join();
    expect(res.status).toBe(201);
    expect(res.body.payUrl).toBeUndefined();
    expect(createInvoice).not.toHaveBeenCalled();
    // Нуль до виручки додається як є — гілки «безкоштовно» в підсумку немає
    expect(tx.booking.update).toHaveBeenCalled();
  });
});

describe('клуб лишив вибір способу оплати гравцю', () => {
  const CHOICE_CLUB = { ...CLUB, prepayRequired: false };

  beforeEach(() => {
    prisma.club.findFirst.mockResolvedValue(CHOICE_CLUB);
  });

  it('без вибору — 400, а не тихе вгадування', async () => {
    const res = await join();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('PAY_CHOICE_REQUIRED');
    expect(tx.bookingSeat.create).not.toHaveBeenCalled();
  });

  it('обрав «на місці» — записується одразу, без платіжки', async () => {
    const res = await join({ payChoice: 'onsite' });
    expect(res.status).toBe(201);
    expect(res.body.payUrl).toBeUndefined();
    expect(createInvoice).not.toHaveBeenCalled();
    // Оплата на місці — місце продане одразу, виручка росте одразу
    expect(tx.booking.update).toHaveBeenCalledWith({
      where: { id: GROUP_ID },
      data: { priceTotal: { increment: 25000 } },
    });
  });

  it('обрав «онлайн» — веде на платіжку', async () => {
    const res = await join({ payChoice: 'online' });
    expect(res.status).toBe(201);
    expect(res.body.payUrl).toBe('https://pay.test/inv-1');
  });
});
