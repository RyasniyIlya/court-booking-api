/** Security regression tests: all persistence and Telegram I/O mocked. */
import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const prisma: any = {
  $queryRaw: vi.fn(async () => []), $executeRawUnsafe: vi.fn(async () => 0), $transaction: vi.fn(),
  user: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  customer: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  club: { findFirst: vi.fn(), findUnique: vi.fn() },
  booking: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  payment: { findUnique: vi.fn(), update: vi.fn() },
  pass: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  passUsage: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  tgDialog: { findUnique: vi.fn() },
};
vi.mock('../src/lib/db', () => ({ prisma, notifyClub: vi.fn(), isSlotTakenError: () => false }));
vi.mock('../src/lib/authSecret', () => ({ JWT_SECRET: 'isolated-audit-secret-not-for-deployment' }));
vi.mock('../src/lib/telegram', () => ({
  sendMessage: vi.fn(async () => true), deleteMessage: vi.fn(async () => true),
  answerCallback: vi.fn(), editMessageText: vi.fn(), setMyCommands: vi.fn(), botReady: () => true,
}));
vi.mock('../src/lib/notifyBooking', () => ({ notifyBooking: vi.fn(async () => {}), notifySeriesCancelled: vi.fn() }));
vi.mock('../src/lib/billing', () => ({ clubBilling: () => ({ online: true }) }));
const { publicRouter } = await import('../src/routes/public');
const { customersRouter } = await import('../src/routes/admin/customers');
const { authRouter } = await import('../src/routes/admin/auth');
const { telegramRouter } = await import('../src/routes/admin/telegram');
const { handleUpdate } = await import('../src/lib/botHandlers');
const { changePassword } = await import('../src/lib/botPassword');
const { signToken, requireAuth, blockAccountant } = await import('../src/routes/admin/shared');
const { requirePlatformAuth, platformCredentialVersion } = await import('../src/lib/platformAuth');
const { hashPassword, comparePassword } = await import('../src/lib/passwordHash');
const { MockProvider } = await import('../src/lib/payments/mock');
const { mockPaymentsEnabled } = await import('../src/lib/payments/demo');
const { applyPayEvent } = await import('../src/lib/payments/apply');
const { sendMessage } = await import('../src/lib/telegram');

const uid = '11111111-1111-4111-8111-111111111111';
const cid = '22222222-2222-4222-8222-222222222222';
const bid = '33333333-3333-4333-8333-333333333333';
let user: any;
beforeEach(async () => {
  vi.resetAllMocks();
  user = { id: uid, clubId: cid, role: 'OWNER', trainerId: null, email: 'owner@example.test',
    passwordHash: await hashPassword('previous-password', 4), tgChatId: '101',
    tgLinkCode: 'ABC234', tgLinkUntil: new Date(Date.now() + 900000),
    pinFails: 0, pinLockedUntil: null,
    club: { id: cid, name: 'Audit club', timezone: 'Europe/Kyiv', plan: { tier: 3 } } };
  prisma.$queryRaw.mockResolvedValue([]);
  prisma.$transaction.mockImplementation(async (operations: any) => typeof operations === 'function' ? operations(prisma) : Promise.all(operations));
  prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
    (where.id === uid || where.tgChatId === user.tgChatId || where.tgLinkCode === user.tgLinkCode) ? structuredClone(user) : null);
  prisma.user.update.mockImplementation(async ({ data }: any) => Object.assign(user, data));
  prisma.user.updateMany.mockResolvedValue({ count: 0 });
  prisma.tgDialog.findUnique.mockResolvedValue(null);
});
const staffToken = () => signToken({ userId: uid, clubId: cid, role: 'OWNER', trainerId: null }, '1h', user.passwordHash);

