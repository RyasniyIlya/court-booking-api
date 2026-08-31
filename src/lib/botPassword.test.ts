import { describe, it, expect } from 'vitest';

import { MAX_LEN, MIN_LEN, parseNewPassword, passwordProblem } from './botPassword';

/**
 * Сам обмін із базою тут не перевіряємо — це робота інтеграційних тестів.
 * Перевіряємо рівно те, що вирішує долю пароля до походу в базу: розбір
 * команди і межі, які мусять збігатися з формою кабінету.
 */

describe('parseNewPassword', () => {
  it('бере весь хвіст команди', () => {
    expect(parseNewPassword(['новий-пароль'])).toBe('новий-пароль');
  });

  it('пароль із пробілами лишається цілим', () => {
    /* Та сама причина, що й у parseLogin: «два слова» не має
       перетворитись на «два». */
    expect(parseNewPassword(['два', 'слова', 'разом'])).toBe('два слова разом');
  });

  it('порожній аргумент — це не пароль', () => {
    expect(parseNewPassword([])).toBeNull();
    expect(parseNewPassword(['   '])).toBeNull();
  });
});

describe('межі пароля', () => {
  it('нормальний проходить', () => {
    expect(passwordProblem('x'.repeat(MIN_LEN))).toBeNull();
    expect(passwordProblem('x'.repeat(MAX_LEN))).toBeNull();
  });

  it('закороткий не проходить', () => {
    /* Дзеркалить z.string().min(8) у routes/admin/auth.ts: бот не має
       пускати пароль, з яким потім не вийде увійти в кабінет. */
    expect(passwordProblem('x'.repeat(MIN_LEN - 1))).toContain(String(MIN_LEN));
  });

  it('задовгий не проходить', () => {
    expect(passwordProblem('x'.repeat(MAX_LEN + 1))).toContain(String(MAX_LEN));
  });
});
