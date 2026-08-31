import { describe, it, expect, beforeEach } from 'vitest';
import { clearFails, lockRemaining, noteFail, resetThrottle, menuFor } from './botAuth';
import { parseLogin } from './botHandlers';

/**
 * Чат із ботом — це форма входу без жодного обмеження швидкості з боку
 * Telegram. Лічильник спроб тут єдине, що стоїть між паролем власника і
 * перебором, тому перевіряємо його окремо від бази.
 */

describe('обмеження спроб входу', () => {
  beforeEach(resetThrottle);

  it('чистий чат не заблокований', () => {
    expect(lockRemaining('chat-1')).toBe(0);
  });

  it('чотири промахи ще пускають', () => {
    for (let i = 0; i < 4; i += 1) expect(noteFail('chat-1')).toBe(false);
    expect(lockRemaining('chat-1')).toBe(0);
  });

  it('пʼятий промах замикає на 15 хвилин', () => {
    for (let i = 0; i < 4; i += 1) noteFail('chat-1');
    expect(noteFail('chat-1')).toBe(true);
    expect(lockRemaining('chat-1')).toBeGreaterThan(14 * 60_000);
  });

  it('блокування минає з часом', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) noteFail('chat-1', now);
    expect(lockRemaining('chat-1', now + 16 * 60_000)).toBe(0);
  });

  it('чати рахуються окремо', () => {
    for (let i = 0; i < 5; i += 1) noteFail('chat-1');
    expect(lockRemaining('chat-2')).toBe(0);
  });

  it('успішний вхід стирає промахи', () => {
    for (let i = 0; i < 3; i += 1) noteFail('chat-1');
    clearFails('chat-1');
    for (let i = 0; i < 4; i += 1) expect(noteFail('chat-1')).toBe(false);
  });
});

describe('parseLogin', () => {
  it('розбирає пошту й пароль', () => {
    expect(parseLogin(['owner@club.ua', 'secret'])).toEqual({
      email: 'owner@club.ua',
      password: 'secret',
    });
  });

  it('пароль із пробілами лишається цілим', () => {
    /* Інакше «два слова» перетворилось би на «два» і людина отримала б
       невірний пароль без жодного пояснення. */
    expect(parseLogin(['owner@club.ua', 'два', 'слова'])?.password).toBe('два слова');
  });

  it('без пароля — нічого', () => {
    expect(parseLogin(['owner@club.ua'])).toBeNull();
  });

  it('перший аргумент має бути поштою', () => {
    expect(parseLogin(['owner', 'secret'])).toBeNull();
  });

  it('порожні аргументи не проходять', () => {
    expect(parseLogin([])).toBeNull();
  });
});

describe('меню за роллю', () => {
  it('тренер не бачить грошових команд', () => {
    const menu = menuFor('TRAINER');
    expect(menu).not.toContain('/week');
    expect(menu).not.toContain('/yesterday');
  });

  it('власник бачить', () => {
    expect(menuFor('OWNER')).toContain('/week');
  });
});
