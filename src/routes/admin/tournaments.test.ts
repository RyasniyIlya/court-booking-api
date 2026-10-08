import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

/* Пам'ятний фейк бази: роути перевіряються на реальному потоці
   (учасники → старт → рахунок → відкат), а не на кожному виклику окремо. */
type Rec = Record<string, any>;
const db = { entries: [] as Rec[], matches: [] as Rec[], booking: {} as Rec };

const matchWhere = (r: Rec, where: Rec = {}) =>
  Object.entries(where).every(([k, v]) => r[k] === v);

const apply = (r: Rec, data: Rec) => {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as Rec)) r[k] += (v as Rec).increment;
    else r[k] = v;
  }
};

const prisma = {
  booking: {
    findFirst: vi.fn(async ({ where }: Rec) => (where.id === db.booking.id && where.clubId === db.booking.clubId ? { ...db.booking } : null)),
    update: vi.fn(async ({ data }: Rec) => { Object.assign(db.booking, data); return db.booking; }),
    updateMany: vi.fn(async ({ where, data }: Rec) => {
      if (where.tournamentStatus && db.booking.tournamentStatus !== where.tournamentStatus) return { count: 0 };
      Object.assign(db.booking, data); return { count: 1 };
    }),
  },
  bookingSeat: { findMany: vi.fn(async () => []) },
  clubPlayerRating: { findFirst: vi.fn(async () => ({ playerId: 'x' })) },
  player: { findUnique: vi.fn(async ({ where }: Rec) => ({ id: where.id, name: `Г${where.id.slice(-1)}` })) },
  ratingChange: { findMany: vi.fn(async () => []) },
  court: { findFirst: vi.fn(async ({ where }: Rec) => (where.id === COURT ? { id: COURT } : null)) },
  user: { findUniqueOrThrow: vi.fn(async () => ({ email: 'moder@club.test', role: 'ADMIN' })) },
  changeLog: { createMany: vi.fn(async () => ({ count: 1 })) },
  tournamentEntry: {
    findMany: vi.fn(async ({ where }: Rec) => db.entries.filter((e) => matchWhere(e, where)).sort((a, b) => a.seed - b.seed).map((e) => ({ ...e }))),
    deleteMany: vi.fn(async () => { db.entries = []; }),
    createMany: vi.fn(async ({ data }: Rec) => { for (const d of data) db.entries.push({ id: randomUUID(), withdrawnAt: null, seatId: null, customerId: null, ...d }); }),
    update: vi.fn(async ({ where, data }: Rec) => { apply(db.entries.find((e) => e.id === where.id)!, data); }),
    updateMany: vi.fn(async ({ data }: Rec) => { db.entries.forEach((e) => apply(e, data)); }),
  },
  tournamentMatch: {
    findMany: vi.fn(async ({ where }: Rec) => db.matches.filter((m) => matchWhere(m, where)).sort((a, b) => a.round - b.round || a.slot - b.slot).map((m) => ({ ...m }))),
    findFirst: vi.fn(async ({ where }: Rec) => { const m = db.matches.find((x) => matchWhere(x, where)); return m ? { ...m } : null; }),
    createMany: vi.fn(async ({ data }: Rec) => { for (const d of data) db.matches.push({ scheduledAt: null, startedAt: null, finishedAt: null, courtId: null, note: null, version: 0, ...d }); }),
    update: vi.fn(async ({ where, data }: Rec) => { apply(db.matches.find((m) => m.id === where.id)!, data); }),
    updateMany: vi.fn(async ({ where, data }: Rec) => {
      const m = db.matches.find((x) => matchWhere(x, where));
      if (!m) return { count: 0 };
      apply(m, data);
      return { count: 1 };
    }),
    deleteMany: vi.fn(async () => { db.matches = []; }),
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
};

const auth = { userId: 'moder', clubId: 'club', role: 'ADMIN', trainerId: null as string | null };

vi.mock('../../lib/db', () => ({ prisma, isSlotTakenError: () => false }));
vi.mock('./shared', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => { req.auth = auth; next(); },
  param: (req: { params: Record<string, string> }, key: string) => req.params[key],
}));

const { tournamentsRouter } = await import('./tournaments');
const app = express().use(express.json()).use(tournamentsRouter);

