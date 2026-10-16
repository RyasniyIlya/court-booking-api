import { beforeEach, describe, expect, it, vi } from 'vitest';

const tx = {
  tournamentEntry: { update: vi.fn() },
  tournamentMatch: { createMany: vi.fn() },
  booking: { update: vi.fn() },
};
const prisma = {
  tournamentEntry: { findMany: vi.fn(), count: vi.fn() },
  user: { findUniqueOrThrow: vi.fn() },
  $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
};
vi.mock('./db', () => ({ prisma }));
const recordChanges = vi.fn();
vi.mock('./changeLog', () => ({ recordChanges }));

const { startTournamentBracket } = await import('./tournamentStart');

const booking = { id: 'b1', tournamentStatus: 'DRAFT' as const, thirdPlace: false, tournamentScope: null };
const actor = { clubId: 'c1', userId: 'u1' };
const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i + 1}` }));

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tournamentEntry.findMany.mockResolvedValue(entries(4));
  prisma.user.findUniqueOrThrow.mockResolvedValue({ email: 'o@c.ua', role: 'OWNER' });
});

describe('startTournamentBracket', () => {
  it('порядок складу без жеребкування: сіви не чіпаємо, сітка й статус RUNNING', async () => {
    const out = await startTournamentBracket(booking, { thirdPlace: true }, actor, async (_t, s) => s);
    expect(out).toEqual({ ok: true, value: { tournamentStatus: 'RUNNING', thirdPlace: true } });
    expect(tx.tournamentEntry.update).not.toHaveBeenCalled();
    expect(tx.tournamentMatch.createMany).toHaveBeenCalledTimes(1);
    expect(tx.booking.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { tournamentStatus: 'RUNNING', thirdPlace: true } });
  });

  it('жеребкування: усі сіви переписуються у два проходи (унікальність bookingId+seed)', async () => {
    await startTournamentBracket(booking, { shuffle: true }, actor, async () => null);
    const seeds = tx.tournamentEntry.update.mock.calls.map((c) => c[0].data.seed);
    expect(seeds.slice(0, 4).every((s: number) => s < 0)).toBe(true);
    expect(seeds.slice(4).sort()).toEqual([1, 2, 3, 4]);
    expect(recordChanges.mock.calls[0][3]).toContainEqual({ field: 'seeding', before: null, after: 'shuffle' });
  });

  it('відмови без запису: федерація, вже запущений, мало учасників; матч за 3 місце лише від 4', async () => {
    expect(await startTournamentBracket({ ...booking, tournamentScope: 'FEDERATION' }, {}, actor, async () => 0)).toMatchObject({ ok: false, status: 403 });
    expect(await startTournamentBracket({ ...booking, tournamentStatus: 'RUNNING' }, {}, actor, async () => 0)).toMatchObject({ ok: false, status: 409, error: 'ALREADY_STARTED' });
    prisma.tournamentEntry.findMany.mockResolvedValue(entries(1));
    expect(await startTournamentBracket(booking, {}, actor, async () => 0)).toMatchObject({ ok: false, status: 400, error: 'TOO_FEW_ENTRIES' });
    expect(tx.tournamentMatch.createMany).not.toHaveBeenCalled();

    prisma.tournamentEntry.findMany.mockResolvedValue(entries(3));
    const out = await startTournamentBracket(booking, { thirdPlace: true }, actor, async (_t, s) => s);
    expect(out).toMatchObject({ ok: true, value: { thirdPlace: false } });
  });
});
