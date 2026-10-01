import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Журнал каси за період: фільтри, зведення по всіх операціях (не по сторінці),
 * CSV і хто його не бачить.
 */

const at = (iso: string) => new Date(iso);
const row = (patch: object = {}) => ({
  id: 'e1', kind: 'PAYMENT', method: 'CASH', amount: 50000, account: 'Каса 1', note: '',
  actorEmail: 'olya@club.ua', actorRole: 'ADMIN', createdAt: at('2026-09-14T15:30:00Z'),
  bookingId: 'b1', seatId: null,
  booking: { customerName: 'Петренко', title: null, startTime: at('2026-09-14T15:00:00Z'), court: { name: 'Корт 2' } },
  seat: null, customer: { name: 'Петренко', phone: '+380500000000' }, original: null,
  ...patch,
});
const rows = [
  row({ id: 'e3', createdAt: at('2026-09-15T21:30:00Z') }), // 16 вересня 00:30 за Києвом
  row({ id: 'e2', kind: 'REFUND', amount: 10000, createdAt: at('2026-09-14T16:00:00Z'), original: { id: 'e1', createdAt: at('2026-09-14T15:30:00Z') } }),
  row({ id: 'e1', method: 'CARD', amount: 30000, account: 'Термінал', actorEmail: 'ira@club.ua', actorRole: 'OWNER', note: 'Комент; з "лапками"' }),
];

const prisma = {
  club: { findUniqueOrThrow: vi.fn(async () => ({ name: 'Падел Хаб', timezone: 'Europe/Kyiv' })) },
  user: { findFirst: vi.fn(async () => ({ email: 'olya@club.ua' })) },
  changeLog: { createMany: vi.fn(async () => ({})) },
  bookingLedgerEntry: {
    findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => rows),
    groupBy: vi.fn(async (_args?: unknown) => [
      { method: 'CASH', kind: 'PAYMENT', account: 'Каса 1', actorEmail: 'olya@club.ua' },
      { method: 'CASH', kind: 'REFUND', account: 'Каса 1', actorEmail: 'olya@club.ua' },
      { method: 'CARD', kind: 'PAYMENT', account: 'Термінал', actorEmail: 'ira@club.ua' },
    ]),
  },
};
const auth = { role: 'ADMIN' };

vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: 'u1', clubId: 'club-1', role: auth.role, trainerId: null };
    next();
  },
  requireStaff: (req: { auth: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    ['TRAINER', 'ACCOUNTANT'].includes(req.auth.role) ? res.status(403).json({ error: 'FORBIDDEN' }) : next(),
}));

const { ledgerRouter } = await import('./ledger');
const app = express().use(express.json()).use('/api/admin', ledgerRouter);
const get = (qs: string) => request(app).get(`/api/admin/ledger?${qs}`);
const PERIOD = 'from=2026-09-14&to=2026-09-16';

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = 'ADMIN';
  prisma.bookingLedgerEntry.findMany.mockResolvedValue(rows);
});

