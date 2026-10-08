import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/* Клуб бачить у «Турніри федерацій» лише федерації зі спортом клубу (4.4); списки гравців — за ?sport= (5.3). */
type Rec = Record<string, any>;
const st = { clubSports: [] as string[] };
const prisma = {
  clubFederation: { findMany: vi.fn(async () => [
    { federationId: 'fSq', federation: { sport: 'SQUASH' } }, { federationId: 'fPad', federation: { sport: 'PADEL' } }]) },
  club: { findUnique: vi.fn(async () => ({ sports: st.clubSports })) },
  booking: { findMany: vi.fn(async () => []) },
  player: { findMany: vi.fn(async () => []) },
  clubPlayerRating: { findFirst: vi.fn(async () => ({ playerId: 'p' })), updateMany: vi.fn(async () => ({ count: 1 })) },
};
vi.mock('../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('./admin/shared', () => ({
  requireAuth: (req: Rec, _res: unknown, next: () => void) => { req.auth = { clubId: 'club', role: 'OWNER' }; next(); },
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  param: (req: { params: Record<string, string> }, k: string) => req.params[k],
}));
vi.mock('../lib/federationAuth', () => ({ requireFederationAuth: (_r: unknown, _s: unknown, n: () => void) => n(), signFederationToken: () => 't' }));

const { playerProfilesRouter } = await import('./playerProfiles');
const app = express().use(express.json()).use(playerProfilesRouter);
const fedIdsQueried = () => {
  const where = (prisma.booking.findMany.mock.calls[0] as unknown as [Rec])[0].where;
  return where.OR.flatMap((o: Rec) => (o.federationId ? o.federationId.in : []));
};
beforeEach(() => { st.clubSports = []; vi.clearAllMocks(); });

describe('турніри федерацій для клубу (4.4)', () => {
  it('порожній список спортів клубу → усі федерації', async () => {
    await request(app).get('/players/tournaments');
    expect(fedIdsQueried()).toEqual(['fSq', 'fPad']);
  });
  it('клуб зі сквошем бачить лише сквош-федерації', async () => {
    st.clubSports = ['SQUASH'];
    await request(app).get('/players/tournaments');
    expect(fedIdsQueried()).toEqual(['fSq']);
  });
  it('клуб без жодного спільного спорту — власні турніри, без федерацій', async () => {
    st.clubSports = ['TENNIS'];
    await request(app).get('/players/tournaments');
    const where = (prisma.booking.findMany.mock.calls[0] as unknown as [Rec])[0].where;
    expect(where.OR).toEqual([{ clubId: 'club' }]);
  });
});

describe('списки гравців за видом спорту (5.3)', () => {
  it('?sport=PADEL звужує clubRatings до падела; без параметра — SQUASH', async () => {
    await request(app).get('/players?sport=PADEL');
    await request(app).get('/players');
    const sel = (i: number) => (prisma.player.findMany.mock.calls[i] as unknown as [Rec])[0].select.clubRatings.where;
    expect(sel(0)).toEqual({ sport: 'PADEL' });
    expect(sel(1)).toEqual({ sport: 'SQUASH' });
  });
  it('невалідний ?sport= → 400', async () => {
    expect((await request(app).get('/players?sport=golf')).status).toBe(400);
  });
  it('membership: sport обмежує оновлюваний рядок', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    await request(app).patch(`/players/${id}/membership?sport=PADEL`).send({ group: 'A' });
    expect(prisma.clubPlayerRating.updateMany).toHaveBeenCalledWith({ where: { clubId: 'club', playerId: id, sport: 'PADEL' }, data: { group: 'A' } });
  });
});
