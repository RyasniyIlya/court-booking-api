import { beforeEach, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
const prisma = { club: { findUnique: vi.fn() }, court: { findMany: vi.fn() }, booking: { findMany: vi.fn() }, block: { findMany: vi.fn() }, passUsage: { findMany: vi.fn(async () => []) } };
vi.mock('./db', () => ({ prisma }));
const { analyticsRange, analyticsMessages, botAnalytics } = await import('./botAnalytics');
const now = DateTime.fromISO('2026-09-07T12:00:00', { zone: 'Europe/Kyiv' });
beforeEach(() => vi.clearAllMocks());
it('uses club-local calendar days and rejects invalid/future dates', () => {
  expect(analyticsRange('yesterday', 'Europe/Kyiv', now)?.from.toISOString()).toBe('2026-09-05T21:00:00.000Z');
  expect(analyticsRange('week', 'Europe/Kyiv', now)?.to.getTime()).toBe(now.toMillis());
  for (const key of ['2026-02-30', '2026-09-08', 'all', 'today extra']) expect(analyticsRange(key, 'Europe/Kyiv', now)).toBeNull();
});
it('escapes names and paginates without losing courts or totals', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ name: `<Корт ${i}>`, confirmed: 1, pending: 0, cancelled: 0, expired: 0, amount: 10500,
    paid: 1, paymentPending: 0, refunded: 0, bookedHours: 1, freeHours: 2, occupancy: 33.3 }));
  const pages = analyticsMessages('<Club>', 'range', 'Europe/Kyiv', rows, 'now');
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.every(p => p.length < 4096)).toBe(true);
  expect(pages.join('')).toContain('&lt;Корт 39&gt;');
  expect(pages.join('')).not.toContain('<Club>');
  expect(pages.join('')).toContain('40 броней');
});
it('denies plans without analytics before reading bookings', async () => {
  prisma.club.findUnique.mockResolvedValue({ isActive: true, plan: { featAnalytics: false } });
  expect((await botAnalytics('club', 'today'))[0]).toContain('недоступна');
  expect(prisma.booking.findMany).not.toHaveBeenCalled();
});
it('does not grant a deleted club access via the legacy no-plan fallback', async () => {
  prisma.club.findUnique.mockResolvedValue(null);
  expect((await botAnalytics('missing', 'today'))[0]).toContain('недоступна');
});
it('scopes all reads to the club and does not double-count group payments as revenue', async () => {
  prisma.club.findUnique.mockResolvedValue({ isActive: true, name: 'Club', timezone: 'Europe/Kyiv', plan: { tier: 3, featAnalytics: true }, createdAt: new Date('2020-01-01'), hours: [] });
  prisma.court.findMany.mockResolvedValue([{ id: 'court', name: 'Court', isActive: true }]);
  prisma.block.findMany.mockResolvedValue([]);
  prisma.booking.findMany.mockResolvedValue([{ courtId: 'court', startTime: new Date('2026-09-01T09:00:00Z'), endTime: new Date('2026-09-01T10:00:00Z'), status: 'CONFIRMED', priceTotal: 10500, payment: null, seats: [{ payment: { status: 'PAID' } }] }]);
  const report = (await botAnalytics('club', '2026-09-01')).join('');
  expect(report).toContain('105 грн');
  expect(report).toContain('оплачено <b>1</b>');
  for (const model of [prisma.court, prisma.booking, prisma.block]) expect(model.findMany.mock.calls[0][0].where.clubId).toBe('club');
});
