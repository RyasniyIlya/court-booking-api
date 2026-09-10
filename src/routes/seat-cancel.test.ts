import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Звільнення свого місця. Дві дороги до однієї дії — токен місця й токен
 * кабінету, — і головне тут не «спрацювало», а «не спрацювало для чужого»:
 * сусід по групі не має знімати чужий запис, знаючи лише id.
 */

const tx = {
  bookingSeat: { findUnique: vi.fn(), update: vi.fn() },
  booking: { update: vi.fn() },
};

const prisma = {
  club: { findFirst: vi.fn() },
  booking: { findMany: vi.fn(), findUnique: vi.fn() },
  bookingSeat: { findMany: vi.fn() },
  customer: { findUnique: vi.fn() },
  $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
};

const verifyCustomerToken = vi.fn();

vi.mock('../lib/db', () => ({
  prisma, isSlotTakenError: () => false, notifyClub: vi.fn(),
}));
vi.mock('../lib/customers', () => ({
  findOrCreateCustomer: vi.fn(), getActivePass: vi.fn(), getActivePasses: vi.fn(),
}));
vi.mock('../lib/billing', () => ({ clubBilling: () => ({ online: true }) }));
vi.mock('../lib/payments', () => ({
  providerFor: () => null, publicBase: () => 'https://example.test',
}));
vi.mock('../lib/customerAuth', () => ({
  signCustomerToken: vi.fn(),
  verifyCustomerToken,
}));

const { publicRouter } = await import('./public');
const app = express().use(express.json()).use('/api/public', publicRouter);

const SEAT_ID = '22222222-2222-4222-8222-222222222222';
const OWN_TOKEN = '33333333-3333-4333-8333-333333333333';
const ALIEN_TOKEN = '44444444-4444-4444-8444-444444444444';

const seat = (over: Record<string, unknown> = {}) => ({
  id: SEAT_ID,
  status: 'BOOKED',
  price: 25000,
  cancelToken: OWN_TOKEN,
  customerId: 'cust-1',
  booking: {
    id: 'booking-1',
    clubId: 'club-1',
    startTime: new Date(Date.now() + 24 * 3600_000),
    club: { cancelCutoffMinutes: 0 },
  },
  ...over,
});

const cancel = (body: Record<string, unknown> = {}, bearer?: string) => {
  const r = request(app).post(`/api/public/seats/${SEAT_ID}/cancel`);
  if (bearer) r.set('Authorization', `Bearer ${bearer}`);
  return r.send(body);
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
  tx.bookingSeat.findUnique.mockResolvedValue(seat());
  tx.bookingSeat.update.mockResolvedValue({});
  tx.booking.update.mockResolvedValue({});
  verifyCustomerToken.mockReturnValue(null);
});

describe('POST /seats/:id/cancel', () => {
  it('свій токен місця — знімає', async () => {
    const res = await cancel({ token: OWN_TOKEN });
    expect(res.status).toBe(200);
    expect(tx.bookingSeat.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    );
  });

  it('токен кабінету того самого клієнта — знімає', async () => {
    verifyCustomerToken.mockReturnValue({ customerId: 'cust-1', clubId: 'club-1' });
    const res = await cancel({}, 'cabinet-jwt');
    expect(res.status).toBe(200);
  });

  it('виручка зменшується разом зі знятим місцем', async () => {
    await cancel({ token: OWN_TOKEN });
    expect(tx.booking.update).toHaveBeenCalledWith({
      where: { id: 'booking-1' },
      data: { priceTotal: { decrement: 25000 } },
    });
  });

  /* Найважливіше в цьому файлі. 404, а не 403: інакше по коду відповіді
     можна було б перебором зʼясувати, які місця існують. */
  it('чужий токен місця — 404 і нічого не змінено', async () => {
    const res = await cancel({ token: ALIEN_TOKEN });
    expect(res.status).toBe(404);
    expect(tx.bookingSeat.update).not.toHaveBeenCalled();
  });

  it('зовсім без доказів — 404', async () => {
    const res = await cancel({});
    expect(res.status).toBe(404);
    expect(tx.bookingSeat.update).not.toHaveBeenCalled();
  });

  it('кабінет ІНШОГО клієнта — 404', async () => {
    verifyCustomerToken.mockReturnValue({ customerId: 'cust-999', clubId: 'club-1' });
    const res = await cancel({}, 'cabinet-jwt');
    expect(res.status).toBe(404);
    expect(tx.bookingSeat.update).not.toHaveBeenCalled();
  });

  it('кабінет того самого клієнта, але іншого клубу — 404', async () => {
    verifyCustomerToken.mockReturnValue({ customerId: 'cust-1', clubId: 'club-999' });
    const res = await cancel({}, 'cabinet-jwt');
    expect(res.status).toBe(404);
  });

  it('місця не існує — 404', async () => {
    tx.bookingSeat.findUnique.mockResolvedValue(null);
    const res = await cancel({ token: OWN_TOKEN });
    expect(res.status).toBe(404);
  });

  it('повторне скасування не помилка — людина двічі тицьнула', async () => {
    tx.bookingSeat.findUnique.mockResolvedValue(seat({ status: 'CANCELLED' }));
    const res = await cancel({ token: OWN_TOKEN });
    expect(res.status).toBe(200);
    // Але вдруге виручку не віднімаємо
    expect(tx.booking.update).not.toHaveBeenCalled();
  });

  it('заняття вже почалось — ALREADY_STARTED', async () => {
    tx.bookingSeat.findUnique.mockResolvedValue(seat({
      booking: {
        id: 'booking-1', clubId: 'club-1',
        startTime: new Date(Date.now() - 60_000),
        club: { cancelCutoffMinutes: 0 },
      },
    }));
    const res = await cancel({ token: OWN_TOKEN });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ALREADY_STARTED');
  });

  it('вікно клубу закрилось — CANCEL_CLOSED, окремо від «уже почалось»', async () => {
    tx.bookingSeat.findUnique.mockResolvedValue(seat({
      booking: {
        id: 'booking-1', clubId: 'club-1',
        // до початку 3 години, а клуб закриває скасування за 5
        startTime: new Date(Date.now() + 3 * 3600_000),
        club: { cancelCutoffMinutes: 300 },
      },
    }));
    const res = await cancel({ token: OWN_TOKEN });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('CANCEL_CLOSED');
    expect(tx.bookingSeat.update).not.toHaveBeenCalled();
  });

  it('id не uuid — 400', async () => {
    const res = await request(app).post('/api/public/seats/не-uuid/cancel').send({});
    expect(res.status).toBe(400);
  });
});
