import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const prisma = { club: { findFirst: vi.fn() } };
vi.mock('../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../lib/payments', () => ({ providerFor: () => null, publicBase: () => 'https://api.test' }));
const online = { value: true };
vi.mock('../lib/billing', () => ({ clubBilling: () => ({ online: online.value }) }));
const { publicRouter } = await import('./public');
const app = express().use(express.json()).use(publicRouter);

const club = {
  id: 'club', name: 'Клуб', slug: 'demo', timezone: 'UTC', slotMinutes: 60, horizonDays: 14,
  phone: '+380441112233', address: 'Київ, 1', legalName: 'ФОП Іваненко', legalCode: '1234567890',
  legalAddress: 'Київ, юр.', email: 'a@b.ua', lateCancelFeePercent: 30, refundDays: 5, extraRules: 'Взуття',
  hours: [], courts: [], trainers: [], promos: [], plan: null,
};

beforeEach(() => { vi.clearAllMocks(); online.value = true; prisma.club.findFirst.mockResolvedValue(club); });

it('публічний GET клубу віддає реквізити', async () => {
  const body = (await request(app).get('/clubs/demo')).body;
  expect(body).toMatchObject({
    legalName: 'ФОП Іваненко', legalCode: '1234567890', legalAddress: 'Київ, юр.', email: 'a@b.ua',
    phone: '+380441112233', address: 'Київ, 1', lateCancelFeePercent: 30, refundDays: 5, extraRules: 'Взуття',
  });
});

it('і в режимі offline', async () => {
  online.value = false;
  const body = (await request(app).get('/clubs/demo')).body;
  expect(body.online).toBe(false);
  expect(body).toMatchObject({ legalName: 'ФОП Іваненко', legalCode: '1234567890', email: 'a@b.ua' });
});
