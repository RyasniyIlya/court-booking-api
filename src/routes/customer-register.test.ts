import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Акаунт гравця у віджеті: реєстрація з паролем і вхід паролем.
 *
 * Головне — щоб жодна форма не стала обхідними дверима: ні реєстрація
 * (зареєстрований номер «зареєструвати» ще раз), ні вхід датою народження,
 * ні форма броні на номер чужого акаунта.
 */

const prisma = {
  club: { findFirst: vi.fn() },
  customer: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
};
const findOrCreateCustomer = vi.fn();
const signCustomerToken = vi.fn(() => 'token-1');
const verifyCustomerToken = vi.fn();
const verifyCustomerPassword = vi.fn();
const verifyTelegramMiniAppData = vi.fn();

vi.mock('../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../lib/customers', async (orig) => ({
  ...(await orig<typeof import('../lib/customers')>()),
  findOrCreateCustomer,
}));
vi.mock('../lib/billing', () => ({ clubBilling: () => ({ online: true }) }));
vi.mock('../lib/payments', () => ({ providerFor: () => null, publicBase: () => 'https://example.test' }));
vi.mock('../lib/customerAuth', () => ({ signCustomerToken, verifyCustomerToken }));
vi.mock('../lib/customerPassword', async (orig) => ({
  ...(await orig<typeof import('../lib/customerPassword')>()),
  hashCustomerPassword: vi.fn(async () => 'hash-1'),
  verifyCustomerPassword,
}));
vi.mock('../lib/telegramMiniApp', () => ({
  TelegramMiniAppDataError: class TelegramMiniAppDataError extends Error {
    constructor(public code: string) { super(code); }
  },
  verifyTelegramMiniAppData,
}));

const { publicRouter } = await import('./public');
const app = express().use(express.json()).use('/api/public', publicRouter);

const register = (body: Record<string, unknown>) =>
  request(app).post('/api/public/clubs/squash/customer/register').send(body);
const login = (body: Record<string, unknown>) =>
  request(app).post('/api/public/clubs/squash/customer/login').send(body);
const telegramLogin = (body: Record<string, unknown>) =>
  request(app).post('/api/public/clubs/squash/customer/telegram-session').send(body);

const valid = { phone: '067 111 22 33', name: '  Ілля   Рясний ', birthDate: '1990-03-15', password: 'padel-2026' };
const card = {
  id: 'cust-1', name: 'Ілля Рясний', phone: '+380671112233', email: null,
  birthDate: new Date('1990-03-15T00:00:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.club.findFirst.mockResolvedValue({ id: 'club-1', slug: 'squash' });
  prisma.customer.findUnique.mockResolvedValue(null);
  prisma.customer.updateMany.mockResolvedValue({ count: 1 });
  findOrCreateCustomer.mockResolvedValue(card);
  verifyCustomerToken.mockReturnValue(null);
});