const COURT = '11111111-1111-4111-8111-111111111111';
const BID = '22222222-2222-4222-8222-222222222222';

const put = (names: string[]) => request(app).put(`/tournaments/${BID}/entries`).send({ entries: names.map((name) => ({ name })) });
const start = (body: Rec = {}) => request(app).post(`/tournaments/${BID}/start`).send(body);
const get = () => request(app).get(`/tournaments/${BID}`);
const patch = (id: string, body: Rec) => request(app).patch(`/tournaments/matches/${id}`).send(body);
const logged = () => prisma.changeLog.createMany.mock.calls.flatMap((c: any[]) => c[0].data);

const find = (body: Rec, r: number, s: number) => body.matches.find((m: Rec) => m.round === r && m.slot === s);
const entryId = (body: Rec, seed: number) => body.entries.find((e: Rec) => e.seed === seed).id;
const win = (id: string, version = 0) => patch(id, { version, sets: [{ a: 6, b: 1 }, { a: 6, b: 2 }] });

async function running(n = 4, thirdPlace = false) {
  await put(Array.from({ length: n }, (_, i) => `P${i + 1}`));
  return (await start({ thirdPlace })).body;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = 'ADMIN';
  auth.trainerId = null;
  db.entries = [];
  db.matches = [];
  db.booking = {
    id: BID, clubId: 'club', courtId: COURT, capacity: 16, title: '🏆 Кубок', trainerId: null,
    tournamentStatus: null, tournamentFormat: null, thirdPlace: false, startTime: new Date('2030-01-01T08:00:00Z'),
  };
});

describe('учасники й старт', () => {
  it('зберігає склад з посівом і ставить DRAFT', async () => {
    const r = await put(['Іван', 'Олег', 'Марія']);
    expect(r.status).toBe(200);
    expect(r.body.tournament.status).toBe('DRAFT');
    expect(r.body.entries.map((e: Rec) => [e.seed, e.name])).toEqual([[1, 'Іван'], [2, 'Олег'], [3, 'Марія']]);
  });

  it('генерує сітку: 1 проти 4, 2 проти 3, склад заблоковано', async () => {
    const body = await running(4, true);
    expect(body.tournament.status).toBe('RUNNING');
    expect(body.matches).toHaveLength(4);
    expect(find(body, 1, 0)).toMatchObject({ entryAId: entryId(body, 1), entryBId: entryId(body, 4) });
    expect(find(body, 2, 1)).toBeDefined();
    const locked = await put(['x', 'y']);
    expect(locked.status).toBe(409);
    expect(locked.body.error).toBe('TOURNAMENT_LOCKED');
  });

  it('менше двох учасників — не стартує', async () => {
    await put(['Сам']);
    expect((await start()).status).toBe(400);
  });
});

