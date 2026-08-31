import { describe, it, expect } from 'vitest';
import { barChart } from './charts';

/**
 * Графік у месенджері — це просто рядки, і зламати їх легко: одна зайва
 * восьма блока, і стовпчики поїдуть. Тому перевіряємо саме форму.
 */

describe('barChart', () => {
  const rows = [
    { label: 'Пн', value: 100 },
    { label: 'Вт', value: 50 },
    { label: 'Ср', value: 0 },
  ];

  it('найбільше значення займає всю ширину', () => {
    const [first] = barChart(rows, { width: 8 }).split('\n');
    expect(first).toContain('████████');
  });

  it('половина займає половину', () => {
    const second = barChart(rows, { width: 8 }).split('\n')[1];
    expect(second.replace(/[^█▏▎▍▌▋▊▉]/g, '')).toBe('████');
  });

  it('нуль лишається порожнім', () => {
    const third = barChart(rows, { width: 8 }).split('\n')[2];
    expect(third).not.toContain('█');
    expect(third).toContain('0');
  });

  it('ненульове, але мале, отримує хоч якийсь слід', () => {
    /* Інакше день з однією бронню виглядав би так само, як порожній —
       а це різні дні. */
    const line = barChart(
      [{ label: 'a', value: 1000 }, { label: 'b', value: 1 }],
      { width: 10 },
    ).split('\n')[1];

    expect(line).toMatch(/[▏▎▍▌▋▊▉█]/);
  });

  it('числа вирівняні по правому краю — розряд під розрядом', () => {
    /* «890» і «8 900» мають закінчуватись в одній колонці, інакше очима
       їх не порівняти. Однакова довжина рядків — це саме воно. */
    const lines = barChart(
      [{ label: 'a', value: 8900 }, { label: 'b', value: 890 }],
      { width: 8 },
    ).split('\n');

    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
    expect(lines[1]).toMatch(/ 890$/);
  });

  it('підписи різної довжини вирівнюються — стовпчики починаються з однієї колонки', () => {
    const lines = barChart(
      [{ label: 'Пн 25.08', value: 2 }, { label: 'Ср 1.09', value: 1 }],
      { width: 4 },
    ).split('\n');

    const barStart = (l: string) => l.search(/[▏▎▍▌▋▊▉█]/);
    expect(barStart(lines[0])).toBe(barStart(lines[1]));
  });

  it('порожній список не падає', () => {
    expect(barChart([])).toBe('');
  });

  it('усі нулі не діляться на нуль', () => {
    const out = barChart([{ label: 'a', value: 0 }, { label: 'b', value: 0 }], { width: 5 });
    expect(out).not.toContain('NaN');
    expect(out).not.toContain('█');
  });

  it('format задає, як показати число', () => {
    const out = barChart([{ label: 'a', value: 420_000 }], { format: (v) => `${v / 100} грн` });
    expect(out).toContain('4200 грн');
  });
});