describe('POST /clubs/:slug/customer/telegram-session', () => {
  beforeEach(() => {
    prisma.club.findFirst.mockResolvedValue({
      id: 'club-1', slug: 'squash', isActive: true, approvedAt: new Date(), plan: { tier: 3 },
    });
    verifyTelegramMiniAppData.mockReturnValue({ userId: '777000123', authDate: new Date(), queryId: 'query' });
    prisma.customer.findFirst.mockResolvedValue(card);
  });

  it('opens only the linked profile in the selected club', async () => {
    const res = await telegramLogin({ initData: 'signed-init-data' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('token-1');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(prisma.customer.findFirst).toHaveBeenCalledWith({
      where: { clubId: 'club-1', telegramChatId: '777000123' },
    });
  });

  it('does not issue a session for an unlinked Telegram account', async () => {
    prisma.customer.findFirst.mockResolvedValue(null);
    const res = await telegramLogin({ initData: 'signed-init-data' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('TELEGRAM_ACCOUNT_NOT_LINKED');
    expect(signCustomerToken).not.toHaveBeenCalled();
  });

  it('rejects invalid Telegram proof before reading the profile', async () => {
    verifyTelegramMiniAppData.mockImplementation(() => { throw new Error('bad signature'); });
    const res = await telegramLogin({ initData: 'tampered' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_TELEGRAM_DATA');
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  it('does not cross club boundaries', async () => {
    prisma.customer.findFirst.mockResolvedValue(null);
    await telegramLogin({ initData: 'signed-init-data' });
    expect(prisma.customer.findFirst).toHaveBeenCalledWith({
      where: { clubId: 'club-1', telegramChatId: '777000123' },
    });
  });
});

describe('POST /clubs/:slug/customer/register', () => {
  it('новий номер — створює акаунт із паролем і одразу пускає', async () => {
    const res = await register(valid);
    expect(res.status).toBe(201);
    expect(res.body.token).toBe('token-1');
    expect(findOrCreateCustomer).toHaveBeenCalledWith({
      clubId: 'club-1', name: 'Ілля Рясний', rawPhone: '+380671112233',
      birthDate: new Date('1990-03-15T00:00:00.000Z'),
    });
    expect(prisma.customer.updateMany).toHaveBeenCalledWith({
      where: { id: 'cust-1', passwordHash: null },
      data: { passwordHash: 'hash-1', passwordFails: 0, passwordLockedUntil: null },
    });
  });

  it('без пароля або з коротким паролем акаунт не створюється', async () => {
    expect((await register({ ...valid, password: undefined })).body).toEqual({ error: 'WEAK_PASSWORD' });
    expect((await register({ ...valid, password: '1234567' })).body).toEqual({ error: 'WEAK_PASSWORD' });
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
  });

  it('у номера вже є акаунт — 409 і жодного токена', async () => {
    prisma.customer.findUnique.mockResolvedValue({ birthDate: card.birthDate, passwordHash: 'x' });
    const res = await register(valid);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'ALREADY_REGISTERED' });
    expect(signCustomerToken).not.toHaveBeenCalled();
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
  });

  it('стара картка без пароля стає акаунтом, якщо дата збігається', async () => {
    prisma.customer.findUnique.mockResolvedValue({ birthDate: card.birthDate, passwordHash: null });
    expect((await register(valid)).status).toBe(201);
  });

  it('стара картка з іншою датою — чужу картку не забрати', async () => {
    prisma.customer.findUnique.mockResolvedValue({ birthDate: new Date('1985-01-01'), passwordHash: null });
    const res = await register(valid);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'BIRTH_DATE_MISMATCH' });
    expect(prisma.customer.updateMany).not.toHaveBeenCalled();
  });

  it('двоє реєструють той самий номер одночасно — другий отримує 409', async () => {
    prisma.customer.updateMany.mockResolvedValue({ count: 0 });
    const res = await register(valid);
    expect(res.status).toBe(409);
    expect(signCustomerToken).not.toHaveBeenCalled();
  });

  it('криве імʼя, кривий телефон, дата з майбутнього', async () => {
    expect((await register({ ...valid, name: '1' })).body).toEqual({ error: 'BAD_NAME' });
    expect((await register({ ...valid, phone: '12' })).body).toEqual({ error: 'BAD_PHONE' });
    expect((await register({ ...valid, birthDate: '2999-01-01' })).status).toBe(400);
  });
});

describe('POST /clubs/:slug/customer/login', () => {
  beforeEach(() => {
    prisma.customer.findUnique.mockResolvedValue(card);
  });

  it('правильний пароль — токен', async () => {
    verifyCustomerPassword.mockResolvedValue({ ok: true });
    const res = await login({ phone: '0671112233', password: 'padel-2026' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('token-1');
    expect(verifyCustomerPassword).toHaveBeenCalledWith('cust-1', 'padel-2026');
  });

  it('дата народження замість пароля більше не відчиняє профіль', async () => {
    const res = await login({ phone: '0671112233', birthDate: '1990-03-15' });
    expect(res.status).toBe(400);
    expect(signCustomerToken).not.toHaveBeenCalled();
  });

  it('невірний пароль, блокування і картка без пароля — різні відповіді', async () => {
    verifyCustomerPassword.mockResolvedValueOnce({ ok: false, reason: 'INVALID' });
    expect((await login({ phone: '0671112233', password: 'nope' })).body).toEqual({ error: 'INVALID_CREDENTIALS' });

    verifyCustomerPassword.mockResolvedValueOnce({ ok: false, reason: 'LOCKED' });
    const locked = await login({ phone: '0671112233', password: 'nope' });
    expect(locked.status).toBe(429);
    expect(locked.body).toEqual({ error: 'ACCOUNT_LOCKED' });

    verifyCustomerPassword.mockResolvedValueOnce({ ok: false, reason: 'NOT_SET' });
    expect((await login({ phone: '0671112233', password: 'whatever' })).body).toEqual({ error: 'PASSWORD_NOT_SET' });

    expect(signCustomerToken).not.toHaveBeenCalled();
  });
});
