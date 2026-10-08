import { describe, expect, it } from 'vitest';
import { computeTournamentResults } from './tournamentRating';

const entries = ['A', 'B', 'C', 'D'].map((n, i) => ({ id: `e${n}`, playerId: `p${n}`, name: n, seed: i + 1 }));
const m = (round: number, slot: number, a: string, b: string, w: string | null, status: string, sets: { a: number; b: number }[]) =>
  ({ round, slot, entryAId: a, entryBId: b, winnerEntryId: w, status, sets });
const matches = [
  m(1, 0, 'eA', 'eB', 'eA', 'DONE', [{ a: 6, b: 2 }, { a: 6, b: 3 }]),
  m(1, 1, 'eC', 'eD', 'eC', 'WALKOVER', []),
  m(2, 0, 'eA', 'eC', 'eA', 'DONE', [{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 7, b: 5 }]),
  m(2, 1, 'eB', 'eD', 'eB', 'DONE', [{ a: 6, b: 0 }, { a: 6, b: 1 }]),
];
const ch = (playerId: string, before: number, after: number) => ({ playerId, before, after, idempotencyKey: null });

describe('computeTournamentResults', () => {
  const r = computeTournamentResults({ thirdPlace: true, tournamentScope: 'FEDERATION' }, entries, matches,
    [ch('pA', 1000, 1010), ch('pA', 1010, 1030), ch('pB', 1000, 990), ch('pC', 1000, 1000)]);
  it('подіум за порядком місць', () => {
    expect(r.podium.map(p => [p.place, p.name])).toEqual([[1, 'A'], [2, 'C'], [3, 'B']]);
    expect(r.standings.map(s => s.place)).toEqual([1, 2, 3, 4]);
  });
  it('дельта рейтингу: перший before, останній after', () => {
    const a = r.standings.find(s => s.name === 'A')!;
    expect([a.before, a.after, a.delta, a.ratingType]).toEqual([1000, 1030, 30, 'FEDERATION']);
    expect(r.standings.find(s => s.name === 'D')!.delta).toBeNull();
  });
  it('walkover не рахується грою; сети та гейми', () => {
    const c = r.standings.find(s => s.name === 'C')!;
    expect([c.played, c.wins, c.losses]).toEqual([1, 0, 1]);
    const a = r.standings.find(s => s.name === 'A')!;
    expect([a.played, a.wins, a.setsWon, a.setsLost, a.gamesWon, a.gamesLost]).toEqual([2, 2, 4, 1, 28, 20]);
  });
});
