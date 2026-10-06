import type { Prisma } from '@prisma/client';
import { normalizePhone } from './phone';

/** Foundation for imports/backfill. Call inside a transaction; never grants login rights.
 * Existing links and player names are preserved, and ambiguous phone changes fail closed.
 * Not wired into booking/login until the migration and backfill have been approved.
 */
export async function linkCustomerPlayer(db: Prisma.TransactionClient, customerId: string, clubId: string) {
  const customer = await db.customer.findFirstOrThrow({
    where: { id: customerId, clubId },
    select: { id: true, clubId: true, phone: true, name: true, playerId: true },
  });
  const phone = normalizePhone(customer.phone);
  if (!phone) throw new Error('PLAYER_PHONE_INVALID');
  const player = customer.playerId
    ? await db.player.findUniqueOrThrow({ where: { id: customer.playerId } })
    : await db.player.upsert({
      where: { phone: phone.e164 },
      update: {},
      create: { phone: phone.e164, name: customer.name },
    });
  if (player.phone !== phone.e164) throw new Error('PLAYER_PHONE_CONFLICT');
  {
    const linked = await db.customer.updateMany({
      where: { id: customer.id, clubId, phone: customer.phone, playerId: customer.playerId },
      data: { playerId: player.id },
    });
    // Throwing rolls back the caller's transaction; retry with the fresh card.
    if (linked.count !== 1) throw new Error('PLAYER_LINK_CONFLICT');
  }
  await db.clubPlayerRating.upsert({
    where: { clubId_playerId: { clubId: customer.clubId, playerId: player.id } },
    update: {},
    create: { clubId: customer.clubId, playerId: player.id },
  });
  return player;
}
