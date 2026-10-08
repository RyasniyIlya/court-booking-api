import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/* Федерація прив'язана до спорту (фаза 4): створення турніру, /me, ізоляція списків. */
type Rec = Record<string, any>;
const FED = '11111111-1111-4111-8111-111111111111';
const CLUB = '22222222-2222-4222-8222-222222222222';
const COURT = '33333333-3333-4333-8333-333333333333';
const st = { fedSport: 'PADEL' as string, clubSports: [] as string[], created: null as Rec | null };

const prisma = {
  federation: { findUnique: vi.fn(async () => ({ sport: st.fedSport })), findUniqueOrThrow: vi.fn(async () => ({ id: FED, name: 'F', code: 'f', logoUrl: null, sport: st.fedSport })) },
  clubFederation: { findFirst: vi.fn(async () => ({ clubId: CLUB, federationId: FED, status: 'CONFIRMED' })) },
  court: { findFirst: vi.fn(async () => ({ id: COURT })) },
  booking: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: Rec) => { st.created = data; return { id: 'b1', ...data }; }),
  },
  club: { findUnique: vi.fn(async () => ({ sports: st.clubSports, defaultSetsToWin: 3 })) },
  player: { findMany: vi.fn(async () => [{ id: 'p1', name: 'A', clubRatings: [] }, { id: 'p2', name: 'B', clubRatings: [] }]) },
  federationPlayerRating: { findMany: vi.fn(async () => [{ playerId: 'p2', elo: 1400, matchCount: 3 }]) },
};
vi.mock('../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('../lib/federationAuth', () => ({
  requireFederationAuth: (req: Rec, _res: unknown, next: () => void) => { req.federationAuth = { accountId: 'a', federationId: FED, email: 'f@test' }; next(); },
  signFederationToken: () => 't',
}));
vi.mock('./admin/shared', () => ({ param: (req: { params: Record<string, string> }, k: string) => req.params[k] }));

const { federationRouter } = await import('./federation');
const app = express().use(express.json()).use(federationRouter);
const body = (over: Rec = {}) => ({ title: 'Кубок', clubId: CLUB, courtId: COURT, start: '2026-11-01T10:00:00+02:00', end: '2026-11-01T14:00:00+02:00', capacity: 8, ...over });

beforeEach(() => { st.fedSport = 'PADEL'; st.clubSports = []; st.created = null; vi.clearAllMocks(); });

describe('federation sport (фаза 4)', () => {
  it('/me віддає sport федерації', async () => {
    const r = await request(app).get('/me');
    expect(r.status).toBe(200);
    expect(r.body.sport).toBe('PADEL');
  });

  it('спорт турніру = спорт федерації, навіть якщо в запиті його немає', async () => {
    const r = await request(app).post('/tournaments').send(body());
    expect(r.status).toBe(201);
    expect(st.created?.tournamentSport).toBe('PADEL');
  });

  it('відхиляє sport у запиті, що не збігається зі спортом федерації (SPORT_MISMATCH)', async () => {
    const r = await request(app).post('/tournaments').send(body({ sport: 'SQUASH' }));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('SPORT_MISMATCH');
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it('приймає sport у запиті, що збігається', async () => {
    expect((await request(app).post('/tournaments').send(body({ sport: 'PADEL' }))).status).toBe(201);
  });

  it('клуб без спорту федерації → 400 SPORT_NOT_IN_CLUB', async () => {
    st.clubSports = ['SQUASH'];
    const r = await request(app).post('/tournaments').send(body());
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('SPORT_NOT_IN_CLUB');
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it('клуб зі спортом федерації (серед кількох) → 201', async () => {
    st.clubSports = ['SQUASH', 'PADEL'];
    expect((await request(app).post('/tournaments').send(body())).status).toBe(201);
  });

  it('порожній список спортів клубу не блокує', async () => {
    st.clubSports = [];
    expect((await request(app).post('/tournaments').send(body())).status).toBe(201);
  });

  it('список гравців: ELO з FederationPlayerRating федерації (немає рядка → 1200), сортування за ELO', async () => {
    const r = await request(app).get('/players');
    expect(r.status).toBe(200);
    expect(r.body.map((p: Rec) => [p.id, p.eloFederation])).toEqual([['p2', 1400], ['p1', 1200]]);
    expect(r.body.map((p: Rec) => p.level.code)).toEqual(['B', 'D']); // 1400 → B, 1200 → D (типові рівні)
    // афілійація звужена до спорту федерації
    const where = (prisma.player.findMany.mock.calls[0] as unknown as [Rec])[0].where;
    expect(JSON.stringify(where)).toContain('"sport":"PADEL"');
  });
});
