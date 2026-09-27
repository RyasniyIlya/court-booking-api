import { prisma } from './db';
import { passLiability, type PassLike } from './financeReports';

/**
 * Запити до бази для financeReports.ts (той файл — лише чисті функції).
 * Виніс з routes/finance.ts без зміни логіки: той самий запит, той самий
 * `/passes`, плюс тепер ще й інструмент нейроаналітика get_passes_status
 * бере ці самі числа — щоб кабінет і чат ніколи не розійшлись.
 */
export async function loadLiabilityPasses(clubId: string, now: Date = new Date()) {
  const passes = await prisma.pass.findMany({
    where: {
      clubId,
      revokedAt: null,
      price: { gt: 0 },
      validUntil: { gt: new Date(now.getTime() - 30 * 86_400_000) },
    },
    select: {
      id: true, type: true, totalSessions: true, usedSessions: true, validFrom: true, validUntil: true,
      price: true, revokedAt: true,
      customer: { select: { id: true, name: true, phone: true } },
    },
  });
  return passLiability(passes as PassLike[], now);
}
