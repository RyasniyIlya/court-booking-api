import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHmac } from 'node:crypto';
import { prisma } from './db';
import { JWT_SECRET } from './authSecret';

const MAX_PIN_FAILS = 5;
const PIN_LOCK_MINUTES = 15;

export type CustomerAuth = { scope: 'customer'; customerId: string; clubId: string };

/**
 * Швидкий детермінований відбиток PIN для перевірки унікальності в межах
 * клубу — bcrypt для цього не годиться: у нього свій рандомний salt, тому
 * два однакові PIN дають різні хеші і порівнювати можна тільки перебором
 * (bcrypt.compare навмисно повільний, ~100+ мс — для клубу з сотнею
 * клієнтів це секунди на одну спробу забронювати). HMAC із серверним
 * секретом детермінований і швидкий, але сам по собі нікого не пускає —
 * вхід усе одно перевіряється через bcrypt.compare(pin, pinHash).
 */
export function hashPinLookup(clubId: string, pin: string): string {
  return createHmac('sha256', JWT_SECRET).update(`customer-pin:${clubId}:${pin}`).digest('hex');
}

/** P2002 — порушення @@unique([clubId, pinLookupHash]): цей PIN уже чийсь у клубі. */
export function isPinTakenError(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002';
}

/** 30 днів: це "запам'ятати мене" для гравця, не робоча сесія персоналу. */
export function signCustomerToken(auth: Omit<CustomerAuth, 'scope'>) {
  return jwt.sign({ scope: 'customer', ...auth }, JWT_SECRET, { expiresIn: '30d' });
}

export function verifyCustomerToken(token: string): CustomerAuth | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as Partial<CustomerAuth>;
    if (
      payload.scope !== 'customer' ||
      typeof payload.customerId !== 'string' ||
      typeof payload.clubId !== 'string'
    ) {
      return null;
    }
    return { scope: 'customer', customerId: payload.customerId, clubId: payload.clubId };
  } catch {
    return null;
  }
}

/**
 * Той самий патерн, що verifyStepUpPin в admin.ts, але для Customer, а не
 * User — окрема таблиця, окремий delegate, тому окрема (маленька) копія
 * замість спільної абстракції заради двох викликів різних моделей.
 */
export async function verifyCustomerPin(
  customerId: string,
  pin: string,
): Promise<{ ok: true } | { ok: false; reason: 'LOCKED' | 'NOT_SET' | 'INVALID_PIN' }> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { pinHash: true, pinFails: true, pinLockedUntil: true },
  });

  if (!customer) return { ok: false, reason: 'NOT_SET' };

  if (customer.pinLockedUntil && customer.pinLockedUntil > new Date()) {
    return { ok: false, reason: 'LOCKED' };
  }

  if (!customer.pinHash) return { ok: false, reason: 'NOT_SET' };

  const valid = await bcrypt.compare(pin, customer.pinHash);

  if (!valid) {
    const fails = customer.pinFails + 1;
    const locked = fails >= MAX_PIN_FAILS;
    await prisma.customer.update({
      where: { id: customerId },
      data: {
        pinFails: fails,
        pinLockedUntil: locked ? new Date(Date.now() + PIN_LOCK_MINUTES * 60_000) : undefined,
      },
    });
    return { ok: false, reason: 'INVALID_PIN' };
  }

  if (customer.pinFails > 0 || customer.pinLockedUntil) {
    await prisma.customer.update({
      where: { id: customerId },
      data: { pinFails: 0, pinLockedUntil: null },
    });
  }

  return { ok: true };
}
