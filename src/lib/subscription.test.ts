import { describe, it, expect } from 'vitest';

import { nextPeriod, periodStart, periodAmount } from './subscription';
import { PERIOD_PRICE } from './billing';

const NOW = new Date('2026-09-02T10:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('periodStart', () => {
  it('оплачено наперед — продовжуємо від кінця, дні не згорають', () => {
    expect(periodStart(day('2026-09-20'), NOW)).toEqual(day('2026-09-20'));
  });

  it('строк вийшов — рахуємо від сьогодні, за простій не беремо', () => {
    expect(periodStart(day('2026-05-01'), NOW)).toEqual(NOW);
  });

  it('ніколи не платили — від сьогодні', () => {
    expect(periodStart(null, NOW)).toEqual(NOW);
  });
});

describe('nextPeriod', () => {
  it('місяць від сьогодні для нового клуба', () => {
    const { from, to } = nextPeriod(null, 'MONTH', NOW);
    expect(from).toEqual(NOW);
    expect(ymd(to)).toBe('2026-10-02');
  });

  it('рік поверх діючої оплати', () => {
    const { from, to } = nextPeriod(day('2026-10-01'), 'YEAR', NOW);
    expect(ymd(from)).toBe('2026-10-01');
    expect(ymd(to)).toBe('2027-10-01');
  });
});

describe('periodAmount', () => {
  const monthPlan = { price: 400_00, period: 'MONTH' };

  it('без плану — прайс за період', () => {
    expect(periodAmount(null, null, 'YEAR')).toBe(PERIOD_PRICE.YEAR);
  });

  it('ціна плану за свій період', () => {
    expect(periodAmount(monthPlan, null, 'MONTH')).toBe(400_00);
  });

  it('індивідуальна ціна б’є план', () => {
    expect(periodAmount(monthPlan, 250_00, 'MONTH')).toBe(250_00);
  });

  it('нуль — теж ціна, а не «не задано»', () => {
    expect(periodAmount(monthPlan, 0, 'MONTH')).toBe(0);
  });

  /* Головна пастка: план на 400 грн/місяць не означає 400 грн за рік. */
  it('інший період — прайс за нього, а не ціна плану', () => {
    expect(periodAmount(monthPlan, null, 'YEAR')).toBe(PERIOD_PRICE.YEAR);
    expect(periodAmount(monthPlan, 250_00, 'YEAR')).toBe(PERIOD_PRICE.YEAR);
  });
});
