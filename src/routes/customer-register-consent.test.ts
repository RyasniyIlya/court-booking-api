import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/** Ю-4: реєстрація гравця вимагає галочку Правил і Політики. */

const prisma = {
  club: { findFirst: vi.fn() },
  customer: { findUnique: vi.fn(), create: vi.fn() },
};
vi.mock('../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../lib/billing', () => ({ clubBilling: () => ({ online: true }) }));
vi.mock('../lib/payments', () => ({ providerFor: () => null, publicBase: () => 'https://example.test' }));
vi.mock('../lib/customerAuth', () => ({ signCustomerToken: () => 'token-1', verifyCustomerToken: () => null }));
vi.mock('../lib/customerPassword', async (orig) => ({
  ...(await orig<typeof import('../lib/customerPassword')>()),
  hashCustomerPassword: vi.fn(async () => 'hash-1'),
}));

const { publicRouter } = await import('./public');
const app = express().use(express.json()).use('/api/public', publicRouter);
const register = (body: Record<string, unknown>) =>
  request(app).post('/api/public/clubs/squash/customer/register').send(body);

const valid = { phone: '067 111 22 33', name: 'Ілля Рясний', birthDate: '1990-03-15', password: 'padel-2026' };
const card = { id: 'c1', name: 'Ілля Рясний', phone: '+380671112233', email: null, birthDate: new Date('1990-03-15T00:00:00.000Z') };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.club.findFirst.mockResolvedValue({ id: 'club-1', slug: 'squash' });
  prisma.customer.findUnique.mockResolvedValue(null);
  prisma.customer.create.mockResolvedValue(card);
});

describe('POST /clubs/:slug/customer/register: згоди', () => {
  it('без acceptedTerms: 400 TERMS_REQUIRED і картка не створюється', async () => {
    for (const extra of [{}, { acceptedTerms: false }, { acceptedTerms: 'true' }]) {
      const res = await register({ ...valid, ...extra });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('TERMS_REQUIRED');
    }
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });

  it('зберігає дату й версію умов; без marketingConsent маркетингової дати нема', async () => {
    const res = await register({ ...valid, acceptedTerms: true });
    expect(res.status).toBe(201);
    const data = prisma.customer.create.mock.calls[0][0].data;
    expect(data.termsAcceptedAt).toBeInstanceOf(Date);
    expect(data.termsVersion).toBe('2026-09');
    expect(data.marketingConsentAt).toBeNull();
  });

  it('marketingConsent=true зберігає й маркетингову дату', async () => {
    await register({ ...valid, acceptedTerms: true, marketingConsent: true });
    expect(prisma.customer.create.mock.calls[0][0].data.marketingConsentAt).toBeInstanceOf(Date);
  });
});
