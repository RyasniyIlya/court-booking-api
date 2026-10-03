import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Закриття зміни. Цікаве тут не щасливий шлях, а те, що НЕ проходить:
 * тренер, застарілі цифри, розбіжність без пояснення, повтор запиту.
 */

const REQ = '11111111-1111-4111-8111-111111111111';
const ledger = [
  { kind: 'PAYMENT', method: 'CASH', amount: 50000, account: 'Каса' },
  { kind: 'PAYMENT', method: 'CARD', amount: 30000, account: 'Термінал' },
];

const tx = {
  $queryRaw: vi.fn(async () => []),
  club: { findUniqueOrThrow: vi.fn(async () => ({ name: 'Падел Хаб', timezone: 'Europe/Kyiv', plan: { tier: 3, featTrainers: true, featGroups: true, featAnalytics: true } })) },
  shiftClose: {
    findUnique: vi.fn(async (): Promise<unknown> => null),
    findFirst: vi.fn(async (_args?: unknown): Promise<unknown> => ({ closedAt: new Date('2026-09-14T06:00:00Z') })),
    findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
    create: vi.fn(async ({ data }: { data: object }) => ({ id: 'sc1', ...data })),
  },
  bookingLedgerEntry: { findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => ledger) },
  user: { findFirst: vi.fn(async () => ({ id: 'u1', email: 'olya@club.ua', name: 'Оля', role: 'ADMIN' })) },
};
const prisma = {
  ...tx,
  $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  user: { ...tx.user, findMany: vi.fn(async () => [{ tgChatId: '777' }]) },
};
const sendMessage = vi.fn(async () => null);
const auth = { role: 'ADMIN' };

vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('../../lib/telegram', () => ({ sendMessage }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: 'u1', clubId: 'club-1', role: auth.role, trainerId: null };
    next();
  },
  requireStaff: (req: { auth: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    req.auth.role === 'TRAINER' ? res.status(403).json({ error: 'FORBIDDEN' }) : next(),
}));

const { shiftRouter } = await import('./shift');
const app = express().use(express.json()).use('/api/admin', shiftRouter);

const body = (patch: object = {}) => ({
  requestId: REQ, countedCash: 50000, countedCard: 30000,
  expectedCash: 50000, expectedCard: 30000, entriesCount: 2, note: '', ...patch,
});
const close = (b: object) => request(app).post('/api/admin/shift/close').send(b);

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = 'ADMIN';
  tx.shiftClose.findUnique.mockResolvedValue(null);
  tx.shiftClose.findFirst.mockResolvedValue({ closedAt: new Date('2026-09-14T06:00:00Z') });
  tx.shiftClose.findMany.mockResolvedValue([]);
  tx.bookingLedgerEntry.findMany.mockResolvedValue(ledger);
});

