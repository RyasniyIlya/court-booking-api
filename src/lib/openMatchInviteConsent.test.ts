import { beforeEach, expect, it, vi } from 'vitest';

/** Р-6: запрошення у відкриті ігри йдуть лише тим, хто дав marketingConsentAt. */

const prisma = {
  customer: { findMany: vi.fn() },
  booking: { findMany: vi.fn(async () => []) },
  bookingSeat: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
};
vi.mock('./db', () => ({ prisma }));
vi.mock('./telegram', () => ({ sendMessage: vi.fn(), botReady: () => true }));

const { candidatesOf } = await import('./openMatchInvite');

beforeEach(() => {
  vi.clearAllMocks();
  prisma.customer.findMany.mockResolvedValue([]);
});

it('onlyConsented додає фільтр marketingConsentAt', async () => {
  await candidatesOf('club', 'UTC', new Date(), true, true);
  expect(prisma.customer.findMany.mock.calls[0][0].where).toMatchObject({
    clubId: 'club', telegramChatId: { not: null }, marketingConsentAt: { not: null },
  });
});

it('за замовчуванням фільтра нема (інші потоки не змінились)', async () => {
  await candidatesOf('club', 'UTC', new Date());
  expect(prisma.customer.findMany.mock.calls[0][0].where).not.toHaveProperty('marketingConsentAt');
});
