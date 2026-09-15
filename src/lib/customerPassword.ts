import { hashPassword } from './passwordHash';
import { checkPassword } from './passwordCheck';
import { z } from 'zod';


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

/** Versioned SHA-256 prehash preserves the whole password, including Unicode. */
export const passwordText = z.string().min(8).max(128);

export const hashCustomerPassword = (password: string) => hashPassword(password, 10);

export type CustomerPasswordCheck =
  | { ok: true }
  | { ok: false; reason: 'NOT_SET' | 'LOCKED' | 'INVALID' };

/**
 * Перевірити пароль із блокуванням після п'яти промахів поспіль — рівно як
 * у персоналу (verifyAccountPassword). Лімітер по IP лишається зверху, але
 * від перебору з багатьох адрес захищає саме лічильник на картці.
 */
export async function verifyCustomerPassword(customerId: string, password: string): Promise<CustomerPasswordCheck> {
  return checkPassword('customer', customerId, password);
}
