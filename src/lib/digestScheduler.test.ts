import { beforeEach, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), send: vi.fn() }));
vi.mock('./db', () => ({ prisma: { user: { findMany: mocks.findMany } } }));
vi.mock('./telegram', () => ({ sendMessage: mocks.send }));
vi.mock('./digest', () => ({
  dayDigest: vi.fn(async () => ({})), digestText: vi.fn(() => 'digest'),
  weekReport: vi.fn(async () => ({})), weekText: vi.fn(() => 'week'),
}));
vi.mock('./plans', () => ({ planFeatures: () => ({ telegram: true }) }));

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
