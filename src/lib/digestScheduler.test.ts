import { beforeEach, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), send: vi.fn() }));
vi.mock('./db', () => ({ prisma: { user: { findMany: mocks.findMany } } }));
vi.mock('./telegram', () => ({ sendMessage: mocks.send }));
vi.mock('./digest', () => ({
  dayDigest: vi.fn(async () => ({})), digestText: vi.fn(() => 'digest'),
  weekReport: vi.fn(async () => ({})), weekText: vi.fn(() => 'week'),
}));
vi.mock('./plans', () => ({
  planFeatures: () => ({ telegram: true }),
  telegramAnalytics: (plan: { featAnalytics?: boolean } | null) => Boolean(plan?.featAnalytics),
}));

const { runDigestTick, stopDigestScheduler } = await import('./digestScheduler');

beforeEach(() => {
  vi.clearAllMocks();
  stopDigestScheduler();
  mocks.findMany.mockResolvedValue([]);
});

it('зведення з виручкою йде лише OWNER: ADMIN не в списку отримувачів', async () => {
  await runDigestTick(DateTime.fromISO('2026-09-29T21:05:00', { zone: 'Europe/Kyiv' }));
  expect(mocks.findMany.mock.calls[0][0].where.role).toBe('OWNER');
});

it('щоденне зведення — лише тариф «Аналітика»: клуб на «Бронях» і без плану мовчить', async () => {
  const club = (id: string, plan: unknown) => ({ id, name: id, timezone: 'Europe/Kyiv', plan });
  mocks.findMany.mockResolvedValue([
    { id: 'o1', tgChatId: '1001', club: club('c1', { tier: 1, featAnalytics: false }) },
    { id: 'o2', tgChatId: '1002', club: club('c2', null) },
    { id: 'o3', tgChatId: '1003', club: club('c3', { tier: 3, featAnalytics: true }) },
  ]);

  const delivered = await runDigestTick(DateTime.fromISO('2026-09-29T21:05:00', { zone: 'Europe/Kyiv' }));

  expect(delivered).toBe(1);
  expect(mocks.send).toHaveBeenCalledTimes(1); // вівторок: лише зведення дня
  expect(mocks.send.mock.calls[0][0]).toBe('1003');
});