describe('GET /ledger', () => {
  it('віддає сторінку, зведення й варіанти фільтрів', async () => {
    const res = await get(PERIOD);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.nextCursor).toBeNull();
    /* Готівка: 500 оплата мінус 100 повернення; картка 300. */
    expect(res.body.totals).toEqual({ cash: 40000, card: 30000, transfer: 0, bonus: 0 });
    expect(res.body.byMethod).toEqual(expect.arrayContaining([
      { method: 'CASH', in: 50000, out: 10000, net: 40000, count: 2 },
      { method: 'CARD', in: 30000, out: 0, net: 30000, count: 1 },
    ]));
    expect(res.body.byActor).toEqual(expect.arrayContaining([
      { actorEmail: 'olya@club.ua', actorRole: 'ADMIN', count: 2, net: 40000 },
    ]));
    expect(res.body.facets.methods).toEqual(['CARD', 'CASH']);
    expect(res.body.facets.kinds).toEqual(['PAYMENT', 'REFUND']);
    expect(res.body.facets.accounts.sort()).toEqual(['Каса 1', 'Термінал'].sort());
    expect(res.body.facets.actors).toEqual(['ira@club.ua', 'olya@club.ua']);
  });

  it('по днях — кожен день діапазону, а операція о 00:30 за Києвом — в наступному дні', async () => {
    const { byDay } = (await get(PERIOD)).body;
    expect(byDay.map((d: { date: string }) => d.date)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
    expect(byDay[0]).toMatchObject({ cash: -10000, card: 30000, net: 20000 });
    expect(byDay[1]).toMatchObject({ cash: 0, net: 0 });
    expect(byDay[2]).toMatchObject({ cash: 50000, net: 50000 });
  });

  it('межі періоду — за таймзоною клубу, «to» включно', async () => {
    await get(PERIOD);
    const where = prisma.bookingLedgerEntry.findMany.mock.calls[0][0] as { where: { clubId: string; createdAt: { gte: Date; lt: Date } } };
    expect(where.where.clubId).toBe('club-1');
    expect(where.where.createdAt.gte.toISOString()).toBe('2026-09-13T21:00:00.000Z');
    expect(where.where.createdAt.lt.toISOString()).toBe('2026-09-16T21:00:00.000Z');
  });

  it('фільтри й пошук лягають у where, а варіанти фільтрів беруться без них', async () => {
    await get(`${PERIOD}&method=CASH&kind=REFUND&account=${encodeURIComponent('Каса 1')}&actor=olya@club.ua&q=${encodeURIComponent('Петр')}`);
    const w = (prisma.bookingLedgerEntry.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(w).toMatchObject({ method: 'CASH', kind: 'REFUND', account: 'Каса 1', actorEmail: 'olya@club.ua' });
    expect(JSON.stringify(w.OR)).toContain('"mode":"insensitive"');
    expect((w.OR as unknown[]).length).toBe(5);
    const facetWhere = (prisma.bookingLedgerEntry.groupBy.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(facetWhere.method).toBeUndefined();
    expect(facetWhere.OR).toBeUndefined();
  });

  it('сторінка limit+1 → nextCursor, а зведення рахується окремим читанням усіх', async () => {
    const res = await get(`${PERIOD}&limit=2`);
    const calls = prisma.bookingLedgerEntry.findMany.mock.calls as unknown as [{ take?: number }][];
    expect(calls[0][0].take).toBe(3);
    expect(calls[1][0].take).toBeUndefined();
    expect(res.body.items).toHaveLength(2);
    expect(res.body.nextCursor).toBe('e2');
    expect(res.body.totals.cash).toBe(40000);
  });

  it('курсор іде в cursor+skip', async () => {
    const cursor = '55555555-5555-4555-8555-555555555555';
    await get(`${PERIOD}&cursor=${cursor}`);
    expect(prisma.bookingLedgerEntry.findMany.mock.calls[0][0]).toMatchObject({ cursor: { id: cursor }, skip: 1 });
  });

  it('період обовʼязковий, не довший за 366 днів, без сміття', async () => {
    for (const qs of ['', 'from=2026-09-14', 'from=2026-09-16&to=2026-09-14', 'from=2025-01-01&to=2026-09-14', 'from=x&to=y', `${PERIOD}&cursor=bad`]) {
      expect((await get(qs)).status, qs).toBe(400);
    }
    expect((await get('from=2026-01-01&to=2026-12-31')).status).toBe(200);
  });

  it('тренерові й бухгалтеру — 403', async () => {
    for (const role of ['TRAINER', 'ACCOUNTANT']) {
      auth.role = role;
      expect((await get(PERIOD)).status).toBe(403);
    }
    expect(prisma.bookingLedgerEntry.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /ledger?format=csv', () => {
  it('віддає CSV з BOM, `;`, заголовком і знаком повернення', async () => {
    const res = await get(`${PERIOD}&format=csv`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="ledger\.csv"; filename\*=UTF-8''/);
    const buf = res.body as Buffer;
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = buf.toString('utf8').slice(1).split('\r\n');
    expect(lines[0]).toBe('Дата;Час;Тип;Спосіб;Рахунок;Сума грн;Клієнт;Бронь/корт;Нотатка;Хто провів;Роль');
    expect(lines).toHaveLength(4);
    /* Київ UTC+3: 21:30Z = 00:30 наступної доби. Повернення — мінус, кома в сумі. */
    expect(lines[1]).toBe('16.09.2026;00:30;Оплата;Готівка;Каса 1;"500,00";Петренко;Корт 2 · 14.09 18:00;;olya@club.ua;Модератор');
    expect(lines[2]).toContain('Повернення;Готівка;Каса 1;"-100,00"');
    expect(lines[3]).toContain('"Комент; з ""лапками"""');
    expect(prisma.changeLog.createMany).toHaveBeenCalled();
  });

  it('тренерові CSV закрито', async () => {
    auth.role = 'TRAINER';
    expect((await get(`${PERIOD}&format=csv`)).status).toBe(403);
  });

  it('понад ліміт рядків — 413, а не обрізаний файл', async () => {
    prisma.bookingLedgerEntry.findMany.mockResolvedValue(Array.from({ length: 20_001 }, () => row()));
    expect((await get(`${PERIOD}&format=csv`)).status).toBe(413);
  });
});
