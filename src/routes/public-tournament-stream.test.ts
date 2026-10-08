import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const prisma = { booking: { findUnique: vi.fn() } };
vi.mock('../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../lib/payments', () => ({ providerFor: () => null, publicBase: () => 'https://api.test' }));
const { publicRouter } = await import('./public');
const { notifyTournament, subscribe, subscriberCount, DEBOUNCE_MS } = await import('../lib/tournamentLive');

const ID = '22222222-2222-4222-8222-222222222222';
const row = (title = '🏆 Кубок') => ({
  id: ID, title, capacity: 8, status: 'CONFIRMED', startTime: new Date('2030-01-01T08:00:00Z'),
  tournamentStatus: 'RUNNING', thirdPlace: false, court: { name: 'Корт 1' }, club: { name: 'Клуб', brandColor: '#123456' },
  tournamentEntries: [], tournamentMatches: [],
});
let server: http.Server;
const url = (p: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${p}`;

beforeEach(async () => {
  vi.clearAllMocks();
  prisma.booking.findUnique.mockResolvedValue(row());
  server = express().use(publicRouter).listen(0);
  await new Promise((r) => server.once('listening', r));
});
afterEach(() => { server.closeAllConnections(); server.close(); });

it('pub/sub: одна збірка DTO на пачку подій і всі глядачі отримують той самий json', async () => {
  const a = vi.fn(), b = vi.fn();
  const ua = subscribe(ID, a), ub = subscribe(ID, b);
  notifyTournament(ID); notifyTournament(ID); notifyTournament(ID);
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
  expect(prisma.booking.findUnique).toHaveBeenCalledTimes(1);
  expect(a).toHaveBeenCalledTimes(1);
  expect(a.mock.calls[0][0]).toBe(b.mock.calls[0][0]);
  expect(JSON.parse(a.mock.calls[0][0]).status).toBe('RUNNING');
  ua(); ub();
  expect(subscriberCount(ID)).toBe(0);
});

it('notify не кидає, коли база падає, і без глядачів не ходить у базу', async () => {
  prisma.booking.findUnique.mockRejectedValue(new Error('db down'));
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const un = subscribe(ID, vi.fn());
  expect(() => notifyTournament(ID)).not.toThrow();
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
  expect(err).toHaveBeenCalled();
  un(); err.mockRestore();
  prisma.booking.findUnique.mockClear();
  notifyTournament(ID);
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50));
  expect(prisma.booking.findUnique).not.toHaveBeenCalled();
});

it('stream: поганий uuid або не турнір — 404', async () => {
  const get = (p: string) => new Promise<number>((r) => http.get(url(p), (res) => { res.resume(); r(res.statusCode!); }));
  expect(await get('/tournaments/nope/stream')).toBe(404);
  prisma.booking.findUnique.mockResolvedValue(row('Йога'));
  expect(await get(`/tournaments/${ID}/stream`)).toBe(404);
});

it('stream: заголовки SSE, retry і початковий snapshot, потім пуш; close прибирає підписку', async () => {
  const res = await new Promise<http.IncomingMessage>((r) => http.get(url(`/tournaments/${ID}/stream`), r));
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
  expect(res.headers['cache-control']).toBe('no-store, no-transform');
  expect(res.headers['x-accel-buffering']).toBe('no');
  let buf = '';
  res.setEncoding('utf8').on('data', (c) => { buf += c; });
  await vi.waitFor(() => expect(buf).toContain('event: snapshot'));
  expect(buf).toContain('retry: 2000');
  expect(buf).toContain('id: 1\n');
  expect(JSON.parse(buf.split('data: ')[1].split('\n')[0])).toMatchObject({ id: ID, status: 'RUNNING' });
  expect(subscriberCount(ID)).toBe(1);
  notifyTournament(ID);
  await vi.waitFor(() => expect(buf).toContain('id: 2\n'));
  res.destroy();
  await vi.waitFor(() => expect(subscriberCount(ID)).toBe(0));
});
