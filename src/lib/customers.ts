import { prisma } from './db';
import { normalizePhone } from './phone';

/**
 * Пошук або створення картки клієнта за телефоном.
 * Викликається при кожній броні — реєстрація клієнту не потрібна.
 *
 * Гонку двох одночасних броней з одного номера ловить @@unique([clubId, phone]):
 * якщо другий запит не встиг, upsert просто оновить наявну картку.
 */
export async function findOrCreateCustomer(params: {
  clubId: string;
  name: string;
  rawPhone: string;
}) {
  const phone = normalizePhone(params.rawPhone);
  if (!phone) return null;

  return prisma.customer.upsert({
    where: { clubId_phone: { clubId: params.clubId, phone: phone.e164 } },
    // Імʼя не перезаписуємо: у картці може бути виправлене адміном,
    // а у формі людина щоразу пише як завгодно.
    update: {},
    create: {
      clubId: params.clubId,
      name: params.name,
      phone: phone.e164,
      phoneTail: phone.tail,
    },
  });
}

export type PassBalance = {
  passId: string;
  type: 'PACKAGE' | 'UNLIMITED';
  /** Скільки лишилось. Для безліміту — null */
  left: number | null;
  validUntil: Date;
  /** Днів до кінця дії; відʼємне — прострочений */
  daysLeft: number;
  /** Готовий рядок для адмінки: "4 з 10, до 30.09" */
  label: string;
};

const fmt = (d: Date) =>
  `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;

/**
 * Активний абонемент клієнта на вказану дату.
 * Якщо активних кілька — беремо той, що згорає раніше.
 * Це вигідно клієнту й знімає суперечки на ресепшені.
 */
export async function getActivePass(
  customerId: string,
  on: Date = new Date(),
): Promise<PassBalance | null> {
  const passes = await prisma.pass.findMany({
    where: {
      customerId,
      revokedAt: null,
      validFrom: { lte: on },
      validUntil: { gte: on },
    },
    orderBy: { validUntil: 'asc' },
  });

  for (const p of passes) {
    const left = p.type === 'PACKAGE' ? (p.totalSessions ?? 0) - p.usedSessions : null;
    if (left !== null && left <= 0) continue; // вичерпаний — дивимось наступний

    const daysLeft = Math.ceil((p.validUntil.getTime() - on.getTime()) / 86_400_000);

    return {
      passId: p.id,
      type: p.type,
      left,
      validUntil: p.validUntil,
      daysLeft,
      label: left === null
        ? `безліміт до ${fmt(p.validUntil)}`
        : `${left} з ${p.totalSessions}, до ${fmt(p.validUntil)}`,
    };
  }

  return null;
}

/** Баланси одразу для списку клієнтів — щоб не робити N запитів на екран дня */
export async function getActivePasses(
  customerIds: string[],
  on: Date = new Date(),
): Promise<Map<string, PassBalance>> {
  const out = new Map<string, PassBalance>();
  if (customerIds.length === 0) return out;

  const passes = await prisma.pass.findMany({
    where: {
      customerId: { in: customerIds },
      revokedAt: null,
      validFrom: { lte: on },
      validUntil: { gte: on },
    },
    orderBy: { validUntil: 'asc' },
  });

  for (const p of passes) {
    if (out.has(p.customerId)) continue;
    const left = p.type === 'PACKAGE' ? (p.totalSessions ?? 0) - p.usedSessions : null;
    if (left !== null && left <= 0) continue;

    out.set(p.customerId, {
      passId: p.id,
      type: p.type,
      left,
      validUntil: p.validUntil,
      daysLeft: Math.ceil((p.validUntil.getTime() - on.getTime()) / 86_400_000),
      label: left === null
        ? `безліміт до ${fmt(p.validUntil)}`
        : `${left} з ${p.totalSessions}, до ${fmt(p.validUntil)}`,
    });
  }

  return out;
}
