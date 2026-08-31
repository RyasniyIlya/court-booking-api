import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { kopShort, trend, weekText, type WeekReport } from './digest';

/**
 * Тижневий звіт — те, заради чого власник відкриває бота в понеділок.
 * Перевіряємо текст, а не запит: цифри з бази вже перевірені в digest,
 * а зламатись найлегше саме форматуванню.
 */

const point = (label: string, revenue: number, bookings = 1) => ({
  day: label,
  label,
  revenue,
  bookings,
});

const report: WeekReport = {
  points: [
    point('Пн 25.08', 420_000),
    point('Вт 26.08', 0, 0),
    point('Ср 27.08', 210_000),
  ],
  total: 630_000,
  bookings: 12,
  prevTotal: 500_000,
};

describe('trend', () => {
  it('зростання зі знаком плюс', () => {
    expect(trend(112, 100)).toBe('↑ 12%');
  });

  it('падіння — стрілкою вниз', () => {
    /* Напрямок має читатись раніше за число: у стрічці повідомлень
       дивляться саме на нього. */
    expect(trend(90, 100)).toBe('↓ 10%');
  });

  it('однакові числа — «без змін», а не «+0%»', () => {
    expect(trend(100, 100)).toBe('без змін');
  });

  it('порівнювати з нулем немає сенсу', () => {
    /* Зростання «з нуля до чогось» у відсотках — нескінченність. Краще
       не показати рядок узагалі, ніж показати «+Infinity%». */
    expect(trend(100, 0)).toBeNull();
  });
});

describe('kopShort', () => {
  it('копійки в гривні без дробу', () => {
    /* Роздільник тисяч у uk-UA — нерозривний пробіл, а не звичайний;
       порівнюємо без пробілів, щоб тест не залежав від збірки ICU. */
    expect(kopShort(420_000).replace(/\s/g, '')).toBe('4200');
  });

  it('нуль лишається нулем', () => {
    expect(kopShort(0)).toBe('0');
  });
});

describe('weekText', () => {
  it('графік загорнутий у pre — інакше стовпчики поїдуть', () => {
    expect(weekText('Корт', report)).toContain('<pre>');
  });

  it('показує підсумок, середнє і динаміку', () => {
    const out = weekText('Корт', report);
    expect(out.replace(/\s/g, '')).toContain('6300грн');
    expect(out).toContain('12');
    expect(out).toContain('↑ 26%');
    /* Найкращий день названий вголос: у стовпчиках він видно, але який
       саме це був день, графік сказати не вміє. */
    expect(out).toContain('найкращий Пн 25.08');
  });

  it('порожній тиждень не малює графік із нулів', () => {
    const empty: WeekReport = { points: [], total: 0, bookings: 0, prevTotal: 0 };
    const out = weekText('Корт', empty);
    expect(out).not.toContain('<pre>');
    expect(out).toContain('не було');
  });

  it('без попереднього тижня рядок порівняння зникає, а не показує NaN', () => {
    const out = weekText('Корт', { ...report, prevTotal: 0 });
    expect(out).not.toContain('NaN');
    expect(out).not.toContain('До попередніх');
  });

  it('день без броні лишається в графіку нулем', () => {
    /* Провал у вівторок — це і є те, заради чого дивляться на форму
       кривої. Викинути порожній день означало б приховати провал. */
    expect(weekText('Корт', report)).toContain('Вт 26.08');
  });
});

describe('довгі періоди згортаються в тижні', () => {
  /* 28 рядків у месенджері гортають, а не читають. */
  const month: WeekReport = {
    points: Array.from({ length: 28 }, (_, i) => {
      const d = DateTime.fromISO('2026-08-03').plus({ days: i });
      return point(`Пн ${d.toFormat('dd.MM')}`, 10_000 * (i + 1));
    }),
    total: 4_060_000,
    bookings: 90,
    prevTotal: 3_500_000,
  };

  const chartLines = (out: string) =>
    out.split('<pre>')[1].split('</pre>')[0].split('\n');

  it('місяць малюється чотирма рядками, а не двадцятьма вісьмома', () => {
    expect(chartLines(weekText('Корт', month, 28))).toHaveLength(4);
  });

  it('усі стовпчики зібрані з однакової кількості днів', () => {
    /* Обрізок із двох днів поруч із семиденними читався б як провал,
       якого не було — саме тому періоди кратні тижню. */
    const lines = chartLines(weekText('Корт', month, 28));
    expect(lines).toHaveLength(28 / 7);
  });

  it('у згорнутому підписі лишається діапазон дат', () => {
    expect(chartLines(weekText('Корт', month, 28))[0]).toMatch(/\d\d\.\d\d–\d\d\.\d\d/);
  });

  it('довгий період названий тижнями, а не днями', () => {
    expect(weekText('Корт', month, 28)).toContain('останні 4 тижні');
  });

  it('два тижні ще показуються по днях — там форма кривої цінна', () => {
    const two: WeekReport = { ...month, points: month.points.slice(0, 14) };
    expect(chartLines(weekText('Корт', two, 14))).toHaveLength(14);
  });

  it('згортання нічого не губить — сума лишається сумою', () => {
    const out = weekText('Корт', month, 28);
    expect(out.replace(/\s/g, '')).toContain('40600грн');
  });
});

describe('дата в назві точки', () => {
  it('luxon рахує понеділок першим днем тижня', () => {
    /* WEEKDAYS у digest індексується як weekday - 1. Якщо luxon колись
       почне рахувати з неділі, підписи з'їдуть на день. */
    expect(DateTime.fromISO('2026-08-24').weekday).toBe(1);
  });
});
