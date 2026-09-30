import { describe, expect, it } from 'vitest';

import { courtMultiplier, courtPrice, isCustomQuote } from './courtPricing';

const grn = (v: number) => v * 100;

describe('courtPrice', () => {
  it('keeps the plan price exact up to three courts and for unknown count', () => {
    for (const n of [undefined, null, 0, 1, 2, 3]) {
      expect(courtPrice(grn(2500), n)).toBe(grn(2500));
    }
    expect(courtPrice(119_900, 3)).toBe(119_900);
  });

  it('grows along the parabola past three courts, rounded to 50 UAH', () => {
    expect([4, 7, 12].map((n) => courtPrice(grn(1000), n))).toEqual([grn(1150), grn(1700), grn(2850)]);
    expect([4, 7, 12].map((n) => courtPrice(grn(1500), n))).toEqual([grn(1750), grn(2550), grn(4250)]);
    expect([4, 7, 12].map((n) => courtPrice(grn(2500), n))).toEqual([grn(2900), grn(4250), grn(7100)]);
  });

  it('is convex: each extra court costs more than the previous one', () => {
    const steps = [4, 5, 6, 7, 8].map((n) => courtMultiplier(n + 1) - courtMultiplier(n));
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThan(steps[i - 1]);
  });

  it('leaves a free plan free', () => {
    expect(courtPrice(0, 10)).toBe(0);
  });

  it('flags clubs above twelve courts as a custom quote', () => {
    expect(isCustomQuote(12)).toBe(false);
    expect(isCustomQuote(13)).toBe(true);
    expect(isCustomQuote(null)).toBe(false);
  });
});
