import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { LEGAL_VERSION } from '../lib/legal';

/** Ю-3: галочки під «Забронювати» пишуть згоду в картку; без них бронь працює. */

const prisma = { club: { findFirst: vi.fn() }, block: { findFirst: vi.fn() }, customer: { findUnique: vi.fn(), update: vi.fn() },
  booking: { create: vi.fn() }, payment: { create: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)) };
const card = (over: Record<string, unknown> = {}) => ({
  id: 'customer', isBlocked: false, requiresPrepay: false, discountPercent: 0,
  birthDate: new Date('1990-01-01T00:00:00.000Z'), termsAcceptedAt: null, termsVersion: null, marketingConsentAt: null, ...over,
});
const findOrCreateCustomer = vi.fn(async (..._a: unknown[]) => card());
vi.mock('../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../lib/payments', () => ({ providerFor: () => null, publicBase: () => 'https://api.test' }));
vi.mock('../lib/notifyBooking', () => ({ notifyBooking: vi.fn() }));
vi.mock('../lib/billing', () => ({ clubBilling: () => ({ online: true }) }));
vi.mock('../lib/customers', async (orig) => ({
  ...(await orig<typeof import('../lib/customers')>()),
  findOrCreateCustomer,
}));
const { publicRouter } = await import('./public');
const app = express().use(express.json()).use(publicRouter);

const courtId = '11111111-1111-4111-8111-111111111111';
const club = { id: 'club', slug: 'demo', timezone: 'UTC', leadTimeMinutes: 0, slotMinutes: 60,
  prepayEnabled: false, prepayRequired: true, autoConfirm: true, promos: [], trainers: [],
  courts: [{ id: courtId, pricePerHour: 50000 }],
  hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, openMinute: 0, closeMinute: 1440, isClosed: false })) };

const book = (extra: Record<string, unknown> = {}) => request(app).post('/clubs/demo/bookings').send({
  courtId, payChoice: 'onsite',
  start: '2030-01-01T10:00:00Z', end: '2030-01-01T11:00:00Z',
  customerName: 'Player', customerPhone: '+380671112233', birthDate: '1990-01-01', ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.club.findFirst.mockResolvedValue(club);
  prisma.block.findFirst.mockResolvedValue(null);
  prisma.customer.findUnique.mockResolvedValue(null);
  prisma.booking.create.mockImplementation(async ({ data }) => ({ ...data, id: 'booking', cancelToken: 'cancel' }));
  prisma.payment.create.mockResolvedValue({});
  findOrCreateCustomer.mockResolvedValue(card());
});

it('acceptedTerms=true: у картці дата й поточна версія', async () => {
  const res = await book({ acceptedTerms: true });
  expect(res.status).toBe(201);
  const data = prisma.customer.update.mock.calls[0][0].data;
  expect(prisma.customer.update.mock.calls[0][0].where).toEqual({ id: 'customer' });
  expect(data.termsAcceptedAt).toBeInstanceOf(Date);
  expect(data.termsVersion).toBe(LEGAL_VERSION);
  expect(data.marketingConsentAt).toBeUndefined();
});

it('застаріла версія оновлюється, актуальна — ні', async () => {
  findOrCreateCustomer.mockResolvedValue(card({ termsAcceptedAt: new Date('2026-01-01'), termsVersion: '2026-01' }));
  await book({ acceptedTerms: true });
  expect(prisma.customer.update.mock.calls[0][0].data.termsVersion).toBe(LEGAL_VERSION);

  prisma.customer.update.mockClear();
  findOrCreateCustomer.mockResolvedValue(card({ termsAcceptedAt: new Date('2026-09-05'), termsVersion: LEGAL_VERSION }));
  await book({ acceptedTerms: true });
  expect(prisma.customer.update).not.toHaveBeenCalled();
});

it('marketingConsent=true ставить дату лише коли порожньо', async () => {
  await book({ marketingConsent: true });
  const data = prisma.customer.update.mock.calls[0][0].data;
  expect(data.marketingConsentAt).toBeInstanceOf(Date);
  expect(data.termsAcceptedAt).toBeUndefined();

  prisma.customer.update.mockClear();
  findOrCreateCustomer.mockResolvedValue(card({ marketingConsentAt: new Date('2026-09-01') }));
  await book({ marketingConsent: true });
  expect(prisma.customer.update).not.toHaveBeenCalled();
});

it('без галочок бронь створюється, картка не чіпається', async () => {
  const res = await book();
  expect(res.status).toBe(201);
  expect(prisma.customer.update).not.toHaveBeenCalled();
  const res2 = await book({ acceptedTerms: false, marketingConsent: false });
  expect(res2.status).toBe(201);
  expect(prisma.customer.update).not.toHaveBeenCalled();
});
