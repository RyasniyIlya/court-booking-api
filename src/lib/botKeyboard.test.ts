import { describe, it, expect } from 'vitest';
import {
  COMMANDS_GUEST,
  commandForLabel,
  commandsFor,
  dayButtons,
  parseAction,
  replyKeyboard,
  periodButtons,
} from './botKeyboard';

/**
 * Кнопки — найтихіший спосіб щось зламати: підпис змінили, таблицю ні, і
 * бот мовчки перестає розуміти власну ж кнопку. Помилки при цьому ніде
 * не буде. Тому тут перевіряється саме звʼязок «напис — команда».
 */

describe('кнопка -> команда', () => {
  it('кожна кнопка клавіатури власника має обробник', () => {
    for (const row of replyKeyboard('OWNER').keyboard) {
      for (const btn of row) {
        expect(commandForLabel(btn.text), `кнопка «${btn.text}» нікуди не веде`).not.toBeNull();
      }
    }
  });

  it('кожна кнопка клавіатури тренера має обробник', () => {
    for (const row of replyKeyboard('TRAINER').keyboard) {
      for (const btn of row) {
        expect(commandForLabel(btn.text), `кнопка «${btn.text}» нікуди не веде`).not.toBeNull();
      }
    }
  });

  it('звичайний текст лишається текстом', () => {
    expect(commandForLabel('привіт')).toBeNull();
  });

  it('зайві пробіли не ламають розпізнавання', () => {
    expect(commandForLabel('  📈 Тиждень ')).toBe('/week');
  });
});

describe('клавіатура за роллю', () => {
  it('тренер не бачить кнопок про гроші', () => {
    const labels = replyKeyboard('TRAINER').keyboard.flat().map((b) => b.text).join(' ');
    expect(labels).not.toContain('Тиждень');
    expect(labels).not.toContain('Вчора');
  });

  it('власник бачить', () => {
    const labels = replyKeyboard('OWNER').keyboard.flat().map((b) => b.text).join(' ');
    expect(labels).toContain('Тиждень');
  });

  it('клавіатура не займає пів екрана', () => {
    expect(replyKeyboard('OWNER').resize_keyboard).toBe(true);
  });
});

describe('parseAction — дані приходять від клієнта, тобто можуть бути чим завгодно', () => {
  it('розбирає день і тиждень', () => {
    expect(parseAction('day:0')).toEqual({ kind: 'day', offset: 0 });
    expect(parseAction('week:14')).toEqual({ kind: 'week', days: 14 });
  });

  it('невідомий період не проходить', () => {
    /* Інакше кнопка з підробленими даними перетворилась би на запит до
       бази за довільний відрізок. */
    expect(parseAction('week:99999')).toBeNull();
  });

  it('відʼємний і нечисловий зсув не проходять', () => {
    expect(parseAction('day:-5')).toBeNull();
    expect(parseAction('day:абв')).toBeNull();
  });

  it('сміття і порожнеча не падають', () => {
    expect(parseAction(undefined)).toBeNull();
    expect(parseAction('')).toBeNull();
    expect(parseAction('drop table')).toBeNull();
  });
});

describe('кнопки під звітом ведуть у робочі дії', () => {
  const data = (m: { inline_keyboard: { callback_data: string }[][] }) =>
    m.inline_keyboard.flat().map((b) => b.callback_data);

  it('усе, що намальовано під днем, розбирається назад', () => {
    for (const d of data(dayButtons(0))) expect(parseAction(d)).not.toBeNull();
  });

  it('усе, що намальовано під звітом розділу, розбирається назад', () => {
    for (const section of ['week', 'staff', 'money'] as const) {
      for (const d of data(periodButtons(section, 7))) {
        expect(parseAction(d), `${section}: ${d}`).not.toBeNull();
      }
    }
  });

  it('поточний період позначено, решта — ні', () => {
    const marked = periodButtons('week', 14).inline_keyboard[0].filter((b) => b.text.includes('·'));
    expect(marked).toHaveLength(1);
    expect(marked[0].callback_data).toBe('week:14');
  });

  it('перехід у сусідній розділ зберігає період', () => {
    /* Дивився чотири тижні виручки, тиснеш «Персонал» — хочеш тих самих
       чотирьох тижнів, а не скидання на тиждень. */
    expect(data(periodButtons('money', 28))).toContain('staff:28');
    expect(data(periodButtons('money', 28))).toContain('week:28');
  });

  it('розділ не пропонує перейти сам у себе', () => {
    const links = periodButtons('staff', 7).inline_keyboard[1].map((b) => b.text);
    expect(links.join(' ')).not.toContain('Персонал');
  });

  it('під сьогоднішнім днем пропонують учора, і навпаки', () => {
    expect(data(dayButtons(0))).toContain('day:1');
    expect(data(dayButtons(1))).toContain('day:0');
  });
});

describe('меню «/»', () => {
  it('незнайомий чат бачить тільки вхід', () => {
    const cmds = COMMANDS_GUEST.map((c) => c.command);
    expect(cmds).toContain('login');
    expect(cmds).not.toContain('week');
  });

  it('тренеру не показують /week, якого йому все одно не дадуть', () => {
    expect(commandsFor('TRAINER').map((c) => c.command)).not.toContain('week');
  });

  it('команди без слеша — Telegram додасть його сам', () => {
    for (const c of [...commandsFor('OWNER'), ...COMMANDS_GUEST]) {
      expect(c.command).not.toContain('/');
      expect(c.command).toMatch(/^[a-z_]{1,32}$/);
    }
  });
});
