import { prisma } from './db';
import { normalizePhone } from './phone';

/**
 * Пошук або створення картки клієнта за телефоном.
 * Викликається при кожній броні — реєстрація клієнту не потрібна.
 *
 * Гонку двох одночасних броней з одного номера ловить @@unique([clubId, phone]):
 * якщо другий запит не встиг, upsert просто оновить наявну картку.
 */
/**
 * Імʼя гравця з форми: 2–60 символів, хоч одна літера, без розмітки.
 *
 * Розмітку вирізаємо, а не відхиляємо: імʼя потрапляє в HTML-повідомлення
 * бота й у кабінет, а людина, яка вставила «<b>Ілля</b>» з буфера, не має
 * отримати помилку, в якій нічого не зрозуміє.
 */
export function cleanCustomerName(raw: string): string | null {
  const name = raw.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 60) return null;
  if (!/\p{L}/u.test(name)) return null;
  return name;
}

export async function findOrCreateCustomer(params: {
  clubId: string;
  name: string;
  rawPhone: string;
  email?: string;
  birthDate?: Date;
}) {
  const phone = normalizePhone(params.rawPhone);
  if (!phone) return null;

  const customer = await prisma.customer.upsert({
    where: { clubId_phone: { clubId: params.clubId, phone: phone.e164 } },
    // Імʼя не перезаписуємо: у картці може бути виправлене адміном,
    // а у формі людина щоразу пише як завгодно.
    update: {
      ...(params.email ? { email: params.email } : {}),
    },
    create: {
      clubId: params.clubId,
      name: params.name,
      phone: phone.e164,
      phoneTail: phone.tail,
      email: params.email,
      birthDate: params.birthDate,
    },
  });

  // Дата народження тепер є даними входу в кабінет. Формою нової броні
  // не можна перезаписати вже збережену дату: інакше стороння людина могла
  // б забрати доступ, знаючи лише номер телефону. Стару картку без дати
  // доповнюємо один раз під час першої броні після оновлення.
  if (!customer.birthDate && params.birthDate) {
    return prisma.customer.update({
      where: { id: customer.id },
      data: { birthDate: params.birthDate },
    });
  }
  return customer;
}

export type PassBalance = {
  passId: string;
  type: 'PACKAGE' | 'UNLIMITED';
  /** Скільки лишилось. Для безліміту — null */
  left: number | null;
  /** Скільки було куплено. Для безліміту — null */
  total: number | null;
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
      total: p.totalSessions ?? null,
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
      total: p.totalSessions ?? null,
      validUntil: p.validUntil,
      daysLeft: Math.ceil((p.validUntil.getTime() - on.getTime()) / 86_400_000),
      label: left === null
        ? `безліміт до ${fmt(p.validUntil)}`
        : `${left} з ${p.totalSessions}, до ${fmt(p.validUntil)}`,
    });
  }

  return out;
}
