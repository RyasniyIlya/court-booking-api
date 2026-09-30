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
  it('квартал — три місячні ставки плану', () => {
    expect(periodAmount(monthPlan, null, 'QUARTER')).toBe(1_200_00);
  });

  it('рік — десять місячних ставок: два місяці даруються', () => {
    expect(periodAmount(monthPlan, null, 'YEAR')).toBe(4_000_00);
  });

  it('індивідуальна ціна розтягується на інший період так само', () => {
    expect(periodAmount(monthPlan, 250_00, 'YEAR')).toBe(2_500_00);
  });

  /* Реальні цифри каталогу: план «Броні» за 1199 грн/міс. Загальний прайс
     дав би 5000 грн за рік — менш ніж половину того, що клуб має заплатити. */
  it('план за 1199 грн/міс дає 3597 за квартал і 11990 за рік', () => {
    const plan = { price: 1_199_00, period: 'MONTH' };
    expect(periodAmount(plan, null, 'QUARTER')).toBe(3_597_00);
    expect(periodAmount(plan, null, 'YEAR')).toBe(11_990_00);
    expect(periodAmount(plan, null, 'YEAR')).not.toBe(PERIOD_PRICE.YEAR);
  });

  it('план, записаний за рік, дає свою місячну ставку назад', () => {
    const yearPlan = { price: 12_000_00, period: 'YEAR' };
    expect(periodAmount(yearPlan, null, 'YEAR')).toBe(12_000_00);
    expect(periodAmount(yearPlan, null, 'MONTH')).toBe(1_200_00);
  });
});

describe('periodAmount — корти', () => {
  const plan = { price: 1000_00, period: 'MONTH' };

  it('кортів не задано — суми ті самі, що й до цінника за корти', () => {
    expect(periodAmount(plan, null, 'MONTH', undefined)).toBe(1000_00);
    expect(periodAmount(null, null, 'YEAR', undefined)).toBe(PERIOD_PRICE.YEAR);
  });

  it('до трьох кортів без змін', () => {
    expect(periodAmount(plan, null, 'MONTH', 3)).toBe(1000_00);
  });

  it('7 кортів: місяць 1700 грн', () => {
    expect(periodAmount(plan, null, 'MONTH', 7)).toBe(1700_00);
  });

  it('множиться ціна плану за свій період, далі — звичайний перерахунок', () => {
    expect(periodAmount(plan, null, 'QUARTER', 7)).toBe(5100_00);
    expect(periodAmount(plan, null, 'YEAR', 7)).toBe(17_000_00);
  });

  it('індивідуальна ціна не множиться, у тому числі на інший період', () => {
    expect(periodAmount(plan, 250_00, 'MONTH', 7)).toBe(250_00);
    expect(periodAmount(plan, 250_00, 'YEAR', 7)).toBe(2_500_00);
    expect(periodAmount(null, 250_00, 'MONTH', 7)).toBe(250_00);
  });

  it('без плану й без своєї ціни множиться загальний прайс', () => {
    expect(periodAmount(null, null, 'MONTH', 7)).toBe(1700_00);
    expect(periodAmount(null, null, 'MONTH', 2)).toBe(PERIOD_PRICE.MONTH);
  });

  it('нуль-ціна плану лишається нулем', () => {
    expect(periodAmount({ price: 0, period: 'MONTH' }, null, 'MONTH', 9)).toBe(0);
  });
});
