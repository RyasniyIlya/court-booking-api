import { describe, expect, it } from 'vitest';
import { FOP3_LIMIT, FOP3_RATES } from './cashbook';
import {
  estimateTax,
  monthsOverlapped,
  regimeLimitUsage,
  taxLimit,
  vatApplicable,
  type TaxExpenseLike,
} from './taxRegime';

const TZ = 'Europe/Kyiv';

const base = {
  vatPayer: false,
  taxFixedMonthly: null as number | null,
  expenses: [] as TaxExpenseLike[],
  from: new Date('2026-05-01T00:00:00+03:00'),
  to: new Date('2026-05-31T23:59:59.999+03:00'),
  tz: TZ,
};

describe('ліміт', () => {
  it('FOP_3 2026 збігається з FOP3_LIMIT у cashbook.ts — одне число, два місця', () => {
    expect(taxLimit('FOP_3', 2026)).toBe(FOP3_LIMIT[2026]);
  });

  it('FOP_1 і FOP_2 мають свої множники', () => {
    expect(taxLimit('FOP_1', 2026)).toBe(167 * 864_700);
    expect(taxLimit('FOP_2', 2026)).toBe(834 * 864_700);
    expect(taxLimit('TOV_SINGLE_3', 2026)).toBe(1167 * 864_700);
  });

  it('без ліміту для загальних систем', () => {
    expect(taxLimit('FOP_GENERAL', 2026)).toBeNull();
    expect(taxLimit('TOV_GENERAL', 2026)).toBeNull();
  });

  it('невідомий рік — без ліміту, а не минулорічний', () => {
    expect(taxLimit('FOP_3', 2031)).toBeNull();
    expect(regimeLimitUsage('FOP_3', 100, 2031)).toBeNull();
  });

  it('regimeLimitUsage рахує відсоток так само, як cashbook.limitUsage', () => {
    expect(regimeLimitUsage('FOP_3', 100_910_490, 2026)?.pct).toBe(10);
  });
});

describe('FOP_3 — регресія проти сьогоднішньої каси', () => {
  it('5% + 1% від доходу без ПДВ-режиму — ті самі цифри, що й taxEstimate', () => {
    const r = estimateTax({ ...base, regime: 'FOP_3', income: 1_000_000 });
    expect(r.vatPayer).toBe(false);
    expect(r.base).toBe(1_000_000);
    expect(r.lines).toEqual([
      { key: 'single', label: 'Єдиний податок', rate: '5%', amount: 50_000 },
      { key: 'military', label: 'Військовий збір', rate: '1%', amount: 10_000 },
    ]);
    expect(r.total).toBe(60_000);
  });

  it('відʼємний дохід не дає відʼємного податку', () => {
    const r = estimateTax({ ...base, regime: 'FOP_3', income: -500 });
    expect(r.total).toBe(0);
  });

  it('платник ПДВ — 3% і 1% від тієї самої бази без ПДВ (не від повної суми)', () => {
    const income = 120_000; // 100 000 без ПДВ + 20 000 ПДВ
    const r = estimateTax({ ...base, regime: 'FOP_3', vatPayer: true, income });
    expect(r.base).toBe(100_000);
    expect(r.lines.find((l) => l.key === 'single')).toEqual({ key: 'single', label: 'Єдиний податок', rate: '3%', amount: 3_000 });
    expect(r.lines.find((l) => l.key === 'military')).toEqual({ key: 'military', label: 'Військовий збір', rate: '1%', amount: 1_000 });
    expect(r.notes).toContain('ПДВ не оцінюється — його рахує бухгалтер.');
  });

  it('платник ПДВ — обидва рядки рахуються від однієї бази, не від різних сум', () => {
    const income = 240_000; // 200 000 без ПДВ + 40 000 ПДВ
    const r = estimateTax({ ...base, regime: 'FOP_3', vatPayer: true, income });
    const single = r.lines.find((l) => l.key === 'single');
    const military = r.lines.find((l) => l.key === 'military');
    expect(r.base).toBe(200_000);
    expect(single.amount).toBe(Math.round(r.base * 0.03));
    expect(military.amount).toBe(Math.round(r.base * FOP3_RATES.military));
  });

  it('прапорець ПДВ ігнорується там, де він не застосовний', () => {
    expect(vatApplicable('FOP_1')).toBe(false);
    const r = estimateTax({ ...base, regime: 'FOP_1', vatPayer: true, income: 0 });
    expect(r.vatPayer).toBe(false);
    expect(r.notes).not.toContain('ПДВ не оцінюється — його рахує бухгалтер.');
  });
});

describe('TOV_SINGLE_3', () => {
  it('5% доходу, без військового збору', () => {
    const r = estimateTax({ ...base, regime: 'TOV_SINGLE_3', income: 1_000_000 });
    expect(r.lines).toEqual([{ key: 'single', label: 'Єдиний податок', rate: '5%', amount: 50_000 }]);
    expect(r.notes).toContain('Юридична особа — військовий збір не сплачується.');
  });

  it('платник ПДВ — 3% від бази без ПДВ', () => {
    const r = estimateTax({ ...base, regime: 'TOV_SINGLE_3', vatPayer: true, income: 120_000 });
    expect(r.base).toBe(100_000);
    expect(r.total).toBe(3_000);
  });
});

