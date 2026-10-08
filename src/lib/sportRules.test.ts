import { describe, expect, it } from 'vitest';
import {
  buildTournamentSettings, defaultSettings, isSetComplete, isSetPossible, matchWinner, publicSportRules, validateSettings,
} from './sportRules';

describe('defaultSettings / validateSettings', () => {
  it('типові значення за спортом', () => {
    expect(defaultSettings('SQUASH')).toEqual({ teamSize: 1, setsToWin: 3, pointsToWin: 11 });
    expect(defaultSettings('TENNIS')).toEqual({ teamSize: 1, setsToWin: 2 });
    expect(defaultSettings('PADEL')).toEqual({ teamSize: 2, setsToWin: 2, goldenPoint: false });
  });
  it('усі типові валідні', () => {
    for (const s of ['SQUASH', 'TENNIS', 'PADEL'] as const) expect(validateSettings(s, defaultSettings(s))).toEqual([]);
  });
  it('помилки', () => {
    expect(validateSettings('SQUASH', { teamSize: 2, setsToWin: 3 })).toContain('BAD_TEAM_SIZE');
    expect(validateSettings('TENNIS', { teamSize: 1, setsToWin: 1 })).toContain('BAD_SETS_TO_WIN');
    expect(validateSettings('PADEL', { teamSize: 2, setsToWin: 3 })).toContain('BAD_SETS_TO_WIN');
    expect(validateSettings('SQUASH', { teamSize: 1, setsToWin: 3, pointsToWin: 21 })).toContain('BAD_POINTS_TO_WIN');
    expect(validateSettings('TENNIS', { teamSize: 1, setsToWin: 2, pointsToWin: 11 })).toContain('BAD_POINTS_TO_WIN');
    expect(validateSettings('TENNIS', { teamSize: 1, setsToWin: 2, goldenPoint: true })).toContain('BAD_GOLDEN_POINT');
    expect(validateSettings('SQUASH', { teamSize: 1, setsToWin: 3, goldenPoint: true })).toContain('BAD_GOLDEN_POINT');
    expect(validateSettings('PADEL', { teamSize: 2, setsToWin: 2, goldenPoint: true })).toEqual([]);
    expect(validateSettings('PADEL', { teamSize: 2, setsToWin: 2, foo: 1 })).toEqual(['BAD_SETTINGS']);
    expect(validateSettings('PADEL', null)).toEqual(['BAD_SETTINGS']);
  });
});

describe('isSetComplete', () => {
  const sq = defaultSettings('SQUASH');
  it('сквош до 11', () => {
    expect(isSetComplete('SQUASH', sq, 11, 9)).toBe(true);
    expect(isSetComplete('SQUASH', sq, 11, 10)).toBe(false);
    expect(isSetComplete('SQUASH', sq, 12, 10)).toBe(true);
    expect(isSetComplete('SQUASH', sq, 12, 11)).toBe(false);
    expect(isSetComplete('SQUASH', sq, 13, 10)).toBe(false);
    expect(isSetComplete('SQUASH', sq, 10, 8)).toBe(false);
  });
  it('сквош до 15', () => {
    const s15 = { ...sq, pointsToWin: 15 };
    expect(isSetComplete('SQUASH', s15, 11, 5)).toBe(false);
    expect(isSetComplete('SQUASH', s15, 15, 13)).toBe(true);
  });
  it('теніс/падел у геймах', () => {
    const t = defaultSettings('TENNIS');
    expect(isSetComplete('TENNIS', t, 6, 4)).toBe(true);
    expect(isSetComplete('TENNIS', t, 6, 5)).toBe(false);
    expect(isSetComplete('TENNIS', t, 7, 5)).toBe(true);
    expect(isSetComplete('TENNIS', t, 6, 6)).toBe(false);
    expect(isSetComplete('PADEL', defaultSettings('PADEL'), 7, 6)).toBe(true);
    expect(isSetComplete('PADEL', defaultSettings('PADEL'), 8, 6)).toBe(false);
    expect(isSetComplete('TENNIS', t, 6, 0)).toBe(true);
  });
  it('isSetPossible відсікає неможливі рахунки', () => {
    expect(isSetPossible('SQUASH', sq, 12, 5)).toBe(false);
    expect(isSetPossible('SQUASH', sq, 10, 10)).toBe(true);
    expect(isSetPossible('TENNIS', defaultSettings('TENNIS'), 8, 6)).toBe(false);
    expect(isSetPossible('TENNIS', defaultSettings('TENNIS'), 6, 6)).toBe(true);
    expect(isSetPossible('TENNIS', defaultSettings('TENNIS'), -1, 2)).toBe(false);
  });
});

describe('matchWinner', () => {
  it('сквош до 3 сетів: потрібні 3 завершені', () => {
    const s = defaultSettings('SQUASH');
    expect(matchWinner('SQUASH', s, [{ a: 11, b: 5 }, { a: 11, b: 6 }])).toBeNull();
    expect(matchWinner('SQUASH', s, [{ a: 11, b: 5 }, { a: 11, b: 6 }, { a: 11, b: 10 }])).toBeNull();
    expect(matchWinner('SQUASH', s, [{ a: 11, b: 5 }, { a: 6, b: 11 }, { a: 11, b: 9 }, { a: 4, b: 11 }, { a: 12, b: 10 }])).toBe('A');
  });
  it('теніс до 2 сетів', () => {
    const s = defaultSettings('TENNIS');
    expect(matchWinner('TENNIS', s, [{ a: 6, b: 4 }, { a: 3, b: 6 }])).toBeNull();
    expect(matchWinner('TENNIS', s, [{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 5, b: 7 }])).toBe('B');
  });
  it('падел до 1 сету', () => {
    expect(matchWinner('PADEL', { teamSize: 2, setsToWin: 1 }, [{ a: 7, b: 6 }])).toBe('A');
    expect(matchWinner('PADEL', { teamSize: 2, setsToWin: 1 }, [{ a: 6, b: 5 }])).toBeNull();
  });
});

describe('buildTournamentSettings / publicSportRules', () => {
  it('без спорту — legacy null', () => {
    expect(buildTournamentSettings(null, { teamSize: 2, setsToWin: 3 })).toEqual({ ok: true, settings: null, teamSize: 2, setsToWin: 3 });
    expect(buildTournamentSettings(null, { settings: { teamSize: 1, setsToWin: 1 } })).toEqual({ ok: false, error: 'SPORT_REQUIRED' });
  });
  it('спорт без settings — типові з явним форматом', () => {
    expect(buildTournamentSettings('PADEL', { teamSize: 1, setsToWin: 3 })).toMatchObject({ ok: true, teamSize: 1, setsToWin: 2 });
  });
  it('settings нормалізуються й валідуються', () => {
    expect(buildTournamentSettings('SQUASH', { settings: { teamSize: 1, setsToWin: 2 } })).toMatchObject({ ok: true, settings: { pointsToWin: 11 }, setsToWin: 2 });
    expect(buildTournamentSettings('SQUASH', { settings: { teamSize: 2, setsToWin: 2 } })).toEqual({ ok: false, error: 'BAD_TEAM_SIZE' });
  });
  it('публічний конфіг містить три види', () => {
    expect(publicSportRules().sports.map((s) => s.sport)).toEqual(['PADEL', 'TENNIS', 'SQUASH']);
  });
});
