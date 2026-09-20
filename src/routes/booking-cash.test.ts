import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
const prisma = { club: { findFirst: vi.fn() }, block: { findFirst: vi.fn() }, customer: { findUnique: vi.fn() },
  booking: { create: vi.fn(), update: vi.fn() }, payment: { create: vi.fn() },
  /* Бронь пишеться в транзакції разом із прокатом; без прокату це той самий create. */
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)) };
const providerFor = vi.fn(() => null);
const notifyBooking = vi.fn();
vi.mock('../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../lib/payments', () => ({ providerFor, publicBase: () => 'https://api.test' }));
vi.mock('../lib/notifyBooking', () => ({ notifyBooking }));
vi.mock('../lib/billing', () => ({ clubBilling: () => ({ online: true }) }));
vi.mock('../lib/customers', async orig => ({ ...(await orig<typeof import('../lib/customers')>()), findOrCreateCustomer: vi.fn(async () => null) }));
const { publicRouter } = await import('./public');
const { findOrCreateCustomer } = await import('../lib/customers');
const app = express().use(express.json()).use(publicRouter);
const courtId = '11111111-1111-4111-8111-111111111111';
const club = { id: 'club', slug: 'demo', timezone: 'UTC', leadTimeMinutes: 0, slotMinutes: 60,
  prepayEnabled: true, prepayRequired: false, autoConfirm: true, promos: [], trainers: [],
  courts: [{ id: courtId, pricePerHour: 50000 }],
  hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, openMinute: 0, closeMinute: 1440, isClosed: false })) };
beforeEach(() => {
  vi.clearAllMocks();
  prisma.club.findFirst.mockResolvedValue(club);
  prisma.block.findFirst.mockResolvedValue(null);
  prisma.customer.findUnique.mockResolvedValue(null);
  prisma.booking.create.mockImplementation(async ({ data }) => ({ ...data, id: 'booking', cancelToken: 'cancel' }));
  prisma.booking.update.mockResolvedValue({});
  prisma.payment.create.mockResolvedValue({});
  providerFor.mockReturnValue(null);
  vi.mocked(findOrCreateCustomer).mockResolvedValue(null);
});
/* Еквайринг мовчить — оплатити онлайн неможливо в принципі, тож відмова
   означала б «ніколи». Бронь лишається неоплаченою і чекає адміністратора. */
it('клієнта «тільки з передоплатою» не лишає без броні, коли платити нічим', async () => {
  vi.mocked(findOrCreateCustomer).mockResolvedValue({
    id: 'customer', isBlocked: false, requiresPrepay: true, discountPercent: 0,
    birthDate: new Date('1990-01-01T00:00:00.000Z'),
  } as never);
  const res = await book('onsite');
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('PENDING');
  expect(prisma.booking.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'PENDING', expiresAt: null }) });
});
const book = (payChoice: string) => request(app).post('/clubs/demo/bookings').send({ courtId, payChoice,
  start: '2030-01-01T10:00:00Z', end: '2030-01-01T11:00:00Z', customerName: 'Player', customerPhone: '+380671112233', birthDate: '1990-01-01' });
it('holds a cash booking for administrator review even when online payments are unavailable', async () => {
  const res = await book('onsite');
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('PENDING');
  expect(providerFor).not.toHaveBeenCalled();
  expect(prisma.booking.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'PENDING', expiresAt: null, courtId }) });
  expect(notifyBooking).toHaveBeenCalled();
});
it('обрана онлайн-оплата при мовчазному еквайрингу не скасовує бронь', async () => {
  const res = await book('online');
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('PENDING');
  expect(prisma.booking.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'PENDING', expiresAt: null }) });
  expect(notifyBooking).toHaveBeenCalled();
});

/* Банк мовчить уже після того, як гравець натиснув «оплатити». Раніше
   бронь тут згорала в EXPIRED — людина лишалась без часу через чужий
   таймаут. Тепер заявка чекає адміністратора, як і будь-яка неоплачена. */
it('банк не виставив рахунок — бронь лишається заявкою, а не згорає', async () => {
  providerFor.mockReturnValue({
    name: 'mock',
    createInvoice: vi.fn(async () => { throw new Error('банк лежить'); }),
  } as never);
  const res = await book('online');
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('PENDING');
  expect(res.body.payUnavailable).toBe(true);
  expect(prisma.booking.update).toHaveBeenCalledWith({
    where: { id: 'booking' }, data: { expiresAt: null },
  });
  expect(notifyBooking).toHaveBeenCalled();
});
