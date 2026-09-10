import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Повернення грошей — єдина дія кабінету, яка ЗАБИРАЄ гроші з рахунку клуба.
 *
 * Тому тут перевіряються не «щасливі шляхи», а межі: кого не пускаємо, що
 * не повертаємо двічі, і — головне — в якому порядку ходимо в банк і в базу.
 * Помилка в цьому порядку не падає з винятком: вона тихо показує власнику
 * «повернення в дорозі» за грошима, які нікуди не поїхали.
 */

const prisma = {
  user: { findUniqueOrThrow: vi.fn(async () => ({ email: 'owner@club.test' })) },
  payment: { findFirst: vi.fn(), update: vi.fn() },
  booking: { findFirst: vi.fn() },
  bookingSeat: { findUnique: vi.fn() },
};

const refund = vi.fn(async () => {});
const providerFor = vi.fn(() => ({ name: 'mock', refund }));

vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('../../lib/payments', () => ({ providerFor: (c: unknown) => providerFor(c as never) }));

/* Права перевіряються окремо, тут вони лише не мають заважати:
   підставляємо власника. */
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: 'u1', clubId: 'club-1', role: 'OWNER', trainerId: null };
    next();
  },
  requireRole: () => (_q: unknown, _s: unknown, next: () => void) => next(),
  requireStaff: (_q: unknown, _s: unknown, next: () => void) => next(),
  param: (req: { params: Record<string, string> }, name: string) => req.params[name],
}));

const { refundsRouter } = await import('./refunds');

const app = express().use(express.json()).use('/api/admin', refundsRouter);

const BOOKING_ID = '11111111-1111-4111-8111-111111111111';
const SEAT_ID = '22222222-2222-4222-8222-222222222222';

const payment = (over: Record<string, unknown> = {}) => ({
  id: 'pay-1',
  clubId: 'club-1',
  providerRef: 'inv-1',
  amount: 45000,
  status: 'PAID',
  refundRequestedAt: null,
  club: { paymentProvider: 'mock', paymentTokenEnc: null },
  ...over,
});

const post = (path: string) => request(app).post(`/api/admin${path}`);

beforeEach(() => {
  vi.clearAllMocks();
  /* clearAllMocks стирає виклики, але НЕ реалізації: без цього рядка
     mockRejectedValue із тесту «банк відмовив» жив би до кінця файлу. */
  refund.mockResolvedValue(undefined);
  providerFor.mockReturnValue({ name: 'mock', refund });
  prisma.booking.findFirst.mockResolvedValue({ id: BOOKING_ID, payment: { id: 'pay-1' } });
  prisma.bookingSeat.findUnique.mockResolvedValue({
    id: SEAT_ID, booking: { clubId: 'club-1' }, payment: { id: 'pay-1' },
  });
  prisma.payment.findFirst.mockResolvedValue(payment());
  prisma.payment.update.mockResolvedValue({});
});

describe('повернення за бронь корту', () => {
  it('оплачену бронь повертає й фіксує момент запиту', async () => {
    const res = await post(`/bookings/${BOOKING_ID}/refund`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, amount: 45000, requested: true });
    expect(refund).toHaveBeenCalledWith('inv-1', 45000);
    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 'pay-1' },
      data: { refundRequestedAt: expect.any(Date), refundRequestedBy: 'owner@club.test' },
    });
  });

  /* Найдорожча помилка в цьому файлі. Якщо позначити «повернення в дорозі»
     до походу в банк і банк відмовить, власник побачить, що гроші пішли, —
     а вони на місці. Дізнається він про це від гравця. */
  it('спершу банк, потім наша позначка', async () => {
    await post(`/bookings/${BOOKING_ID}/refund`);
    expect(refund.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.payment.update.mock.invocationCallOrder[0]);
  });

  it('банк відмовив — 502 і жодної позначки в базі', async () => {
    refund.mockRejectedValue(new Error('банк лежить'));
    const res = await post(`/bookings/${BOOKING_ID}/refund`);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('REFUND_FAILED');
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  /* Статус ставить вебхук, а не ми: правда про гроші приходить від банку.
     Якби роут писав REFUNDED сам, а банк потім відмовив, у базі лишилось би
     повернення, якого не було. */
  it('статус платежу роут не чіпає — це справа вебхука', async () => {
    await post(`/bookings/${BOOKING_ID}/refund`);
    const { data } = prisma.payment.update.mock.calls[0][0];
    expect(data.status).toBeUndefined();
    expect(data.refundedAt).toBeUndefined();
  });
});