describe('рахунок і проходження', () => {
  it('виводить переможця зі сетів і проводить у фінал', async () => {
    const body = await running();
    const m = find(body, 1, 0);
    const r = await win(m.id);
    expect(r.status).toBe(200);
    expect(r.body.match).toMatchObject({ status: 'DONE', winnerEntryId: m.entryAId, version: 1 });
    expect(find(r.body, 2, 0).entryAId).toBe(m.entryAId);
    expect(logged().some((c: Rec) => c.entity === 'TOURNAMENT' && c.field === 'match:1-0')).toBe(true);
  });

  it('409 VERSION_CONFLICT зі свіжим матчем', async () => {
    const body = await running();
    const m = find(body, 1, 0);
    await patch(m.id, { version: 0, note: 'перша правка' });
    const r = await patch(m.id, { version: 0, note: 'друга' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('VERSION_CONFLICT');
    expect(r.body.match).toMatchObject({ id: m.id, version: 1, note: 'перша правка' });
  });

  it('WALKOVER без переможця — 400', async () => {
    const body = await running();
    const r = await patch(find(body, 1, 0).id, { version: 0, status: 'WALKOVER' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('WINNER_REQUIRED');
  });

  it('матч, де ще не відомий суперник, рахунку не приймає', async () => {
    const body = await running();
    const r = await win(find(body, 2, 0).id);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('MATCH_NOT_READY');
  });
});

describe('виправлення результату', () => {
  async function finalReady() {
    const body = await running();
    await win(find(body, 1, 0).id);
    const r = await win(find(body, 1, 1).id);
    return r.body;
  }

  it('зміна переможця завершеного матчу вимагає причину', async () => {
    const body = await finalReady();
    const m = find(body, 1, 0);
    const r = await patch(m.id, { version: m.version, winner: 'B' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('REASON_REQUIRED');
  });

  it('з причиною підміняє учасника наступного матчу й пише журнал', async () => {
    const body = await finalReady();
    const m = find(body, 1, 0);
    const r = await patch(m.id, { version: m.version, winner: 'B', reason: 'помилка в рахунку' });
    expect(r.status).toBe(200);
    expect(find(r.body, 2, 0).entryAId).toBe(m.entryBId);
    expect(logged().some((c: Rec) => c.field === 'reason' && c.after === 'помилка в рахунку')).toBe(true);
  });

  it('зіграний фінал: DOWNSTREAM_PLAYED, а з force — скидається', async () => {
    let body = await finalReady();
    const fin = find(body, 2, 0);
    body = (await win(fin.id, fin.version)).body;
    const m = find(body, 1, 0);
    const r = await patch(m.id, { version: m.version, winner: 'B', reason: 'виправлення' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('DOWNSTREAM_PLAYED');
    expect(r.body.matches.map((x: Rec) => x.id)).toEqual([fin.id]);

    const forced = await patch(m.id, { version: m.version, winner: 'B', reason: 'виправлення', force: true });
    expect(forced.status).toBe(200);
    expect(find(forced.body, 2, 0)).toMatchObject({ status: 'PENDING', winnerEntryId: null, sets: [], entryAId: m.entryBId });
  });
});

describe('зняття, завершення, скидання', () => {
  it('зняття учасника дає WALKOVER суперникові', async () => {
    const body = await running();
    const out = entryId(body, 1);
    const r = await request(app).post(`/tournaments/${BID}/withdraw/${out}`).send({});
    expect(r.status).toBe(200);
    const m = find(r.body, 1, 0);
    expect(m).toMatchObject({ status: 'WALKOVER', winnerEntryId: entryId(body, 4) });
    expect(find(r.body, 2, 0).entryAId).toBe(entryId(body, 4));
    expect(r.body.entries.find((e: Rec) => e.id === out).withdrawnAt).toBeTruthy();
  });

  it('finish без зіграного фіналу — FINAL_NOT_PLAYED', async () => {
    await running();
    const r = await request(app).post(`/tournaments/${BID}/finish`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('FINAL_NOT_PLAYED');
  });

  it('з матчем за 3-є місце finish чекає і його', async () => {
    let body = await running(4, true);
    await win(find(body, 1, 0).id);
    body = (await win(find(body, 1, 1).id)).body;
    body = (await win(find(body, 2, 0).id, find(body, 2, 0).version)).body;
    expect((await request(app).post(`/tournaments/${BID}/finish`)).body.error).toBe('FINAL_NOT_PLAYED');
    await win(find(body, 2, 1).id, find(body, 2, 1).version);
    expect((await request(app).post(`/tournaments/${BID}/finish`)).status).toBe(200);
  });

  it('знятий учасник: суперник відомий пізніше — автоматичний WO після PATCH', async () => {
    let body = await running();
    // P3 знімаємо до того, як відомий його суперник у фіналі (півфінал 2-3 ще не зіграний)
    const p3 = entryId(body, 3);
    await request(app).post(`/tournaments/${BID}/withdraw/${p3}`).send({});
    body = (await get()).body;
    // P2 vs P3: WO уже на користь P2; фінал: P1/P4 переможець проти P2
    expect(find(body, 1, 1)).toMatchObject({ status: 'WALKOVER', winnerEntryId: entryId(body, 2) });
    // знімаємо P2 теж: у фіналі ще немає суперника P1/P4
    await request(app).post(`/tournaments/${BID}/withdraw/${entryId(body, 2)}`).send({});
    body = (await get()).body;
    expect(find(body, 2, 0).status).toBe('PENDING');
    const m = find(body, 1, 0);
    const r = await win(m.id, m.version);
    expect(r.status).toBe(200);
    expect(find(r.body, 2, 0)).toMatchObject({ status: 'WALKOVER', winnerEntryId: m.entryAId });
  });

  it('FINISHED блокує правки, reopen — лише OWNER', async () => {
    const body = await running();
    db.booking.tournamentStatus = 'FINISHED';
    const r = await win(find(body, 1, 0).id);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('TOURNAMENT_FINISHED');

    expect((await request(app).post(`/tournaments/${BID}/reopen`)).status).toBe(403);
    auth.role = 'OWNER';
    const re = await request(app).post(`/tournaments/${BID}/reopen`);
    expect(re.status).toBe(200);
    expect(re.body.tournament.status).toBe('RUNNING');
  });

  it('скидання сітки із зіграним матчем: лише OWNER з причиною', async () => {
    const body = await running();
    await win(find(body, 1, 0).id);
    expect((await request(app).delete(`/tournaments/${BID}/bracket`).send({ reason: 'x' })).status).toBe(403);
    auth.role = 'OWNER';
    expect((await request(app).delete(`/tournaments/${BID}/bracket`).send({})).body.error).toBe('REASON_REQUIRED');
    const r = await request(app).delete(`/tournaments/${BID}/bracket`).send({ reason: 'перезапуск' });
    expect(r.status).toBe(200);
    expect(r.body.tournament.status).toBe('DRAFT');
    expect(r.body.matches).toEqual([]);
  });
});

describe('права', () => {
  it('тренер чужого турніру отримує 403', async () => {
    auth.role = 'TRAINER';
    auth.trainerId = 'other';
    db.booking.trainerId = 'mine';
    expect((await get()).status).toBe(403);
  });

  it('тренер свого турніру читає, але не вводить рахунок, корт чи склад', async () => {
    const body = await running();
    auth.role = 'TRAINER';
    auth.trainerId = 'mine';
    db.booking.trainerId = 'mine';
    expect((await get()).status).toBe(200);
    const m = find(body, 1, 0);
    expect((await patch(m.id, { version: 0, courtId: COURT })).status).toBe(403);
    expect((await win(m.id)).status).toBe(403);
    expect((await put(['a', 'b'])).status).toBe(403);
    expect((await start()).status).toBe(403);
  });

  it('чужий клуб — 404', async () => {
    auth.clubId = 'other';
    expect((await get()).status).toBe(404);
    auth.clubId = 'club';
  });
});

describe('налаштування турніру (tournamentSettings)', () => {
  const sq = { teamSize: 1, setsToWin: 2, pointsToWin: 11 };
  beforeEach(() => { db.booking.tournamentSport = 'SQUASH'; db.booking.tournamentSettings = sq; db.booking.tournamentSetsToWin = 2; });
  const sets = (...p: number[][]) => p.map(([a, b]) => ({ a, b }));

  it('авто-DONE лише при завершених сетах і переможці за matchWinner', async () => {
    const m = find(await running(), 1, 0);
    let r = await patch(m.id, { version: 0, sets: sets([11, 5], [11, 10]) });
    expect([r.status, r.body.match.status]).toEqual([200, 'PENDING']);
    r = await patch(m.id, { version: 1, sets: sets([11, 5], [12, 10]) });
    expect([r.status, r.body.match.status, r.body.match.winnerEntryId]).toEqual([200, 'DONE', m.entryAId]);
  });
  it('LIVE дозволяє незавершений останній сет', async () => {
    const m = find(await running(), 1, 0);
    const r = await patch(m.id, { version: 0, status: 'LIVE', sets: sets([11, 5], [3, 2]) });
    expect([r.status, r.body.match.status]).toEqual([200, 'LIVE']);
  });
  it('DONE без фінального рахунку — 400 SCORE_NOT_FINAL', async () => {
    const m = find(await running(), 1, 0);
    const r = await patch(m.id, { version: 0, status: 'DONE', sets: sets([11, 5]) });
    expect([r.status, r.body.error]).toEqual([400, 'SCORE_NOT_FINAL']);
    const r2 = await patch(m.id, { version: 0, winner: 'A' });
    expect([r2.status, r2.body.error]).toEqual([400, 'SCORE_NOT_FINAL']);
  });
  it('зайві сети — 400 TOO_MANY_SETS', async () => {
    const m = find(await running(), 1, 0);
    const r = await patch(m.id, { version: 0, sets: sets([11, 5], [11, 6], [11, 7]) });
    expect([r.status, r.body.error]).toEqual([400, 'TOO_MANY_SETS']);
  });
  it('некоректний сет — 400 BAD_SET_SCORE', async () => {
    const m = find(await running(), 1, 0);
    let r = await patch(m.id, { version: 0, sets: sets([12, 5]) });
    expect([r.status, r.body.error]).toEqual([400, 'BAD_SET_SCORE']);
    r = await patch(m.id, { version: 0, sets: sets([11, 10], [11, 5]) });
    expect([r.status, r.body.error]).toEqual([400, 'BAD_SET_SCORE']);
  });
  it('WALKOVER звільнений від перевірки рахунку', async () => {
    const m = find(await running(), 1, 0);
    const r = await patch(m.id, { version: 0, status: 'WALKOVER', winner: 'A', sets: sets([3, 1]) });
    expect([r.status, r.body.match.status]).toEqual([200, 'WALKOVER']);
  });
  it('settings = null — стара поведінка (будь-який рахунок)', async () => {
    db.booking.tournamentSettings = null; db.booking.tournamentSetsToWin = null;
    const m = find(await running(), 1, 0);
    const r = await patch(m.id, { version: 0, sets: sets([12, 5], [3, 1]) });
    expect([r.status, r.body.match.status]).toEqual([200, 'DONE']);
  });
  it('PATCH settings: у DRAFT пише settings, teamSize і setsToWin; пізніше — 409 NOT_DRAFT', async () => {
    db.booking.tournamentStatus = 'DRAFT';
    const url = `/tournaments/${BID}/settings`;
    let r = await request(app).patch(url).send({ settings: { teamSize: 1, setsToWin: 1, pointsToWin: 15 } });
    expect([r.status, r.body.setsToWin]).toEqual([200, 1]);
    expect(db.booking.tournamentSettings).toEqual({ teamSize: 1, setsToWin: 1, pointsToWin: 15 });
    expect(db.booking.tournamentSetsToWin).toBe(1);
    r = await request(app).patch(url).send({ settings: { teamSize: 2, setsToWin: 1 } });
    expect([r.status, r.body.error]).toEqual([400, 'BAD_TEAM_SIZE']);
    db.booking.tournamentStatus = 'RUNNING';
    r = await request(app).patch(url).send({ settings: sq });
    expect([r.status, r.body.error]).toEqual([409, 'NOT_DRAFT']);
  });
  it('GET віддає settings', async () => {
    expect((await get()).body.tournament.settings).toEqual(sq);
  });
});

describe('парний турнір 2×2', () => {
  const P = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const putTeams = (list: Rec[]) => request(app).put(`/tournaments/${BID}/entries`).send({ entries: list.map((e) => ({ name: 'x', ...e })) });
  beforeEach(() => { db.booking.tournamentTeamSize = 2; });

  it('пари зберігаються з партнером і назвою «A / B»', async () => {
    const r = await putTeams([{ playerId: P(1), partnerPlayerId: P(2) }, { playerId: P(3), partnerPlayerId: P(4) }]);
    expect(r.status).toBe(200);
    expect(r.body.tournament.teamSize).toBe(2);
    expect(r.body.entries[0]).toMatchObject({ name: "Г1 / Г2", playerId: P(1), partnerPlayerId: P(2) });
  });
  it('без партнера — 409 PARTNER_REQUIRED', async () => {
    const r = await putTeams([{ playerId: P(1) }, { playerId: P(3), partnerPlayerId: P(4) }]);
    expect([r.status, r.body.error]).toEqual([409, 'PARTNER_REQUIRED']);
  });
  it('той самий гравець у двох парах — 409 DUPLICATE_PLAYER', async () => {
    const r = await putTeams([{ playerId: P(1), partnerPlayerId: P(2) }, { playerId: P(3), partnerPlayerId: P(1) }]);
    expect([r.status, r.body.error]).toEqual([409, 'DUPLICATE_PLAYER']);
  });
});
