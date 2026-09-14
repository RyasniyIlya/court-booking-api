import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { prisma } from './db';

/**
 * Пароль профілю гравця.
 *
 * Досі в профіль на сайті пускали за телефоном і датою народження. Дату
 * знає пів компанії друзів і будь-хто з Instagram — тож «увійти» в чужий
 * профіль, накидати броней чи скасувати чужу гру міг практично хто
 * завгодно. Тепер акаунт — це картка з паролем, і створюється він тільки
 * разом із паролем.
 *
 * Дата народження лишається даними профілю (акція на день народження), але
 * дверей у профіль більше не відчиняє.
 */

/** 8 символів — нижня межа, яку ще реально запамʼятати; 128 — щоб bcrypt не різав мовчки. */
export const passwordText = z.string().min(8).max(128);

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

export const hashCustomerPassword = (password: string) => bcrypt.hash(password, 10);

export type CustomerPasswordCheck =
  | { ok: true }
  | { ok: false; reason: 'NOT_SET' | 'LOCKED' | 'INVALID' };

/**
 * Перевірити пароль із блокуванням після п'яти промахів поспіль — рівно як
 * у персоналу (verifyAccountPassword). Лімітер по IP лишається зверху, але
 * від перебору з багатьох адрес захищає саме лічильник на картці.
 */
export async function verifyCustomerPassword(customerId: string, password: string): Promise<CustomerPasswordCheck> {
  const c = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { passwordHash: true, passwordFails: true, passwordLockedUntil: true },
  });

  if (!c?.passwordHash) return { ok: false, reason: 'NOT_SET' };
  if (c.passwordLockedUntil && c.passwordLockedUntil > new Date()) return { ok: false, reason: 'LOCKED' };

  if (!(await bcrypt.compare(password, c.passwordHash))) {
    const fails = c.passwordFails + 1;
    await prisma.customer.update({
      where: { id: customerId },
      data: {
        passwordFails: fails >= MAX_FAILS ? 0 : fails,
        passwordLockedUntil: fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : undefined,
      },
    });
    return { ok: false, reason: 'INVALID' };
  }

  if (c.passwordFails > 0 || c.passwordLockedUntil) {
    await prisma.customer.update({
      where: { id: customerId },
      data: { passwordFails: 0, passwordLockedUntil: null },
    });
  }
  return { ok: true };
}