it('recovery code requires correct current password; bearer alone is insufficient', async () => {
  prisma.club.findUnique.mockResolvedValue({ plan: { tier: 3 } });
  prisma.user.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (where.id !== user.id || where.passwordHash !== user.passwordHash) return { count: 0 };
    Object.assign(user, data); return { count: 1 };
  });
  const app = express().use(express.json()).use('/api/admin', telegramRouter);
  const post = () => request(app).post('/api/admin/telegram/link').set('Authorization', `Bearer ${staffToken()}`);
  expect((await post().send({})).status).toBe(400);
  expect((await post().send({ currentPassword: 'wrong-password' })).status).toBe(403);
  expect(prisma.user.updateMany).not.toHaveBeenCalled();
  const result = await post().send({ currentPassword: 'previous-password' });
  expect(result.status).toBe(200);
  expect(result.body.code).toMatch(/^[A-Z0-9]{6}$/);
});

it.each([null, new Date('1990-01-01')])('existing legacy card DOB %s cannot be claimed or disclosed', async birthDate => {
  prisma.club.findFirst.mockResolvedValue({ id: cid });
  prisma.customer.findUnique.mockResolvedValue({ id: uid, passwordHash: null, birthDate, name: 'Victim', email: 'victim@example.test' });
  const response = await request(express().use(express.json()).use('/api/public', publicRouter))
    .post('/api/public/clubs/audit/customer/register').send({ phone: '+380671112233', name: 'Attacker', birthDate: '1990-01-01', password: 'attacker-password', acceptedTerms: true });
  expect(response.status).toBe(409);
  expect(response.body).toEqual({ error: 'CUSTOMER_VERIFICATION_REQUIRED' });
  expect(prisma.customer.upsert).not.toHaveBeenCalled();
  expect(prisma.customer.updateMany).not.toHaveBeenCalled();
});

