import { it, expect, vi, beforeEach } from 'vitest';
const prisma = { $queryRaw: vi.fn(), $transaction: vi.fn(), telegramReceipt: {
  findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn(), deleteMany: vi.fn(async () => ({})),
} };
vi.mock('./db', () => ({ prisma }));
const { processTelegramUpdate } = await import('./telegramReceipt');
const update = { update_id: 123, message: { message_id: 1, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: 'private-password' } };
beforeEach(() => {
  vi.clearAllMocks(); prisma.$transaction.mockImplementation(fn => fn(prisma));
  prisma.telegramReceipt.findUnique.mockResolvedValue(null);
});
it('does not persist the message or password', async () => {
  const handle = vi.fn(async () => {}); await processTelegramUpdate(update, handle);
  expect(handle).toHaveBeenCalledWith(update);
  expect(JSON.stringify(prisma.telegramReceipt.upsert.mock.calls)).not.toContain('private-password');
  expect(prisma.telegramReceipt.update.mock.invocationCallOrder[0]).toBeGreaterThan(handle.mock.invocationCallOrder[0]);
});
it('casts the advisory lock result to a Prisma-supported PostgreSQL type', async () => {
  await processTelegramUpdate(update, async () => {});
  expect(prisma.$queryRaw.mock.calls[0][0].join('?')).toContain('::integer)::text');
});
it('does not acknowledge before handling completes', async () => {
  let complete!: () => void;
  const gate = new Promise<void>(resolve => { complete = resolve; });
  const handle = vi.fn(() => gate);
  const result = processTelegramUpdate(update, handle);
  await vi.waitFor(() => expect(handle).toHaveBeenCalled());
  expect(prisma.telegramReceipt.update).not.toHaveBeenCalled();
  complete(); await result;
  expect(prisma.telegramReceipt.update.mock.calls[0][0].data.doneAt).toBeInstanceOf(Date);
});
it('releases failed attempts for retry', async () => {
  await expect(processTelegramUpdate(update, async () => { throw new Error('db unavailable'); })).rejects.toThrow();
  expect(prisma.telegramReceipt.update).toHaveBeenCalledWith({ where: { id: 123 }, data: { leaseUntil: new Date(0) } });
});
it('does not run completed duplicates after restart', async () => {
  prisma.telegramReceipt.findUnique.mockResolvedValue({ doneAt: new Date() });
  const handle = vi.fn(); await processTelegramUpdate(update, handle); expect(handle).not.toHaveBeenCalled();
});
it('asks an in-flight duplicate to retry, without a second execution', async () => {
  prisma.telegramReceipt.findUnique.mockResolvedValue({ leaseUntil: new Date(Date.now() + 60000), doneAt: null });
  const handle = vi.fn(); await expect(processTelegramUpdate(update, handle)).rejects.toThrow('UPDATE_IN_PROGRESS');
  expect(handle).not.toHaveBeenCalled();
});
