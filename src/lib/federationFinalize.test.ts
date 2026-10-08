import { describe, expect, it, vi } from 'vitest';
import { finalizeTournament, computeTournamentResults } from './tournamentRating';
import { DEFAULT_RATING_SETTINGS } from './federationRating';

type Rec = Record<string, any>;
function fakeTx(booking: Rec, fedRows: Record<string, Rec>) {
  const changes: Rec[] = []; const upserts: Rec[] = []; const clubUpserts: Rec[] = []; const bookingUpdates: Rec[] = [];
  const tx: Rec = {
    $executeRaw: vi.fn(async () => 1), $queryRaw: vi.fn(async () => []),
    booking: { findUniqueOrThrow: vi.fn(async () => booking), update: vi.fn(async (a: Rec) => { bookingUpdates.push(a); return {}; }) },
    federationPlayerRating: {
      findUnique: vi.fn(async ({ where }: Rec) => fedRows[where.federationId_playerId.playerId] ?? null),
      upsert: vi.fn(async (a: Rec) => { upserts.push(a); }),
    },
    player: { update: vi.fn(async () => ({})) },
    ratingChange: { create: vi.fn(async ({ data }: Rec) => { changes.push(data); }) },
    clubPlayerRating: { upsert: vi.fn(async (a: Rec) => { clubUpserts.push(a); return { points: 0, matchCount: 0, lastMatchAt: null }; }), update: vi.fn(async () => ({})) },
  };
  return { tx, changes, upserts, clubUpserts, bookingUpdates };
}
const base = (scope: string, over: Rec = {}) => ({
  id: 'b1', clubId: 'c1', status: 'CONFIRMED', tournamentStatus: 'RUNNING', ratingsAppliedAt: null, thirdPlace: false,
  tournamentScope: scope, federationId: scope === 'FEDERATION' ? 'f1' : null, tournamentTeamSize: 1, tournamentRated: true,
  club: { clubRatingRules: { win: 10, first: 30, second: 20, third: 10 } }, federation: { ratingSettings: null },
  tournamentEntries: [{ id: 'eA', playerId: 'a', partnerPlayerId: null }, { id: 'eB', playerId: 'b', partnerPlayerId: null }],
  tournamentMatches: [{ id: 'm1', round: 1, slot: 0, entryAId: 'eA', entryBId: 'eB', winnerEntryId: 'eA', status: 'DONE', sets: [{ a: 6, b: 3 }], version: 0, finishedAt: null }],
  ...over,
});
const vet = (elo: number) => ({ elo, matchCount: 20, lastMatchAt: null });

describe('finalizeTournament: налаштування федерації', () => {
  it('без налаштувань: ветерани рухаються як раніше (K=32), версія elo-v2', async () => {
    const { tx, changes } = fakeTx(base('FEDERATION'), { a: vet(1200), b: vet(1400) });
    await finalizeTournament(tx as never, 'b1', 'x');
    expect(changes.map(c => c.after - c.before)).toEqual([24, -24]);
    expect(changes[0].calculationVersion).toBe('elo-v2;k=32;pk=40;pn=10');
  });
  it('власний K=16 і provisional вимкнено', async () => {
    const b = base('FEDERATION', { federation: { ratingSettings: { ...DEFAULT_RATING_SETTINGS, kFactor: 16, provisionalMatches: 0 } } });
    const { tx, changes } = fakeTx(b, { a: vet(1200), b: vet(1200) });
    await finalizeTournament(tx as never, 'b1', 'x');
    expect(changes.map(c => c.after - c.before)).toEqual([8, -8]);
    expect(changes[0].calculationVersion).toBe('elo-v2;k=16;pk=40;pn=0');
  });
  it('гравець без рядка стартує з startElo; новачок — provisional K', async () => {
    const b = base('FEDERATION', { federation: { ratingSettings: { ...DEFAULT_RATING_SETTINGS, startElo: 1000 } } });
    const { tx, changes, upserts } = fakeTx(b, {});
    await finalizeTournament(tx as never, 'b1', 'x');
    expect(changes.map(c => [c.before, c.after])).toEqual([[1000, 1020], [1000, 980]]); // обидва новачки: K=40
    expect(upserts).toHaveLength(2);
  });
  it('невалідні налаштування в БД → типові', async () => {
    const { tx, changes } = fakeTx(base('FEDERATION', { federation: { ratingSettings: { startElo: 5 } } }), { a: vet(1200), b: vet(1200) });
    await finalizeTournament(tx as never, 'b1', 'x');
    expect(changes.map(c => c.after - c.before)).toEqual([16, -16]);
  });
});

describe('клубний турнір без рейтингу', () => {
  it('нічого не нараховує, але завершує турнір', async () => {
    const { tx, changes, clubUpserts, bookingUpdates } = fakeTx(base('CLUB', { tournamentRated: false }), {});
    expect(await finalizeTournament(tx as never, 'b1', 'x')).toEqual({ alreadyApplied: false });
    expect(changes).toHaveLength(0); expect(clubUpserts).toHaveLength(0);
    expect(bookingUpdates[0].data.tournamentStatus).toBe('FINISHED');
    expect(bookingUpdates[0].data.ratingsAppliedAt).toBeInstanceOf(Date);
  });
  it('рейтинговий клубний нараховує очки', async () => {
    const { tx, changes } = fakeTx(base('CLUB'), {});
    await finalizeTournament(tx as never, 'b1', 'x');
    expect(changes).toHaveLength(2);
  });
  it('підсумки: ratingType NONE', () => {
    const r = computeTournamentResults({ thirdPlace: false, tournamentScope: 'CLUB', tournamentRated: false },
      [{ id: 'eA', playerId: 'a', name: 'A' }, { id: 'eB', playerId: 'b', name: 'B' }],
      [{ round: 1, slot: 0, entryAId: 'eA', entryBId: 'eB', winnerEntryId: 'eA', status: 'DONE', sets: [] }], []);
    expect(r.standings.every(s => s.ratingType === 'NONE' && s.delta === null)).toBe(true);
  });
});
