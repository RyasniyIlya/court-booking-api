import { describe, expect, it } from 'vitest';
import { DEFAULT_RATING_SETTINGS as D, ratingSettingsSchema, resolveRatingSettings, eloDelta, levelOf, kFor, calcVersion } from './federationRating';
import { eloResult } from './tournamentRating';

const lv = (...mins: number[]) => mins.map((m, i) => ({ code: `L${i}`, label: `Level ${i}`, minElo: m }));
const with_ = (over: object) => ({ ...D, ...over });

describe('ratingSettingsSchema', () => {
  it('типові значення валідні', () => { expect(ratingSettingsSchema.safeParse(D).success).toBe(true); });
  it.each([
    ['startElo < 800', { startElo: 799 }], ['startElo > 2000', { startElo: 2001 }],
    ['K < 8', { kFactor: 7 }], ['K > 64', { kFactor: 65 }],
    ['provisionalK > 80', { provisionalK: 81 }], ['provisionalMatches > 30', { provisionalMatches: 31 }],
    ['1 рівень', { levels: lv(0) }], ['11 рівнів', { levels: lv(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10) }],
    ['перший не з 0', { levels: lv(100, 200) }], ['minElo не зростає', { levels: lv(0, 1200, 1200) }],
    ['дубль коду', { levels: [{ code: 'A', label: 'x', minElo: 0 }, { code: 'a', label: 'y', minElo: 5 }] }],
  ])('відхиляє: %s', (_n, over) => { expect(ratingSettingsSchema.safeParse(with_(over)).success).toBe(false); });
  it('resolve: null/сміття → типові', () => {
    expect(resolveRatingSettings(null)).toEqual(D);
    expect(resolveRatingSettings({ startElo: 1 })).toEqual(D);
    expect(resolveRatingSettings(with_({ kFactor: 20 })).kFactor).toBe(20);
  });
});

describe('levelOf (типові рівні сквошу)', () => {
  it.each([[0, 'E'], [1099, 'E'], [1100, 'D'], [1249, 'D'], [1250, 'C'], [1400, 'B'], [1550, 'A'], [1699, 'A'], [1700, 'Pro'], [3000, 'Pro']])('%i → %s', (elo, code) => {
    expect(levelOf(D, elo).code).toBe(code);
  });
  it('повертає code і label', () => { expect(levelOf(D, 1200)).toEqual({ code: 'D', label: 'Аматор' }); });
});

describe('eloDelta', () => {
  it('K: новачок (matchCount < provisionalMatches) → provisionalK; 0 = вимкнено', () => {
    expect(kFor(D, 0)).toBe(40); expect(kFor(D, 9)).toBe(40); expect(kFor(D, 10)).toBe(32);
    expect(kFor(with_({ provisionalMatches: 0 }), 0)).toBe(32);
  });
  it('паритет зі старою формулою при типових налаштуваннях і дорослих гравцях', () => {
    for (const [a, b] of [[1200, 1200], [1200, 1400], [1500, 1100], [1000, 1900], [1337, 1342]]) for (const w of ['A', 'B'] as const) {
      const old = eloResult(a, b, w);
      const d = eloDelta(D, a, b, w, 50, 50);
      expect([a + d.a, b + d.b]).toEqual([old.a, old.b]);
    }
  });
  it('1200 vs 1400: перемога слабшого +24 / −24 (K=32)', () => {
    expect(eloDelta(D, 1200, 1400, 'A', 50, 50)).toEqual({ a: 24, b: -24 });
  });
  it('provisional: новачок рухається швидше, суперник — зі своїм K', () => {
    const d = eloDelta(D, 1200, 1200, 'A', 0, 50);
    expect(d).toEqual({ a: 20, b: -16 });
  });
  it('власний K', () => { expect(eloDelta(with_({ kFactor: 16, provisionalMatches: 0 }), 1200, 1200, 'A', 5, 5)).toEqual({ a: 8, b: -8 }); });
  it('calcVersion', () => { expect(calcVersion(D)).toBe('elo-v2;k=32;pk=40;pn=10'); });
});
