import { describe, expect, it, vi } from 'vitest';

/**
 * Одне означення «під ризиком» (FADING) у картотеці, Deep і AI.
 *
 * Тест будує ОДНІ дані й проганяє їх через три місця: `loadRoster`
 * (фільтр картотеки за `tier`), `retentionFromVisits` (Deep) і
 * `buildCustomerHealth` (AI). Число має збігатися — інакше власник знову
 * побачить три різні «відтоки».
 */

const findMany = { customer: vi.fn(), booking: vi.fn(), bookingSeat: vi.fn() };
vi.mock('./db', () => ({
  prisma: {
    customer: { findMany: (a: unknown) => findMany.customer(a) },
    booking: { findMany: (a: unknown) => findMany.booking(a) },
    bookingSeat: { findMany: (a: unknown) => findMany.bookingSeat(a) },
  },
}));

const { loadRoster, tierCounts } = await import('./customerRoster');
const { retentionFromVisits } = await import('./deepAnalytics');
const { buildCustomerHealth } = await import('./ai/customerHealth');

const NOW = new Date('2026-09-23T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const CLUB = '11111111-1111-1111-1111-111111111111';

const person = (id: string, name: string) => ({
  id, name, phone: `+38067${id.length}`, email: null, note: null, tags: [],
  isBlocked: false, requiresPrepay: false, createdAt: daysAgo(400), telegramChatId: null,
  birthDate: null, discountPercent: 0, bonusBalance: 0, skillLevel: null,
});

/* Брони: [клієнт, скільки днів тому]. Місця групи — окремо. */
const people = ['jul', 'f45', 'f85', 'f89', 'f95', 'act', 'seat', 'none'];
const bookingVisits: [string, number][] = [
  ['jul', 75], // «Дмитро Липневий»: єдиний візит 75 днів тому
  ['f45', 45], ['f85', 85], ['f89', 89], ['f95', 95],
  ['act', 5], ['act', 6], ['act', 7], ['act', 8], ['act', 9], ['act', 10], ['act', 50],
];
const seatVisits: [string, number][] = [['seat', 60], ['f45', 100]];

async function setup() {
  findMany.customer.mockReset().mockResolvedValue(
    people.map((id) => person(id, id === 'jul' ? 'Дмитро Липневий' : id)),
  );
  findMany.booking.mockReset().mockResolvedValue(
    bookingVisits.map(([customerId, d]) => ({ customerId, priceTotal: 10_000, startTime: daysAgo(d) })),
  );
  findMany.bookingSeat.mockReset().mockResolvedValue(
    seatVisits.map(([customerId, d]) => ({ customerId, price: 5_000, booking: { startTime: daysAgo(d) } })),
  );
  const rows = await loadRoster(CLUB, {}, NOW);

  const allVisits = [
    ...bookingVisits.map(([customerId, d]) => ({ customerId, at: daysAgo(d), price: 10_000 })),
    ...seatVisits.map(([customerId, d]) => ({ customerId, at: daysAgo(d), price: 5_000 })),
  ];
  return { rows, allVisits };
}

describe('одне означення «під ризиком»', () => {
  it('картотека, Deep і AI дають однакову кількість і однакових людей', async () => {
    const { rows, allVisits } = await setup();

    const rosterFading = rows.filter((r) => r.tier === 'FADING').map((r) => r.id).sort();
    const deep = retentionFromVisits(allVisits.map(({ customerId, at }) => ({ customerId, at })), NOW, 30);
    const health = buildCustomerHealth(
      { customers: people.map((id) => ({ id, createdAt: daysAgo(400) })), allVisits }, NOW,
    );

    // f45 (останній візит 45), f85, f89, jul(75), seat(60) = 5; f95 уже LOST.
    expect(rosterFading).toEqual(['f45', 'f85', 'f89', 'jul', 'seat']);
    expect([...deep.atRiskIds].sort()).toEqual(rosterFading);
    expect(health.atRisk).toBe(rosterFading.length);
    expect(health.atRisk).toBe(health.segments.FADING);
    expect(tierCounts(rows).FADING).toBe(health.segments.FADING);
  });

  it('Дмитро Липневий (єдиний візит 75 днів тому) — FADING у всіх трьох місцях', async () => {
    const { rows, allVisits } = await setup();
    const visits = allVisits.filter((v) => v.customerId === 'jul');

    expect(rows.find((r) => r.name === 'Дмитро Липневий')!.tier).toBe('FADING');
    expect(retentionFromVisits(visits.map(({ customerId, at }) => ({ customerId, at })), NOW, 30).atRiskIds)
      .toEqual(['jul']);
    expect(buildCustomerHealth({ customers: [{ id: 'jul', createdAt: daysAgo(400) }], allVisits: visits }, NOW).atRisk)
      .toBe(1);
  });

  it('межі: 30 днів ще активний, понад 90 уже втрачений', () => {
    const at = (n: number) => retentionFromVisits([{ customerId: 'x', at: daysAgo(n) }], NOW, 30).atRiskIds;
    expect(at(30)).toEqual([]);
    expect(at(31)).toEqual(['x']);
    expect(at(90)).toEqual(['x']);
    expect(at(91)).toEqual([]);
  });
});
