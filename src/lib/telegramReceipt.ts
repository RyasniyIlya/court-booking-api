import { prisma } from './db';
import type { TgUpdate } from './telegram';

/** Persist only update IDs. A failed/crashed handler receives Telegram's retry, not an early 200. */
export async function processTelegramUpdate(update: TgUpdate, handle: (u: TgUpdate) => Promise<void>) {
  const now = new Date();
  const state = await prisma.$transaction(async tx => {
    // PostgreSQL returns void here; Prisma cannot deserialize void results.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(71832, ${update.update_id}::integer)::text`;
    const row = await tx.telegramReceipt.findUnique({ where: { id: update.update_id } });
    if (row?.doneAt) return 'done';
    if (row && row.leaseUntil > now) return 'busy';
    const leaseUntil = new Date(now.getTime() + 5 * 60_000);
    await tx.telegramReceipt.upsert({ where: { id: update.update_id }, create: { id: update.update_id, leaseUntil }, update: { leaseUntil } });
    return 'claimed';
  });
  if (state === 'done') return;
  if (state === 'busy') throw new Error('UPDATE_IN_PROGRESS');
  try {
    await handle(update);
    await prisma.telegramReceipt.update({ where: { id: update.update_id }, data: { doneAt: new Date() } });
  } catch (error) {
    await prisma.telegramReceipt.update({ where: { id: update.update_id }, data: { leaseUntil: new Date(0) } });
    throw error;
  }
  void prisma.telegramReceipt.deleteMany({ where: { doneAt: { lt: new Date(Date.now() - 7 * 86400_000) } } })
    .catch(() => console.error('[telegram] receipt cleanup failed'));
}
