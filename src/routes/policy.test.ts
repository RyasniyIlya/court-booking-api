import { describe, it, expect } from 'vitest';
import { tierOf } from './analytics';
import { canCancelNow } from './public';

/**
 * Правила, за якими кабінет ухвалює рішення про людей і гроші.
 *
 * Обидві функції чисті й приймають `now` параметром саме для цього: правило
 * «за пʼять годин до початку» неможливо перевірити, якщо тест залежить від
 * системного годинника.
 */

const NOW = new Date('2026-08-25T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const minutesFromNow = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe('tierOf — сегмент клієнта за відвідуваннями', () => {
  const longKnown = daysAgo(200);

  it('був учора — ходить', () => {
    expect(tierOf(daysAgo(1), longKnown, NOW)).toBe('ACTIVE');
  });

  it('рівно на межі 30 днів ще ходить', () => {
    expect(tierOf(daysAgo(30), longKnown, NOW)).toBe('ACTIVE');
  });

  it('через місяць після межі — згасає', () => {
    expect(tierOf(daysAgo(45), longKnown, NOW)).toBe('FADING');
  });

  it('рівно на межі 90 днів ще згасає, а не зник', () => {
    expect(tierOf(daysAgo(90), longKnown, NOW)).toBe('FADING');
  });

  it('понад три місяці — зник', () => {
    expect(tierOf(daysAgo(120), longKnown, NOW)).toBe('LOST');
  });

  /* NEW і LOST розділені навмисно: людина, яка записалась учора і ще не
     була, і людина, яка зникла пів року тому, — це різні розмови. */
  it('щойно завів картку і ще не був — новачок, а не втрачений', () => {
    expect(tierOf(null, daysAgo(3), NOW)).toBe('NEW');
  });

  it('картці пів року, візитів так і не було — втрачений', () => {
    expect(tierOf(null, daysAgo(200), NOW)).toBe('LOST');
  });

  it('новачок перестає бути новачком рівно тоді, коли й активний', () => {
    expect(tierOf(null, daysAgo(30), NOW)).toBe('NEW');
    expect(tierOf(null, daysAgo(31), NOW)).toBe('LOST');
  });
});

describe('canCancelNow — вікно самостійного скасування', () => {
  /* cutoff = 0 означає «до самого початку»: рівно та поведінка, що була
     до появи налаштування, тож наявним клубам нічого не змінилось. */
  describe('вікно вимкнено (0)', () => {
    it('за хвилину до початку ще можна', () => {
      // canCancelNow бере Date.now(), тому рахуємо від справжнього «зараз»
      expect(canCancelNow(minutesFromNowReal(1), 0)).toBe(true);
    });

    it('після початку вже ні', () => {
      expect(canCancelNow(minutesFromNowReal(-1), 0)).toBe(false);
    });
  });

  describe('вікно 5 годин', () => {
    const FIVE_H = 300;

    it('за добу до початку — можна', () => {
      expect(canCancelNow(minutesFromNowReal(24 * 60), FIVE_H)).toBe(true);
    });

    it('за шість годин — ще можна', () => {
      expect(canCancelNow(minutesFromNowReal(6 * 60), FIVE_H)).toBe(true);
    });

    it('за три години — вже пізно', () => {
      expect(canCancelNow(minutesFromNowReal(3 * 60), FIVE_H)).toBe(false);
    });

    it('рівно на межі вікна — пізно', () => {
      // Межа належить клубу: інакше «за 5 годин» означало б «і трошки менше»
      expect(canCancelNow(minutesFromNowReal(FIVE_H), FIVE_H)).toBe(false);
    });

    it('заняття вже почалось — тим паче пізно', () => {
      expect(canCancelNow(minutesFromNowReal(-10), FIVE_H)).toBe(false);
    });
  });
});

/** Хвилини від СПРАВЖНЬОГО зараз — canCancelNow читає Date.now() всередині */
function minutesFromNowReal(n: number) {
  return new Date(Date.now() + n * 60_000);
}

/* Прибираємо попередження про невикористаний хелпер: він лишається
   документацією для tierOf, який `now` таки приймає. */
void minutesFromNow;
