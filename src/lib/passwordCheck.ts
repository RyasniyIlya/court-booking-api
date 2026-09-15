import { prisma } from './db';
import { comparePassword } from './passwordHash';

// The row lock is shared by website and Telegram, across all API processes.
export async function checkPassword(kind: 'user' | 'customer', id: string, password: string) {
  return prisma.$transaction(async tx => {
    if (kind === 'user') await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${id}::uuid FOR UPDATE`;
    else await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const row = kind === 'user'
      ? await tx.user.findUnique({ where: { id } })
      : await tx.customer.findUnique({ where: { id } });
    if (!row?.passwordHash) return { ok: false as const, reason: 'NOT_SET' as const };
    const failures = 'pinFails' in row ? row.pinFails : row.passwordFails;
    const until = 'pinLockedUntil' in row ? row.pinLockedUntil : row.passwordLockedUntil;
    const now = new Date();
    if (until && until > now) return { ok: false as const, reason: 'LOCKED' as const };
    const valid = password.length <= 128 && await comparePassword(password, row.passwordHash);
    const next = valid ? 0 : (until && until <= now ? 0 : failures) + 1;
    const lockedUntil = next >= 5 ? new Date(now.getTime() + 15 * 60_000) : null;
    if (!valid || failures || until) {
      if (kind === 'user') await tx.user.update({ where: { id }, data: { pinFails: next, pinLockedUntil: lockedUntil } });
      else await tx.customer.update({ where: { id }, data: { passwordFails: next, passwordLockedUntil: lockedUntil } });
    }
    return valid ? { ok: true as const } : { ok: false as const, reason: 'INVALID' as const };
  }, { timeout: 15000, maxWait: 15000 });
}
