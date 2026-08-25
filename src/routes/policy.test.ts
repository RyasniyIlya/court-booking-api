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
  /* Постійний клієнт: візитів більше за поріг новачка. Береться скрізь, де
     тест про СТРОКИ, а не про кількість занять, — інакше кожна перевірка
     меж у днях мовчки перевіряла б заразом і новачка. */
  const regular = 20;

  it('був учора — ходить', () => {
    expect(tierOf(daysAgo(1), longKnown, NOW, regular)).toBe('ACTIVE');
  });

  it('рівно на межі 30 днів ще ходить', () => {
    expect(tierOf(daysAgo(30), longKnown, NOW, regular)).toBe('ACTIVE');
  });

  it('через місяць після межі — згасає', () => {
    expect(tierOf(daysAgo(45), longKnown, NOW, regular)).toBe('FADING');
  });

  it('рівно на межі 90 днів ще згасає, а не зник', () => {
    expect(tierOf(daysAgo(90), longKnown, NOW, regular)).toBe('FADING');
  });

  it('понад три місяці — зник', () => {
    expect(tierOf(daysAgo(120), longKnown, NOW, regular)).toBe('LOST');
  });

  /* NEW і LOST розділені навмисно: людина, яка записалась учора і ще не
     була, і людина, яка зникла пів року тому, — це різні розмови. */
  it('щойно завів картку і ще не був — новачок, а не втрачений', () => {
    expect(tierOf(null, daysAgo(3), NOW)).toBe('NEW');
  });

  it('картці пів року, візитів так і не було — втрачений', () => {
    expect(tierOf(null, daysAgo(200), NOW)).toBe('LOST');
  });

  it('той, хто так і не дійшов, перестає бути новачком разом з активними', () => {
    expect(tierOf(null, daysAgo(30), NOW)).toBe('NEW');
    expect(tierOf(null, daysAgo(31), NOW)).toBe('LOST');
  });

  /* ── Новачок — це перші пʼять занять ──────────────────────────────────
     Раніше сегмент зникав рівно тоді, коли з людиною вперше можна було
     поговорити про клуб: сходив один раз — і вже «активний». */
  describe('перші пʼять занять', () => {
    it('перший візит — новачок, а не активний', () => {
      expect(tierOf(daysAgo(1), daysAgo(2), NOW, 1)).toBe('NEW');
    });

    it('пʼятий візит ще новачок', () => {
      expect(tierOf(daysAgo(1), daysAgo(40), NOW, 5)).toBe('NEW');
    });

    it('шостий — уже свій', () => {
      expect(tierOf(daysAgo(1), daysAgo(40), NOW, 6)).toBe('ACTIVE');
    });

    /* Найважливіший рядок цього блоку. Новачок, який сходив двічі й
       пропав, — це найдорожчий дзвінок у картотеці. Лишившись у
       «новачках», він виглядав би як людина, яку просто ще не встигли
       зустріти, і не потрапив би в жоден список на обдзвін. */
    it('новачок, який пропав, стає згасаючим, а не лишається новачком', () => {
      expect(tierOf(daysAgo(45), daysAgo(60), NOW, 2)).toBe('FADING');
    });

    it('новачок, який пропав надовго, — втрачений', () => {
      expect(tierOf(daysAgo(120), daysAgo(140), NOW, 3)).toBe('LOST');
    });

    /* Строки старші за кількість: спершу «чи ходить», потім «чи новачок».
       Порядок перевірок у tierOf саме такий, і ось рядок, який упаде,
       якщо його колись переставлять. */
    it('межі в днях рахуються раніше за кількість візитів', () => {
      expect(tierOf(daysAgo(31), longKnown, NOW, 1)).toBe('FADING');
      expect(tierOf(daysAgo(30), longKnown, NOW, 1)).toBe('NEW');
    });
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