describe('фіксовані режими FOP_1 / FOP_2', () => {
  it('FOP_1: типова ставка — 10% прожиткового мінімуму й 10% мінімалки за місяць', () => {
    const r = estimateTax({ ...base, regime: 'FOP_1', income: 0 });
    expect(r.lines).toEqual([
      { key: 'single', label: 'Єдиний податок (фіксовано)', amount: 33_280 },
      { key: 'military', label: 'Військовий збір (фіксовано)', amount: 86_470 },
    ]);
    expect(r.total).toBe(119_750);
    expect(r.base).toBe(0);
  });

  it('FOP_2: типова ставка — 20% мінімалки, той самий збір', () => {
    const r = estimateTax({ ...base, regime: 'FOP_2', income: 0 });
    expect(r.lines).toEqual([
      { key: 'single', label: 'Єдиний податок (фіксовано)', amount: 172_940 },
      { key: 'military', label: 'Військовий збір (фіксовано)', amount: 86_470 },
    ]);
  });

  it('taxFixedMonthly перекриває тільки єдиний податок, не збір', () => {
    const r = estimateTax({ ...base, regime: 'FOP_1', taxFixedMonthly: 50_000, income: 0 });
    expect(r.lines.find((l) => l.key === 'single')?.amount).toBe(50_000);
    expect(r.lines.find((l) => l.key === 'military')?.amount).toBe(86_470);
  });

  it('період на два місяці — множник 2, а не дні', () => {
    const from = new Date('2026-05-20T00:00:00+03:00');
    const to = new Date('2026-06-05T23:59:59.999+03:00');
    expect(monthsOverlapped(from, to, TZ)).toBe(2);
    const r = estimateTax({ ...base, regime: 'FOP_1', income: 0, from, to });
    expect(r.lines.find((l) => l.key === 'single')?.amount).toBe(33_280 * 2);
    expect(r.lines.find((l) => l.key === 'military')?.amount).toBe(86_470 * 2);
  });

  it('один календарний день — усе одно цілий місяць', () => {
    const day = new Date('2026-05-15T12:00:00+03:00');
    expect(monthsOverlapped(day, day, TZ)).toBe(1);
  });

  it('невідомий рік — ставки не вигадуються, є пояснення в notes', () => {
    const from = new Date('2031-05-01T00:00:00+03:00');
    const to = new Date('2031-05-31T23:59:59.999+03:00');
    const r = estimateTax({ ...base, regime: 'FOP_1', income: 0, from, to });
    expect(r.lines).toEqual([]);
    expect(r.notes.some((n) => n.includes('2031'))).toBe(true);
  });
});

describe('прибуткові режими FOP_GENERAL / TOV_GENERAL', () => {
  const expenses: TaxExpenseLike[] = [
    { category: 'RENT', amount: 200_000 },
    { category: 'SALARY', amount: 100_000 },
    { category: 'TAX', amount: 999_999 }, // не має впливати на базу
  ];

  it('FOP_GENERAL: 18% ПДФО + 5% збору від прибутку, TAX виключено', () => {
    const r = estimateTax({ ...base, regime: 'FOP_GENERAL', income: 1_000_000, expenses });
    expect(r.base).toBe(700_000); // 1 000 000 − 300 000 (без TAX)
    expect(r.lines).toEqual([
      { key: 'pdfo', label: 'ПДФО', rate: '18%', amount: 126_000 },
      { key: 'military', label: 'Військовий збір', rate: '5%', amount: 35_000 },
    ]);
    expect(r.notes).not.toContain('За період не внесено жодної витрати клубу — база може бути завищена.');
  });

  it('TOV_GENERAL: 18% від прибутку, без військового збору', () => {
    const r = estimateTax({ ...base, regime: 'TOV_GENERAL', income: 1_000_000, expenses });
    expect(r.base).toBe(700_000);
    expect(r.lines).toEqual([{ key: 'profit', label: 'Податок на прибуток', rate: '18%', amount: 126_000 }]);
    expect(r.notes).toContain('Юридична особа — військовий збір не сплачується.');
  });

  it('без жодної витрати (крім TAX) — прапорець про завищену базу', () => {
    const r = estimateTax({ ...base, regime: 'FOP_GENERAL', income: 1_000_000, expenses: [{ category: 'TAX', amount: 60_000 }] });
    expect(r.base).toBe(1_000_000);
    expect(r.notes).toContain('За період не внесено жодної витрати клубу — база може бути завищена.');
  });

  it('прибуток не буває відʼємним', () => {
    const r = estimateTax({ ...base, regime: 'FOP_GENERAL', income: 100, expenses: [{ category: 'RENT', amount: 100_000 }] });
    expect(r.base).toBe(0);
    expect(r.total).toBe(0);
  });

  it('без ліміту для загальних систем', () => {
    expect(regimeLimitUsage('FOP_GENERAL', 999_999_999, 2026)).toBeNull();
    expect(regimeLimitUsage('TOV_GENERAL', 999_999_999, 2026)).toBeNull();
  });
});

describe('узгодженість із FOP3_RATES (єдине джерело для 3 групи)', () => {
  it('ставки FOP_3 без ПДВ — саме ті, що в cashbook.ts', () => {
    const r = estimateTax({ ...base, regime: 'FOP_3', income: 1_000_000 });
    expect(r.lines[0].amount).toBe(Math.round(1_000_000 * FOP3_RATES.singleTax));
    expect(r.lines[1].amount).toBe(Math.round(1_000_000 * FOP3_RATES.military));
  });
});
