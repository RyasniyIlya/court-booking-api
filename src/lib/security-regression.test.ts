import { beforeEach, describe, it, expect, vi } from 'vitest';
import bcrypt from 'bcryptjs';
const prisma = {
  $queryRaw: vi.fn(async () => []), $transaction: vi.fn(),
  user: { findUnique: vi.fn(), update: vi.fn() },
  customer: { findUnique: vi.fn(), update: vi.fn() },
  booking: { findUnique: vi.fn(), update: vi.fn() },
  bookingSeat: { findUnique: vi.fn(), updateMany: vi.fn() },
};
vi.mock('./db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('./authSecret', () => ({ JWT_SECRET: 'isolated-security-test-secret' }));
vi.mock('./telegram', () => ({ sendMessage: vi.fn(), deleteMessage: vi.fn(), answerCallback: vi.fn(), botReady: () => false }));
vi.mock('./notifyBooking', () => ({ notifyBooking: vi.fn(async () => {}) }));
const { requireAuth, signToken } = await import('../routes/admin/shared');
const { hashPassword, comparePassword } = await import('./passwordHash');
const { verifyCustomerPassword } = await import('./customerPassword');
const { handleUpdate } = await import('./botHandlers');
const { cancelSeatByCustomer } = await import('./customerCancel');
beforeEach(() => {
  vi.clearAllMocks();
  let tail = Promise.resolve();
  prisma.$transaction.mockImplementation(fn => {
    const result = tail.then(() => fn(prisma)); tail = result.catch(() => {}); return result;
  });
});
const account = { id: 'u', clubId: 'club', role: 'ADMIN', trainerId: null, passwordHash: 'old-hash' };
const token = () => signToken({ userId: 'u', clubId: 'club', role: 'ADMIN', trainerId: null }, '1h', 'old-hash');
async function authenticate(value = token()) {
  const req: any = { headers: { authorization: `Bearer ${value}` } };
  const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() }; const next = vi.fn();
  await requireAuth(req, res, next); return { req, res, next };
}
describe('session revocation', () => {
  it('accepts the current user and reads current privileges', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...account, role: 'TRAINER', trainerId: 'trainer' });
    const result = await authenticate(); expect(result.next).toHaveBeenCalledOnce();
    expect(result.req.auth.role).toBe('TRAINER');
  });
  it('rejects deleted users', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const result = await authenticate(); expect(result.res.status).toHaveBeenCalledWith(401); expect(result.next).not.toHaveBeenCalled();
  });
  it('rejects a previous credential after password change', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...account, passwordHash: 'new-hash' });
    expect((await authenticate()).res.status).toHaveBeenCalledWith(401);
  });
  it('rejects cross-club accounts', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...account, clubId: 'another-club' });
    expect((await authenticate()).next).not.toHaveBeenCalled();
  });
});
describe('Telegram personal identity', () => {
  it.each(['/newpassword attacker-password', '/login owner@club.test password', '/start ABC123'])('rejects group command %s before account access', async text => {
    await handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: -123, type: 'supergroup' }, from: { id: 456 }, text } });
    expect(prisma.user.findUnique).not.toHaveBeenCalled(); expect(prisma.user.update).not.toHaveBeenCalled();
  });
  it('rejects callbacks from another chat participant', async () => {
    await handleUpdate({ update_id: 2, callback_query: { id: 'q', data: 'ntf:bookings', from: { id: 456 }, message: { message_id: 1, chat: { id: -123 } } } });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
describe('passwords and concurrent attempts', () => {
  it('keeps long and Unicode password endings distinct', async () => {
    const prefix = 'я'.repeat(60); const hash = await hashPassword(prefix + 'one', 4);
    expect(await comparePassword(prefix + 'one', hash)).toBe(true);
    expect(await comparePassword(prefix + 'two', hash)).toBe(false);
  });
  it('accepts legacy short passwords but rejects silently truncated input', async () => {
    expect(await comparePassword('legacy-pass', await bcrypt.hash('legacy-pass', 4))).toBe(true);
    expect(await comparePassword('a'.repeat(73), await bcrypt.hash('a'.repeat(73), 4))).toBe(false);
  });
  it('blocks the sixth of ten simultaneous wrong guesses under the shared row lock', async () => {
    const row = { passwordHash: await hashPassword('correct-password', 4), passwordFails: 0, passwordLockedUntil: null };
    prisma.customer.findUnique.mockImplementation(async () => ({ ...row }));
    prisma.customer.update.mockImplementation(async ({ data }) => Object.assign(row, data));
    const results = await Promise.all(Array.from({ length: 10 }, () => verifyCustomerPassword('c', 'wrong-password')));
    expect(results.filter(r => !r.ok && r.reason === 'LOCKED')).toHaveLength(5);
    expect(row.passwordFails).toBe(5);
    expect(prisma.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
  });
});
it('concurrent seat cancellations change revenue exactly once', async () => {
  const seat = { id: 's', bookingId: 'b', status: 'BOOKED', price: 100, cancelToken: 't', customerId: 'c',
    booking: { id: 'b', clubId: 'club', startTime: new Date('2099-01-01'), club: { cancelCutoffMinutes: 0 } } };
  let revenue = 300;
  prisma.bookingSeat.findUnique.mockImplementation(async () => structuredClone(seat));
  prisma.bookingSeat.updateMany.mockImplementation(async ({ where, data }) => {
    if (seat.status !== where.status) return { count: 0 }; Object.assign(seat, data); return { count: 1 };
  });
  prisma.booking.update.mockImplementation(async ({ data }) => { revenue -= data.priceTotal.decrement; });
  const results = await Promise.all([cancelSeatByCustomer('s', () => true), cancelSeatByCustomer('s', () => true)]);
  expect(results.filter(r => r.ok && r.changed)).toHaveLength(1); expect(revenue).toBe(200);
});
