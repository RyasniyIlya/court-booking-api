import { describe, expect, it, vi } from 'vitest';
import { finalizeTournament } from './tournamentRating';
import { defaultClubSport, fedRatingOrDefault, mapLegacyFederationRatings, parseSportQuery, tournamentSportOf } from './sportRating';

type Rec = Record<string, any>;

/** Спільний стан «бази»: рейтинги по (клуб, гравець, спорт) і по (федерація, гравець) + дзеркало в Player. */
function world() {
  const club = new Map<string, Rec>();      // `${clubId}:${playerId}:${sport}`
  const fed = new Map<string, Rec>();       // `${federationId}:${playerId}`
  const mirror = new Map<string, Rec>();    // Player.eloFederation (сквош-дзеркало)
  const changes: Rec[] = [];
  const tx: Rec = {
    $executeRaw: vi.fn(async () => 1), $queryRaw: vi.fn(async () => []),
    booking: { findUniqueOrThrow: vi.fn(), update: vi.fn(async () => ({})) },
    federationPlayerRating: {
      findUnique: vi.fn(async ({ where: { federationId_playerId: k } }: Rec) => fed.get(`${k.federationId}:${k.playerId}`) ?? null),
      upsert: vi.fn(async ({ where: { federationId_playerId: k }, create, update }: Rec) => {
        const key = `${k.federationId}:${k.playerId}`, r = fed.get(key);
        if (r) { r.elo = update.elo; r.matchCount += update.matchCount.increment; } else fed.set(key, { elo: create.elo, matchCount: create.matchCount, lastMatchAt: create.lastMatchAt });
      }),
    },
    player: { update: vi.fn(async ({ where, data }: Rec) => { mirror.set(where.id, { elo: data.eloFederation }); }) },
    ratingChange: { create: vi.fn(async ({ data }: Rec) => { changes.push(data); }) },
    clubPlayerRating: {
      upsert: vi.fn(async ({ where: { clubId_playerId_sport: k }, create }: Rec) => {
        const key = `${k.clubId}:${k.playerId}:${k.sport}`;
        if (!club.has(key)) club.set(key, { points: 0, wins: 0, matchCount: 0, lastMatchAt: null, sport: create.sport });
        return { ...club.get(key) };
      }),
      update: vi.fn(async ({ where: { clubId_playerId_sport: k }, data }: Rec) => {
        const r = club.get(`${k.clubId}:${k.playerId}:${k.sport}`)!;
        r.points += data.points.increment; r.wins += data.wins.increment; r.matchCount += data.matchCount.increment;
      }),
    },
  };
  return { tx, club, fed, mirror, changes };
}

const booking = (over: Rec) => ({
  id: 'b1', clubId: 'c1', status: 'CONFIRMED', tournamentStatus: 'RUNNING', ratingsAppliedAt: null, thirdPlace: false,
  tournamentTeamSize: 1, club: { clubRatingRules: { win: 10, first: 30, second: 20, third: 10 } },
  tournamentEntries: [{ id: 'eA', playerId: 'p1', partnerPlayerId: null }, { id: 'eB', playerId: 'p2', partnerPlayerId: null }],
  tournamentMatches: [{ id: 'm1', round: 1, slot: 0, entryAId: 'eA', entryBId: 'eB', winnerEntryId: 'eA', status: 'DONE', sets: [{ a: 11, b: 5 }], version: 0, finishedAt: null }],
  ...over,
});
const run = (w: ReturnType<typeof world>, b: Rec) => { w.tx.booking.findUniqueOrThrow.mockResolvedValue(b); return finalizeTournament(w.tx as never, 'b1', 'admin'); };

