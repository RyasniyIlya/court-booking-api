import { describe, expect, it, vi } from 'vitest';

/**
 * «Різні клієнти» й топ рахують учасників групових занять (BookingSeat)
 * нарівні з власниками броней, без дублів тієї самої людини.
 */

const findMany = { booking: vi.fn(), bookingSeat: vi.fn() };
vi.mock('../lib/db', () => ({
  prisma: {
    booking: { findMany: (a: unknown) => findMany.booking(a) },
    bookingSeat: { findMany: (a: unknown) => findMany.bookingSeat(a) },
    passUsage: { findMany: async () => [] },
  },
}));
vi.mock('./admin', () => ({
  requireAuth: vi.fn(),
  requireRole: () => vi.fn(),
  requireFeature: () => vi.fn(),
}));

const { periodStats, loadPeriodVisits, tallyVisits } = await import('./analytics');

const FROM = new Date('2026-08-01T00:00:00Z');
const TO = new Date('2026-08-31T23:59:59Z');

function mock() {
  // 10 власників броней + 4 учасники йоги; Ліза ще й сама бронювала корт (дубль).
  const owners = Array.from({ length: 10 }, (_, i) => ({ customerId: `own${i}`, priceTotal: 10_000 }));
  findMany.booking.mockReset().mockResolvedValue([...owners, { customerId: 'liza', priceTotal: 8_000 }]);
  findMany.bookingSeat.mockReset().mockResolvedValue(
    ['darina', 'kostia', 'liza', 'taras'].map((customerId) => ({ customerId, price: 3_000 })),
  );
}

describe('учасники місць у звітах періоду', () => {
  it('uniqueCustomers включає учасників місць і не дублює людину з двох джерел', async () => {
    mock();
    const stats = await periodStats('club', FROM, TO);
    // 10 + liza (бронь) + darina, kostia, taras = 14; liza з місця не додається вдруге
    expect(stats.uniqueCustomers).toBe(14);
  });

  it('топ: візити й гроші складаються з двох джерел', async () => {
    mock();
    const byCustomer = tallyVisits(await loadPeriodVisits('club', FROM, TO));
    expect(byCustomer.get('liza')).toEqual({ visits: 2, spend: 11_000 });
    expect(byCustomer.get('taras')).toEqual({ visits: 1, spend: 3_000 });
    expect(byCustomer.size).toBe(14);
  });

  it('місця беруться лише BOOKED у підтвердженій броні свого клубу', async () => {
    mock();
    await loadPeriodVisits('club-1', FROM, TO);
    const where = findMany.bookingSeat.mock.calls[0][0].where;
    expect(where.status).toBe('BOOKED');
    expect(where.booking).toMatchObject({ clubId: 'club-1', status: 'CONFIRMED' });
  });
});
