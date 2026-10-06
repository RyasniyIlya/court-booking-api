import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const prisma = { booking: { findUnique: vi.fn() } };
vi.mock('../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../lib/payments', () => ({ providerFor: () => null, publicBase: () => 'https://api.test' }));
const { publicRouter } = await import('./public');
const app = express().use(express.json()).use(publicRouter);

const ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.booking.findUnique.mockResolvedValue({
    id: ID, title: '🏆 Кубок', capacity: 8, status: 'CONFIRMED', startTime: new Date('2030-01-01T08:00:00Z'),
    tournamentStatus: 'RUNNING', thirdPlace: false,
    court: { name: 'Корт 1' }, club: { name: 'Клуб', brandColor: '#123456' },
    tournamentEntries: [{ id: 'e1', name: 'Іван', seed: 1 }, { id: 'e2', name: 'Олег', seed: 2 }],
    tournamentMatches: [{
      round: 1, slot: 0, entryAId: 'e1', entryBId: 'e2', winnerEntryId: 'e2',
      sets: [{ a: 3, b: 6 }], status: 'DONE', scheduledAt: null, court: { name: 'Корт 2' },
    }],
  });
});

it('віддає сітку з іменами й стороною переможця, без телефонів', async () => {
  const r = await request(app).get(`/tournaments/${ID}`);
  expect(r.status).toBe(200);
  expect(r.headers['cache-control']).toBe('public, max-age=5, s-maxage=5, must-revalidate');
  expect(r.body).toMatchObject({ status: 'RUNNING', court: { name: 'Корт 1' }, club: { brandColor: '#123456' } });
  expect(r.body.entries).toEqual([{ name: 'Іван', seed: 1 }, { name: 'Олег', seed: 2 }]);
  expect(r.body.matches[0]).toMatchObject({ a: 'Іван', b: 'Олег', winner: 'B', court: 'Корт 2', status: 'DONE' });
  expect(JSON.stringify(r.body)).not.toMatch(/phone|customerPhone|\+380/i);
  /* select у запиті не просить жодних телефонних полів. */
  expect(JSON.stringify(prisma.booking.findUnique.mock.calls[0][0])).not.toMatch(/Phone/);
});

it('не турнір або скасований — 404', async () => {
  prisma.booking.findUnique.mockResolvedValue({ id: ID, title: 'Йога', capacity: 8, status: 'CONFIRMED' });
  expect((await request(app).get(`/tournaments/${ID}`)).status).toBe(404);
});
