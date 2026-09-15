import { beforeEach, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
const prisma = { booking: { findFirst: vi.fn() }, bookingSeat: { findFirst: vi.fn() } };
vi.mock('../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../lib/customerAuth', () => ({ signCustomerToken: vi.fn(), verifyCustomerToken: () => ({ customerId: 'customer', clubId: 'club' }) }));
const { publicRouter } = await import('./public');
const app = express().use(express.json()).use(publicRouter);
const id = '11111111-1111-4111-8111-111111111111';
const path = `/customer/records/seat/${id}/payment`;
let item: any;
beforeEach(() => {
  vi.clearAllMocks();
  item = { status: 'PENDING', expiresAt: new Date('2099-01-01'), payment: { status: 'PENDING', pageUrl: 'https://bank.example.test/invoice' } };
  prisma.bookingSeat.findFirst.mockImplementation(async () => item);
  prisma.booking.findFirst.mockImplementation(async () => item);
});
it('requires a customer session', async () => {
  expect((await request(app).get(path)).status).toBe(401); expect(prisma.bookingSeat.findFirst).not.toHaveBeenCalled();
});
it('limits payment lookup to the authenticated owner and club', async () => {
  const response = await request(app).get(path).set('Authorization', 'Bearer customer');
  expect(response.status).toBe(200); expect(response.body.url).toBe(item.payment.pageUrl);
  expect(prisma.bookingSeat.findFirst.mock.calls[0][0].where).toMatchObject({ id, customerId: 'customer', booking: { clubId: 'club' } });
  expect(response.headers['cache-control']).toBe('no-store');
});
it.each(['EXPIRED', 'CANCELLED', 'BOOKED'])('does not reopen %s seats', async status => {
  item.status = status; expect((await request(app).get(path).set('Authorization', 'Bearer customer')).status).toBe(409);
});
it('does not reopen an expired hold even before the sweeper runs', async () => {
  item.expiresAt = new Date(0); expect((await request(app).get(path).set('Authorization', 'Bearer customer')).status).toBe(409);
});
it('does not pay an already paid invoice again', async () => {
  item.payment.status = 'PAID'; expect((await request(app).get(path).set('Authorization', 'Bearer customer')).status).toBe(409);
});
it('hides missing or foreign records', async () => {
  item = null; expect((await request(app).get(path).set('Authorization', 'Bearer customer')).status).toBe(404);
});
it('validates kind and UUID before querying', async () => {
  expect((await request(app).get('/customer/records/unknown/invalid/payment').set('Authorization', 'Bearer customer')).status).toBe(400);
  expect(prisma.booking.findFirst).not.toHaveBeenCalled();
});