describe('ізоляція рейтингів за спортом', () => {
  it('падел-клубний турнір не чіпає сквош-очки; сквош не чіпає падел (і навпаки)', async () => {
    const w = world();
    await run(w, booking({ tournamentScope: 'CLUB', tournamentSport: 'PADEL' }));
    expect([...w.club.keys()].sort()).toEqual(['c1:p1:PADEL', 'c1:p2:PADEL']);
    expect(w.club.get('c1:p1:PADEL')!.points).toBe(40);
    expect(w.club.has('c1:p1:SQUASH')).toBe(false);

    await run(w, booking({ id: 'b2', tournamentScope: 'CLUB', tournamentSport: 'SQUASH' }));
    expect(w.club.get('c1:p1:SQUASH')!.points).toBe(40);
    expect(w.club.get('c1:p1:PADEL')!.points).toBe(40); // не змінилось
    expect(w.changes.map(c => c.sport)).toEqual(['PADEL', 'PADEL', 'SQUASH', 'SQUASH']);
  });

  it('старий турнір без tournamentSport рахується як сквош', async () => {
    const w = world();
    await run(w, booking({ tournamentScope: 'CLUB', tournamentSport: null }));
    expect([...w.club.keys()].sort()).toEqual(['c1:p1:SQUASH', 'c1:p2:SQUASH']);
    expect(tournamentSportOf({ tournamentSport: null })).toBe('SQUASH');
  });

  it('падел-федерація не чіпає ELO сквош-федерації й не пише дзеркало в Player', async () => {
    const w = world();
    w.fed.set('fSq:p1', { elo: 1300, matchCount: 5, lastMatchAt: null });
    w.fed.set('fSq:p2', { elo: 1100, matchCount: 5, lastMatchAt: null });
    await run(w, booking({ tournamentScope: 'FEDERATION', federationId: 'fPad', tournamentSport: 'PADEL' }));
    expect(w.fed.get('fSq:p1')).toEqual({ elo: 1300, matchCount: 5, lastMatchAt: null });
    expect(w.fed.get('fPad:p1')!.elo).toBe(1220); // старт 1200, новачок K=40 → +20 за рівних
    expect(w.fed.get('fPad:p2')!.elo).toBe(1180);
    expect(w.mirror.size).toBe(0);
    expect(w.club.size).toBe(0);
    expect(w.changes.every(c => c.sport === 'PADEL' && c.ratingType === 'FEDERATION')).toBe(true);
  });

  it('сквош-федерація пише у свій рядок і дзеркалить у Player; падел-ELO лишається', async () => {
    const w = world();
    w.fed.set('fPad:p1', { elo: 1500, matchCount: 9, lastMatchAt: null });
    await run(w, booking({ tournamentScope: 'FEDERATION', federationId: 'fSq', tournamentSport: 'SQUASH' }));
    expect(w.fed.get('fSq:p1')!.elo).toBe(1220);
    expect(w.fed.get('fPad:p1')).toEqual({ elo: 1500, matchCount: 9, lastMatchAt: null });
    expect(w.mirror.get('p1')).toEqual({ elo: 1220 });
    expect(w.club.size).toBe(0);
  });

  it('федеративний турнір читає ELO тільки своєї федерації', async () => {
    const w = world();
    w.fed.set('fOther:p1', { elo: 1900, matchCount: 3, lastMatchAt: null });
    await run(w, booking({ tournamentScope: 'FEDERATION', federationId: 'fSq', tournamentSport: null }));
    const c = w.changes.find(x => x.playerId === 'p1')!;
    expect(c.before).toBe(1200);
  });
});

describe('sportRating helpers', () => {
  it('parseSportQuery: дефолт SQUASH, невалідне → null', () => {
    expect(parseSportQuery(undefined)).toBe('SQUASH');
    expect(parseSportQuery('PADEL')).toBe('PADEL');
    expect(parseSportQuery('padel')).toBeNull();
    expect(parseSportQuery(['PADEL'])).toBeNull();
  });
  it('defaultClubSport / fedRatingOrDefault', () => {
    expect(defaultClubSport([])).toBe('SQUASH');
    expect(defaultClubSport(['PADEL', 'TENNIS'])).toBe('PADEL');
    expect(fedRatingOrDefault(null)).toEqual({ elo: 1200, matchCount: 0, lastMatchAt: null });
  });
});

describe('маппінг міграції 20261007230000_sport_ratings (Player → FederationPlayerRating)', () => {
  const d = (n: number) => new Date(`2026-10-0${n}T10:00:00Z`);
  const players = [
    { id: 'a', federationId: 'f1', eloFederation: 1350, federationMatchCount: 7, lastFederationMatchAt: d(3) },
    { id: 'b', federationId: null, eloFederation: 1200, federationMatchCount: 0, lastFederationMatchAt: null },
    { id: 'c', federationId: null, eloFederation: 1275, federationMatchCount: 2, lastFederationMatchAt: d(4) },
  ];
  it('гравці федерації переносяться з поточними значеннями; без федерації й без матчів — ні', () => {
    const rows = mapLegacyFederationRatings(players, []);
    expect(rows).toEqual([{ federationId: 'f1', playerId: 'a', elo: 1350, matchCount: 7, lastMatchAt: d(3) }]);
  });
  it('афілійований гравець без federationId, що грав офіційний турнір, потрапляє у федерацію турніру', () => {
    const rows = mapLegacyFederationRatings(players, [{ playerId: 'c', federationId: 'f2', effectiveAt: d(4) }]);
    expect(rows.find(r => r.playerId === 'c')).toEqual({ federationId: 'f2', playerId: 'c', elo: 1275, matchCount: 2, lastMatchAt: d(4) });
    expect(rows).toHaveLength(2);
  });
  it('дублі (власна федерація + зміна рейтингу) не множаться', () => {
    const rows = mapLegacyFederationRatings(players, [{ playerId: 'a', federationId: 'f1', effectiveAt: d(3) }]);
    expect(rows.filter(r => r.playerId === 'a')).toHaveLength(1);
  });
});
