import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
async function main() {
  // Only counts and technical identifiers; never print connection credentials or client data.
  const conflicts = await db.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count FROM "Booking" AS a
    JOIN "Booking" AS b ON a."trainerId" = b."trainerId" AND a.id < b.id
      AND a."startTime" < b."endTime" AND b."startTime" < a."endTime"
    WHERE a.status IN ('PENDING', 'CONFIRMED') AND b.status IN ('PENDING', 'CONFIRMED')`;
  const groups = await db.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count FROM "User" WHERE "tgChatId" LIKE '-%'`;
  const counts = await db.$queryRaw<Array<{ bookings: bigint; clubs: bigint }>>`
    SELECT (SELECT COUNT(*) FROM "Booking") AS bookings, (SELECT COUNT(*) FROM "Club") AS clubs`;
  console.log(JSON.stringify({ trainerConflicts: Number(conflicts[0].count),
    groupStaffLinks: Number(groups[0].count), bookings: Number(counts[0].bookings), clubs: Number(counts[0].clubs) }));
  if (conflicts[0].count > 0n) process.exitCode = 2;
}
main().catch(() => { console.error('Preflight failed; no data changed.'); process.exitCode = 1; })
  .finally(() => db.$disconnect());
