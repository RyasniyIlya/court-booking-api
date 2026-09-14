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
    findFirst: vi.fn(async () => ({ closedAt: new Date('2026-09-14T06:00:00Z') })),
    create: vi.fn(async ({ data }: { data: object }) => ({ id: 'sc1', ...data })),
  },
  bookingLedgerEntry: { findMany: vi.fn(async () => ledger) },
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
