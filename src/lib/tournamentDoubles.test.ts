import { describe, expect, it, vi } from 'vitest';
import { computeTournamentResults, finalizeTournament, RatingError } from './tournamentRating';

type Rec = Record<string, any>;
/* Фейк tx: гравці в памʼяті, ratingChange збираємо для перевірки. */
function fakeTx(booking: Rec, players: Rec[]) {
  const changes: Rec[] = [];
  const clubRows = new Map<string, Rec>();
  const fedRows = new Map<string, Rec>(players.map(p => [p.id, { elo: p.eloFederation, matchCount: p.federationMatchCount, lastMatchAt: p.lastFederationMatchAt }]));
  const tx: Rec = {
    $executeRaw: vi.fn(async () => 1), $queryRaw: vi.fn(async () => []),
    booking: { findUniqueOrThrow: vi.fn(async () => booking), update: vi.fn(async () => ({})) },
    // Мігрований стан: ELO федерації береться з FederationPlayerRating (рядки засіяні з players).
    federationPlayerRating: {
      findUnique: vi.fn(async ({ where }: Rec) => fedRows.get(where.federationId_playerId.playerId) ?? null),
      upsert: vi.fn(async ({ where, create, update }: Rec) => { const k = where.federationId_playerId.playerId; const r = fedRows.get(k);
        if (r) { r.elo = update.elo; r.matchCount += update.matchCount.increment; } else fedRows.set(k, { elo: create.elo, matchCount: create.matchCount, lastMatchAt: create.lastMatchAt }); }),
    },
    player: {
      update: vi.fn(async ({ where, data }: Rec) => { players.find(p => p.id === where.id)!.eloFederation = data.eloFederation; }),
    },
    ratingChange: { create: vi.fn(async ({ data }: Rec) => { changes.push(data); }) },
    clubPlayerRating: {
      upsert: vi.fn(async ({ where }: Rec) => { const k = where.clubId_playerId_sport.playerId; if (!clubRows.has(k)) clubRows.set(k, { points: 0, matchCount: 0, lastMatchAt: null }); return { ...clubRows.get(k) }; }),
      update: vi.fn(async ({ where, data }: Rec) => { const r = clubRows.get(where.clubId_playerId_sport.playerId)!; r.points += data.points.increment; }),
    },
  };
  return { tx, changes, clubRows };
}
const pl = (id: string, elo: number) => ({ id, eloFederation: elo, federationMatchCount: 10, /* ветеран: без provisional K */ lastFederationMatchAt: null });
const base = (scope: string, entries: Rec[]) => ({
  id: 'b1', clubId: 'c1', status: 'CONFIRMED', tournamentStatus: 'RUNNING', ratingsAppliedAt: null, thirdPlace: false,
  tournamentScope: scope, federationId: scope === 'FEDERATION' ? 'f1' : null, tournamentTeamSize: 2,
  club: { clubRatingRules: { win: 10, first: 30, second: 20, third: 10 } }, tournamentEntries: entries,
  tournamentMatches: [{ id: 'm1', round: 1, slot: 0, entryAId: 'eA', entryBId: 'eB', winnerEntryId: 'eA', status: 'DONE',
    sets: [{ a: 6, b: 3 }], version: 0, finishedAt: null }],
});
const teams = [
  { id: 'eA', playerId: 'a1', partnerPlayerId: 'a2' },
  { id: 'eB', playerId: 'b1', partnerPlayerId: 'b2' },
];

describe('finalizeTournament 2×2', () => {
  it('федерація: однакова дельта обом партнерам за середнім ELO пари', async () => {
    const players = [pl('a1', 1300), pl('a2', 1100), pl('b1', 1250), pl('b2', 1150)];
    const { tx, changes } = fakeTx(base('FEDERATION', teams), players);
    await finalizeTournament(tx as never, 'b1', 'admin');
    // середні 1200 vs 1200 → ±16
    expect(changes).toHaveLength(4);
    const d = (id: string) => { const c = changes.find(x => x.playerId === id)!; return c.after - c.before; };
    expect([d('a1'), d('a2'), d('b1'), d('b2')]).toEqual([16, 16, -16, -16]);
    expect(new Set(changes.map(c => c.idempotencyKey)).size).toBe(4);
    expect(changes.map(c => c.idempotencyKey)).toContain('federation:b1:m1:a2');
  });
  it('клуб: обоє партнерів отримують однакові очки', async () => {
    const { tx, changes } = fakeTx(base('CLUB', teams), []);
    await finalizeTournament(tx as never, 'b1', 'admin');
    const pts = (id: string) => { const c = changes.find(x => x.playerId === id)!; return c.after - c.before; };
    expect([pts('a1'), pts('a2')]).toEqual([40, 40]); // перемога 10 + 1-ше місце 30
    expect([pts('b1'), pts('b2')]).toEqual([20, 20]);
    expect(changes.map(c => c.idempotencyKey).sort()).toEqual(['club:b1:a1', 'club:b1:a2', 'club:b1:b1', 'club:b1:b2']);
  });
  it('PARTNER_REQUIRED без партнера; DUPLICATE_PLAYER, якщо гравець і партнер збігаються між парами', async () => {
    const noPartner = fakeTx(base('CLUB', [{ ...teams[0], partnerPlayerId: null }, teams[1]]), []);
    await expect(finalizeTournament(noPartner.tx as never, 'b1', 'x')).rejects.toThrow(new RatingError('PARTNER_REQUIRED'));
    const dup = fakeTx(base('CLUB', [teams[0], { ...teams[1], partnerPlayerId: 'a1' }]), []);
    await expect(finalizeTournament(dup.tx as never, 'b1', 'x')).rejects.toThrow(new RatingError('DUPLICATE_PLAYER'));
  });
});

describe('computeTournamentResults 2×2', () => {
  it('рядок пари містить партнера з його рейтингом', () => {
    const r = computeTournamentResults({ thirdPlace: false, tournamentScope: 'FEDERATION' },
      [{ id: 'eA', playerId: 'a1', partnerPlayerId: 'a2', name: 'A1 / A2' }, { id: 'eB', playerId: 'b1', partnerPlayerId: 'b2', name: 'B1 / B2' }],
      [{ round: 1, slot: 0, entryAId: 'eA', entryBId: 'eB', winnerEntryId: 'eA', status: 'DONE', sets: [{ a: 6, b: 1 }] }],
      [{ playerId: 'a1', before: 1300, after: 1316, idempotencyKey: null }, { playerId: 'a2', before: 1100, after: 1116, idempotencyKey: null }]);
    const a = r.standings.find(s => s.entryId === 'eA')!;
    expect([a.before, a.delta]).toEqual([1300, 16]);
    expect(a.partner).toEqual({ playerId: 'a2', before: 1100, after: 1116, delta: 16 });
    expect(r.standings.find(s => s.entryId === 'eB')!.partner?.delta).toBeNull();
  });
});
