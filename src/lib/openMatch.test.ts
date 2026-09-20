import { describe, expect, it } from 'vitest';

import { bandLabel, fits, rankCandidates, reliability, seatsLeft, type Candidate } from './openMatch';

const player = (o: Partial<Candidate> & { id: string; name: string }): Candidate => ({
  level: 'C',
  hours: [],
  weekdays: [],
  noShows: 0,
  visits: 10,
  lastVisitDays: 10,
  ...o,
});

/* Гра на C+ у вівторок о 19:00. */
const ctx = { levelMin: 'C_PLUS' as const, levelMax: 'C_PLUS' as const, hour: 19, weekday: 2 };

describe('кого підбір пускає в гру', () => {
  it('сусідній рівень грає, через два — ні', () => {
    expect(fits('C', ctx)).toBe(true);
    expect(fits('B', ctx)).toBe(true);
    expect(fits('B_PLUS', ctx)).toBe(false);
    expect(fits('D', ctx)).toBe(false);
  });

  it('гравець без рівня проходить: порожнє поле — не привід ховати всі ігри клубу', () => {
    expect(fits(null, ctx)).toBe(true);
  });

  it('гра без рівня відкрита всім', () => {
    expect(fits('D', { levelMin: null, levelMax: null })).toBe(true);
  });

  it('чужий рівень не потрапляє в список навіть за інших ідеальних збігів', () => {
    const ideal = player({ id: 'far', name: 'Далекий', level: 'B_PLUS', hours: [19], weekdays: [2], lastVisitDays: 0 });
    expect(rankCandidates([ideal], ctx).map((r) => r.id)).toEqual([]);
  });
});

describe('порядок запрошень', () => {
  it('рівно свій рівень у свою годину стоїть вище за просто вільного', () => {
    const ranked = rankCandidates(
      [
        player({ id: 'any', name: 'Випадковий', level: 'C' }),
        player({ id: 'own', name: 'Свій', level: 'C_PLUS', hours: [19], weekdays: [2], lastVisitDays: 1 }),
      ],
      ctx,
    );

    expect(ranked.map((r) => r.id)).toEqual(['own', 'any']);
    expect(ranked[0]!.reasons).toContain('зазвичай грає о 19:00');
    expect(ranked[0]!.reasons).toContain('це його день тижня');
  });

  it('пропуски опускають у списку, але не викидають: гра — привід повернутись', () => {
    const ranked = rankCandidates(
      [
        player({ id: 'miss', name: 'Пропускає', level: 'C_PLUS', noShows: 5, visits: 10 }),
        player({ id: 'ok', name: 'Приходить', level: 'C_PLUS', noShows: 0, visits: 10 }),
      ],
      ctx,
    );

    expect(ranked.map((r) => r.id)).toEqual(['ok', 'miss']);
    expect(ranked[1]!.reasons).toContain('пропустив 5 із 10');
  });

  it('уже в грі — не кличемо вдруге', () => {
    const ranked = rankCandidates([player({ id: 'in', name: 'Учасник', level: 'C_PLUS' })], { ...ctx, exclude: ['in'] });
    expect(ranked).toEqual([]);
  });

  it('кличемо не більше ліміту', () => {
    const many = Array.from({ length: 20 }, (_, i) => player({ id: `p${i}`, name: `Гравець ${i}`, level: 'C_PLUS' }));
    expect(rankCandidates(many, ctx, 8)).toHaveLength(8);
  });
});

describe('надійність', () => {
  it('рахується вагою пропусків, а не їх кількістю', () => {
    expect(reliability({ noShows: 1, visits: 40 })).toBeGreaterThan(reliability({ noShows: 1, visits: 4 }));
  });

  it('за двома бронями не судимо', () => {
    expect(reliability({ noShows: 1, visits: 2 })).toBe(0.6);
  });
});

describe('підписи й місця', () => {
  it('рівень показується падельною шкалою, а не літерою з підкресленням', () => {
    expect(bandLabel('C', 'C_PLUS')).toBe('C–C+ · 2.5–3.5');
    expect(bandLabel('C', 'C')).toBe('C · 2.5–3.0');
    expect(bandLabel(null, null)).toBe('будь-який рівень');
  });

  it('заповнена гра більше не набирає', () => {
    expect(seatsLeft(4, 2)).toEqual({ free: 2, full: false });
    expect(seatsLeft(4, 4)).toEqual({ free: 0, full: true });
    expect(seatsLeft(4, 5)).toEqual({ free: 0, full: true });
  });
});