describe('що повертати не можна', () => {
  it('неоплачений платіж — 409, у банк не йдемо', async () => {
    prisma.payment.findFirst.mockResolvedValue(payment({ status: 'PENDING' }));
    const res = await post(`/bookings/${BOOKING_ID}/refund`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NOTHING_TO_REFUND');
    expect(refund).not.toHaveBeenCalled();
  });

  it('уже повернутий — 409', async () => {
    prisma.payment.findFirst.mockResolvedValue(payment({ status: 'REFUNDED' }));
    const res = await post(`/bookings/${BOOKING_ID}/refund`);
    expect(res.status).toBe(409);
    expect(refund).not.toHaveBeenCalled();
  });

  /* Подвійне натискання — не гіпотеза: підтвердження від банку йде секунди,
     і весь цей час кнопка виглядає так само, як до натискання. */
  it('повернення вже запитано — другий запит у банк не йде', async () => {
    prisma.payment.findFirst.mockResolvedValue(
      payment({ refundRequestedAt: new Date('2026-08-25T10:00:00Z') }),
    );
    const res = await post(`/bookings/${BOOKING_ID}/refund`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('REFUND_ALREADY_REQUESTED');
    expect(refund).not.toHaveBeenCalled();
  });

  it('бронь без оплати — 409, а не 500', async () => {
    prisma.booking.findFirst.mockResolvedValue({ id: BOOKING_ID, payment: null });
    const res = await post(`/bookings/${BOOKING_ID}/refund`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NOTHING_TO_REFUND');
  });

  it('еквайринг клуба відключили — 409, а не падіння', async () => {
    providerFor.mockReturnValue(null as never);
    const res = await post(`/bookings/${BOOKING_ID}/refund`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PAYMENTS_OFF');
  });

  it('чужа бронь — 404', async () => {
    prisma.booking.findFirst.mockResolvedValue(null);
    expect((await post(`/bookings/${BOOKING_ID}/refund`)).status).toBe(404);
  });

  it('не uuid у шляху — 400', async () => {
    expect((await post('/bookings/не-uuid/refund')).status).toBe(400);
  });
});

describe('повернення за місце в групі', () => {
  it('повертає рівно за це місце, а не за все заняття', async () => {
    prisma.payment.findFirst.mockResolvedValue(payment({ amount: 25000 }));
    const res = await post(`/seats/${SEAT_ID}/refund`);
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(25000);
    expect(refund).toHaveBeenCalledWith('inv-1', 25000);
  });

  /* 404, а не 403: чуже місце не має підтверджувати навіть своє існування. */
  it('місце чужого клуба — 404, а не 403', async () => {
    prisma.bookingSeat.findUnique.mockResolvedValue({
      id: SEAT_ID, booking: { clubId: 'other-club' }, payment: { id: 'pay-1' },
    });
    const res = await post(`/seats/${SEAT_ID}/refund`);
    expect(res.status).toBe(404);
    expect(refund).not.toHaveBeenCalled();
  });

  it('місце оплачували на місці — повертати нічого', async () => {
    prisma.bookingSeat.findUnique.mockResolvedValue({
      id: SEAT_ID, booking: { clubId: 'club-1' }, payment: null,
    });
    const res = await post(`/seats/${SEAT_ID}/refund`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NOTHING_TO_REFUND');
  });

  /* Платіж шукається з clubId в умові, а не тільки по id: сам лише
     seat -> payment вірить зв'язку, а не перевіряє тенанта. */
  it('платіж читається в межах свого клуба', async () => {
    await post(`/seats/${SEAT_ID}/refund`);
    expect(prisma.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pay-1', clubId: 'club-1' } }),
    );
  });
});