// Model atomic conditional updates and transaction rollback. No real database is used.
function passModel(initialUsed: number, initialUsage: any = null) {
  let state = { used: initialUsed, usage: initialUsage };
  let tail = Promise.resolve();
  prisma.$transaction.mockImplementation((operation: any) => {
    const result = tail.then(async () => {
      const snapshot = structuredClone(state);
      try { return await operation(prisma); } catch (error) { state = snapshot; throw error; }
    });
    tail = result.catch(() => undefined);
    return result;
  });
  prisma.booking.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id, customerId: uid, startTime: new Date() }));
  prisma.pass.findMany.mockImplementation(async () => [{ id: cid, type: 'PACKAGE', totalSessions: 1, usedSessions: state.used, validUntil: new Date('2099-01-01') }]);
  prisma.pass.findUnique.mockImplementation(async () => ({ type: 'PACKAGE', totalSessions: 1, usedSessions: state.used }));
  prisma.passUsage.findUnique.mockImplementation(async () => structuredClone(state.usage));
  prisma.pass.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (where.usedSessions?.lt !== undefined && state.used >= where.usedSessions.lt) return { count: 0 };
    if (where.usedSessions?.gt !== undefined && state.used <= where.usedSessions.gt) return { count: 0 };
    state.used += (data.usedSessions.increment ?? 0) - (data.usedSessions.decrement ?? 0);
    return { count: 1 };
  });
  prisma.passUsage.create.mockImplementation(async ({ data }: any) => {
    if (state.usage) throw { code: 'P2002' };
    return state.usage = { id: uid, ...data, revertedAt: null, pass: { clubId: cid } };
  });
  prisma.passUsage.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (!state.usage || (where.revertedAt === null && state.usage.revertedAt !== null)) return { count: 0 };
    Object.assign(state.usage, data);
    return { count: 1 };
  });
  return () => state;
}
const passApp = () => express().use(express.json()).use('/api/admin', customersRouter);
it('two concurrent reversals decrement one usage only once', async () => {
  const state = passModel(1, { id: uid, passId: cid, revertedAt: null, pass: { clubId: cid } });
  const app = passApp(), auth = `Bearer ${staffToken()}`;
  const results = await Promise.all([1, 2].map(() => request(app).delete(`/api/admin/bookings/${bid}/use-pass`).set('Authorization', auth)));
  expect(results.map(r => r.status).sort()).toEqual([200, 404]);
  expect(state().used).toBe(0);
});
it('last pass session can be spent by only one of two bookings', async () => {
  const state = passModel(0);
  const app = passApp(), auth = `Bearer ${staffToken()}`;
  const results = await Promise.all([bid, uid].map(id => request(app).post(`/api/admin/bookings/${id}/use-pass`).set('Authorization', auth).send({})));
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(state().used).toBe(1);
  expect(prisma.pass.updateMany.mock.calls[0][0].where.usedSessions).toEqual({ lt: 1 });
});
it('reapplies existing reverted usage without another unique create', async () => {
  const state = passModel(0, { id: uid, passId: cid, revertedAt: new Date(), pass: { clubId: cid } });
  const result = await request(passApp()).post(`/api/admin/bookings/${bid}/use-pass`).set('Authorization', `Bearer ${staffToken()}`).send({});
  expect(result.body).toEqual({ ok: true, left: 0 });
  expect(state().usage.revertedAt).toBe(null);
  expect(prisma.passUsage.create).not.toHaveBeenCalled();
});
it('usage CAS conflict rolls back earlier pass increment', async () => {
  const state = passModel(0, { id: uid, passId: cid, revertedAt: new Date(), pass: { clubId: cid } });
  prisma.passUsage.updateMany.mockResolvedValue({ count: 0 });
  expect((await request(passApp()).post(`/api/admin/bookings/${bid}/use-pass`).set('Authorization', `Bearer ${staffToken()}`).send({})).status).toBe(409);
  expect(state().used).toBe(0);
});
it('usage revert CAS conflict rolls back earlier pass decrement', async () => {
  const state = passModel(1, { id: uid, passId: cid, revertedAt: null, pass: { clubId: cid } });
  prisma.passUsage.updateMany.mockResolvedValue({ count: 0 });
  expect((await request(passApp()).delete(`/api/admin/bookings/${bid}/use-pass`).set('Authorization', `Bearer ${staffToken()}`)).status).toBe(404);
  expect(state().used).toBe(1);
  expect(state().usage.revertedAt).toBe(null);
});
it('credentials changed before recovery code issuance cause CAS rejection', async () => {
  prisma.club.findUnique.mockResolvedValue({ plan: { tier: 3 } });
  prisma.user.updateMany.mockResolvedValue({ count: 0 });
  const response = await request(express().use(express.json()).use('/api/admin', telegramRouter))
    .post('/api/admin/telegram/link').set('Authorization', `Bearer ${staffToken()}`).send({ currentPassword: 'previous-password' });
  expect(response.status).toBe(409);
  expect(response.body).toEqual({ error: 'CREDENTIALS_CHANGED' });
});
it('web password change clears pending code while keeping legitimate recovery chat', async () => {
  const app = express().use(express.json()).use('/api/admin', authRouter);
  const response = await request(app).post('/api/admin/password').set('Authorization', `Bearer ${staffToken()}`)
    .send({ currentPassword: 'previous-password', password: 'new-victim-password' });
  expect(response.status).toBe(200);
  expect(user.tgChatId).toBe('101');
  expect(user.tgLinkCode).toBe(null);
  expect(user.tgLinkUntil).toBe(null);
  await changePassword('101', 'legitimate-recovery-password');
  expect(await comparePassword('legitimate-recovery-password', user.passwordHash)).toBe(true);
});
it('one Telegram code has exactly one concurrent winner', async () => {
  let readers = 0; let release: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  prisma.user.findUnique.mockImplementation(async ({ where }: any) => {
    if (where.tgLinkCode === 'ABC234') {
      const snapshot = structuredClone(user);
      if (++readers === 2) release();
      await barrier; return snapshot;
    }
    return where.tgChatId === user.tgChatId ? structuredClone(user) : null;
  });
  prisma.user.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (!where.tgLinkCode) return { count: 0 };
    if (where.tgLinkCode !== user.tgLinkCode || where.passwordHash !== user.passwordHash) return { count: 0 };
    Object.assign(user, data); return { count: 1 };
  });
  const update = (id: number) => ({ update_id: id, message: { message_id: id, chat: { id, type: 'private' }, from: { id }, text: '/start ABC234' } });
  await Promise.all([handleUpdate(update(201)), handleUpdate(update(202))]);
  expect(prisma.user.update).toHaveBeenCalledTimes(1);
  expect(['201', '202']).toContain(user.tgChatId);
  expect(user.tgLinkCode).toBe(null);
});
it('expired code does not change chat', async () => {
  user.tgLinkUntil = new Date(0);
  await handleUpdate({ update_id: 201, message: { message_id: 1, chat: { id: 201, type: 'private' }, from: { id: 201 }, text: '/start ABC234' } });
  expect(prisma.user.update).not.toHaveBeenCalled();
});
it('platform current token works; changed/disabled/unversioned credentials are rejected', async () => {
  const previous = { email: process.env.PLATFORM_ADMIN_EMAIL, hash: process.env.PLATFORM_ADMIN_PASSWORD_HASH };
  const app = express().get('/protected', requirePlatformAuth, (_req, res) => res.json({ ok: true }));
  try {
    process.env.PLATFORM_ADMIN_EMAIL = 'old-admin@example.test'; process.env.PLATFORM_ADMIN_PASSWORD_HASH = 'fixture-hash';
    const sign = (versioned: boolean) => jwt.sign({ scope: 'platform', email: 'old-admin@example.test', ...(versioned ? { credentialVersion: platformCredentialVersion() } : {}) }, 'isolated-audit-secret-not-for-deployment', { expiresIn: '12h' });
    const token = sign(true);
    expect((await request(app).get('/protected').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get('/protected').set('Authorization', `Bearer ${sign(false)}`)).status).toBe(401);
    process.env.PLATFORM_ADMIN_PASSWORD_HASH = 'changed-hash';
    expect((await request(app).get('/protected').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    delete process.env.PLATFORM_ADMIN_EMAIL; delete process.env.PLATFORM_ADMIN_PASSWORD_HASH;
    expect((await request(app).get('/protected').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  } finally {
    if (previous.email === undefined) delete process.env.PLATFORM_ADMIN_EMAIL; else process.env.PLATFORM_ADMIN_EMAIL = previous.email;
    if (previous.hash === undefined) delete process.env.PLATFORM_ADMIN_PASSWORD_HASH; else process.env.PLATFORM_ADMIN_PASSWORD_HASH = previous.hash;
  }
});
it('production mock payments are allowed unless DEMO_PAYMENTS=false', () => {
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('DEMO_PAYMENTS', '');
  expect(mockPaymentsEnabled()).toBe(true);
  vi.stubEnv('DEMO_PAYMENTS', 'false'); expect(mockPaymentsEnabled()).toBe(false);
  vi.stubEnv('DEMO_PAYMENTS', 'true'); expect(mockPaymentsEnabled()).toBe(true);
  vi.unstubAllEnvs();
});
it('finance mounted before general admin allows accountant; general admin stays denied', async () => {
  user.role = 'ACCOUNTANT';
  const token = staffToken();
  const admin = express.Router().use(authRouter).use(requireAuth, blockAccountant);
  const app = express().get('/api/admin/finance/cashbook', requireAuth, (_req, res) => res.json({ finance: true })).use('/api/admin', admin);
  expect((await request(app).get('/api/admin/finance/cashbook').set('Authorization', `Bearer ${token}`)).status).toBe(200);
  expect((await request(app).get('/api/admin/customers').set('Authorization', `Bearer ${token}`)).status).toBe(403);
});
it('trainer schedule escapes public booking name and court text', async () => {
  user.role = 'TRAINER'; user.trainerId = cid;
  prisma.booking.findMany = vi.fn(async () => [{ startTime: new Date(), endTime: new Date(Date.now() + 3600000), status: 'PENDING',
    customerName: '<a href="https://phish.example">Перевірити оплату</a>', court: { name: '<invalid>& Court' } }]);
  await handleUpdate({ update_id: 99, message: { message_id: 99, chat: { id: 101, type: 'private' }, from: { id: 101 }, text: '/today' } });
  const messages = vi.mocked(sendMessage).mock.calls.map(call => call[1]).join('\n');
  expect(messages).not.toContain('<a href=');
  expect(messages).toContain('&lt;a href=');
  expect(messages).toContain('&lt;invalid&gt;&amp; Court');
});
