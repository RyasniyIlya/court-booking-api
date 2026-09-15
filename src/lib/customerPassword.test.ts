import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';

const prisma = { $transaction: vi.fn(), $queryRaw: vi.fn(), customer: { findUnique: vi.fn(), update: vi.fn() } };
vi.mock('./db', () => ({ prisma }));

const { verifyCustomerPassword, passwordText } = await import('./customerPassword');

const hash = bcrypt.hashSync('padel-2026', 4);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async fn => fn(prisma));
  prisma.customer.findUnique.mockResolvedValue({ passwordHash: hash, passwordFails: 0, passwordLockedUntil: null });
});

describe('verifyCustomerPassword', () => {
  it('вірний пароль проходить', async () => {
    expect(await verifyCustomerPassword('c1', 'padel-2026')).toEqual({ ok: true });
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });

  it('промах рахується', async () => {
    expect(await verifyCustomerPassword('c1', 'wrong')).toEqual({ ok: false, reason: 'INVALID' });
    expect(prisma.customer.update.mock.calls[0][0].data.passwordFails).toBe(1);
  });

  it("п'ятий промах поспіль блокує картку на 15 хвилин", async () => {
    prisma.customer.findUnique.mockResolvedValue({ passwordHash: hash, passwordFails: 4, passwordLockedUntil: null });
    await verifyCustomerPassword('c1', 'wrong');
    const until = prisma.customer.update.mock.calls[0][0].data.passwordLockedUntil as Date;
    expect(until.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it('заблоковану картку не пускає навіть із вірним паролем', async () => {
    prisma.customer.findUnique.mockResolvedValue({ passwordHash: hash, passwordFails: 0, passwordLockedUntil: new Date(Date.now() + 60_000) });
    expect(await verifyCustomerPassword('c1', 'padel-2026')).toEqual({ ok: false, reason: 'LOCKED' });
  });

  it('вдалий вхід скидає лічильник', async () => {
    prisma.customer.findUnique.mockResolvedValue({ passwordHash: hash, passwordFails: 3, passwordLockedUntil: null });
    await verifyCustomerPassword('c1', 'padel-2026');
    expect(prisma.customer.update.mock.calls[0][0].data).toEqual({ passwordFails: 0, passwordLockedUntil: null });
  });

  it('картка без пароля — NOT_SET, а не «невірний пароль»', async () => {
    prisma.customer.findUnique.mockResolvedValue({ passwordHash: null, passwordFails: 0, passwordLockedUntil: null });
    expect(await verifyCustomerPassword('c1', 'anything')).toEqual({ ok: false, reason: 'NOT_SET' });
  });
});

describe('passwordText', () => {
  it('від 8 до 128 символів', () => {
    expect(passwordText.safeParse('1234567').success).toBe(false);
    expect(passwordText.safeParse('12345678').success).toBe(true);
    expect(passwordText.safeParse('x'.repeat(129)).success).toBe(false);
  });
});