describe('POST /shift/close', () => {
  it('закриває зміну, рахує «очікувалось» сам і шле власнику в Telegram', async () => {
    const res = await close(body());
    expect(res.status).toBe(200);
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.shiftClose.create.mock.calls[0][0].data).toMatchObject({
      expectedCash: 50000, countedCash: 50000, expectedCard: 30000, entriesCount: 2,
      actorEmail: 'olya@club.ua', actorName: 'Оля', clubId: 'club-1',
    });
    expect(res.body.notified).toBe(1);
    expect(sendMessage).toHaveBeenCalledWith('777', expect.stringContaining('Зміну закрито'));
  });

  it('тренер зміну не закриває', async () => {
    auth.role = 'TRAINER';
    expect((await close(body())).status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('поки рахували, упала нова оплата — 409, а не вигадана розбіжність', async () => {
    const res = await close(body({ expectedCash: 40000 }));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('SHIFT_CHANGED');
    expect(tx.shiftClose.create).not.toHaveBeenCalled();
  });

  it('недостача без пояснення не приймається', async () => {
    const res = await close(body({ countedCash: 45000 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NOTE_REQUIRED');
    expect((await close(body({ countedCash: 45000, note: 'Здача з 500' }))).status).toBe(200);
  });

  it('повтор після втрати мережі не створює другу зміну й не шле друге повідомлення', async () => {
    tx.shiftClose.findUnique.mockResolvedValue({ id: 'sc-old', requestId: REQ });
    const res = await close(body());
    expect(res.status).toBe(200);
    expect(res.body.close.id).toBe('sc-old');
    expect(tx.shiftClose.create).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('відкидає відʼємні суми й зайві поля', async () => {
    expect((await close(body({ countedCash: -1 }))).status).toBe(400);
    expect((await close(body({ expectedCash: 50000, actorEmail: 'boss@club.ua' }))).status).toBe(400);
  });
});

/* ── Історія змін ─────────────────────────────────────────────────────── */

const sc = (id: string, patch: object = {}) => ({
  id, clubId: 'club-1', openedAt: new Date('2026-09-13T15:00:00Z'), closedAt: new Date('2026-09-14T18:00:00Z'),
  expectedCash: 50000, countedCash: 50000, expectedCard: 30000, countedCard: 30000,
  transferNet: 0, bonusNet: 0, entriesCount: 2, note: '', actorName: 'Оля', actorEmail: 'olya@club.ua', actorRole: 'ADMIN',
  ...patch,
});
const ID1 = '22222222-2222-4222-8222-222222222222';
const ID2 = '33333333-3333-4333-8333-333333333333';
const ID3 = '44444444-4444-4444-8444-444444444444';

describe('GET /shifts', () => {
  it('без періоду лишається масивом, як і раніше (?limit)', async () => {
    tx.shiftClose.findMany.mockResolvedValue([sc(ID1)]);
    const res = await request(app).get('/api/admin/shifts?limit=5');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(tx.shiftClose.findMany.mock.calls[0][0]).toMatchObject({ where: { clubId: 'club-1' }, take: 5 });
  });

  it('з періодом віддає обʼєкт із підсумком по всіх змінах, а не по сторінці', async () => {
    tx.shiftClose.findMany.mockResolvedValue([
      sc(ID1, { countedCash: 45000 }), sc(ID2, { countedCard: 31000 }), sc(ID3),
    ]);
    const res = await request(app).get('/api/admin/shifts?from=2026-09-01&to=2026-09-30&limit=2');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.nextCursor).toBe(ID2);
    expect(res.body.totals).toMatchObject({
      shifts: 3, expectedCash: 150000, countedCash: 145000, diffCash: -5000,
      expectedCard: 90000, countedCard: 91000, diffCard: 1000, entries: 6, withDiff: 2,
    });
  });

  it('курсор віддає наступну сторінку й закінчується', async () => {
    tx.shiftClose.findMany.mockResolvedValue([sc(ID1), sc(ID2), sc(ID3)]);
    const res = await request(app).get(`/api/admin/shifts?from=2026-09-01&to=2026-09-30&limit=2&cursor=${ID2}`);
    expect(res.body.items.map((x: { id: string }) => x.id)).toEqual([ID3]);
    expect(res.body.nextCursor).toBeNull();
    expect((await request(app).get(`/api/admin/shifts?from=2026-09-01&to=2026-09-30&cursor=${REQ}`)).status).toBe(400);
  });

  it('межі доби — за таймзоною клубу, «to» включно', async () => {
    await request(app).get('/api/admin/shifts?from=2026-09-01&to=2026-09-30');
    const where = tx.shiftClose.findMany.mock.calls[0][0] as { where: { closedAt: { gte: Date; lt: Date } } };
    /* Київ у вересні UTC+3: 1 вересня 00:00 = 31 серпня 21:00 UTC; кінець — початок 1 жовтня. */
    expect(where.where.closedAt.gte.toISOString()).toBe('2026-08-31T21:00:00.000Z');
    expect(where.where.closedAt.lt.toISOString()).toBe('2026-09-30T21:00:00.000Z');
  });

  it('зіпсований, перевернутий чи задовгий період — 400', async () => {
    for (const qs of ['from=2026-09-01', 'to=2026-09-01', 'from=2026-02-31&to=2026-03-01', 'from=2026-09-10&to=2026-09-01', 'from=2025-01-01&to=2026-09-01', 'from=abc&to=def']) {
      expect((await request(app).get(`/api/admin/shifts?${qs}`)).status, qs).toBe(400);
    }
  });

  it('тренерові закрито', async () => {
    auth.role = 'TRAINER';
    expect((await request(app).get('/api/admin/shifts?from=2026-09-01&to=2026-09-30')).status).toBe(403);
  });
});

describe('GET /shifts/:id', () => {
  it('віддає зміну з підсумками й операціями в її вікні', async () => {
    tx.shiftClose.findFirst.mockResolvedValue(sc(ID1));
    const res = await request(app).get(`/api/admin/shifts/${ID1}`);
    expect(res.status).toBe(200);
    expect(tx.shiftClose.findFirst.mock.calls[0][0]).toMatchObject({ where: { id: ID1, clubId: 'club-1' } });
    expect(tx.bookingLedgerEntry.findMany.mock.calls[0][0]).toMatchObject({
      where: { clubId: 'club-1', createdAt: { gt: new Date('2026-09-13T15:00:00Z'), lte: new Date('2026-09-14T18:00:00Z') } },
    });
    expect(res.body.totals).toEqual({ cash: 50000, card: 30000, transfer: 0, bonus: 0 });
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.truncated).toBe(false);
    expect(res.body.close.id).toBe(ID1);
  });

  it('чужа зміна й зіпсований id — 404', async () => {
    tx.shiftClose.findFirst.mockResolvedValue(null);
    expect((await request(app).get(`/api/admin/shifts/${ID1}`)).status).toBe(404);
    expect((await request(app).get('/api/admin/shifts/not-a-uuid')).status).toBe(404);
  });

  it('понад тисячу операцій — обрізає й каже про це', async () => {
    tx.shiftClose.findFirst.mockResolvedValue(sc(ID1));
    tx.bookingLedgerEntry.findMany.mockResolvedValue(
      Array.from({ length: 1001 }, (_, i) => ({ id: String(i), kind: 'PAYMENT', method: 'CASH', amount: 100, account: 'Каса' })),
    );
    const res = await request(app).get(`/api/admin/shifts/${ID1}`);
    expect(res.body.truncated).toBe(true);
    expect(res.body.entries).toHaveLength(1000);
  });
});

/* Рішення власника 2026-09-28: модератор бачить лише свої закриття */

describe('ADMIN бачить лише власні закриті зміни', () => {
  it('/shifts без періоду: where.actorId = власний id', async () => {
    await request(app).get('/api/admin/shifts?limit=5');
    expect(tx.shiftClose.findMany.mock.calls[0][0]).toMatchObject({ where: { clubId: 'club-1', actorId: 'u1' } });
  });

  it('/shifts з періодом: where.actorId = власний id', async () => {
    await request(app).get('/api/admin/shifts?from=2026-09-01&to=2026-09-30');
    expect(tx.shiftClose.findMany.mock.calls[0][0]).toMatchObject({ where: { clubId: 'club-1', actorId: 'u1' } });
  });

  it('/shifts/:id: чужа зміна шукається з actorId і дає 404', async () => {
    tx.shiftClose.findFirst.mockResolvedValue(null);
    const res = await request(app).get(`/api/admin/shifts/${ID1}`);
    expect(res.status).toBe(404);
    expect(tx.shiftClose.findFirst.mock.calls[0][0]).toMatchObject({ where: { id: ID1, clubId: 'club-1', actorId: 'u1' } });
  });

  it('OWNER не звужується до себе', async () => {
    auth.role = 'OWNER';
    await request(app).get('/api/admin/shifts?limit=5');
    const where = (tx.shiftClose.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({ clubId: 'club-1' });
  });
});
