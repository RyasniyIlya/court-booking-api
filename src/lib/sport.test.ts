import { describe, expect, it } from 'vitest';
import { allowedTeamSizes, defaultTeamSize, sportError } from './sport';

describe('правила видів спорту', () => {
  it('сквош — лише 1×1, теніс/падел/без спорту — 1×1 і 2×2', () => {
    expect(allowedTeamSizes('SQUASH')).toEqual([1]);
    expect(allowedTeamSizes('TENNIS')).toEqual([1, 2]);
    expect(allowedTeamSizes('PADEL')).toEqual([1, 2]);
    expect(allowedTeamSizes(null)).toEqual([1, 2]);
  });
  it('формат за замовчуванням: падел — парний, решта — одиночний', () => {
    expect(defaultTeamSize('PADEL')).toBe(2);
    expect(defaultTeamSize('TENNIS')).toBe(1);
    expect(defaultTeamSize('SQUASH')).toBe(1);
    expect(defaultTeamSize(null)).toBe(1);
  });
  it('sportError: BAD_TEAM_SIZE для сквошу 2×2, SPORT_NOT_IN_CLUB поза видами клубу', () => {
    expect(sportError('SQUASH', 2, [])).toBe('BAD_TEAM_SIZE');
    expect(sportError('PADEL', 2, ['PADEL'])).toBeNull();
    expect(sportError('TENNIS', 1, ['SQUASH'])).toBe('SPORT_NOT_IN_CLUB');
    expect(sportError('TENNIS', 1, [])).toBeNull();
    expect(sportError(null, 2, ['SQUASH'])).toBeNull();
  });
});
