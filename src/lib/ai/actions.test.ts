import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Мінімальний «Prisma» у памʼяті: рівно ті виклики, які використовує actions.ts. */
type Row = Record<string, any>;
const state = { actions: [] as Row[], policy: null as Row | null, seq: 0 };

const matches = (row: Row, where: Row) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && 'lte' in v) return row[k] <= v.lte;
  if (v && typeof v === 'object' && 'gt' in v) return row[k] > v.gt;
  if (v && typeof v === 'object' && 'gte' in v) return row[k] != null && row[k] >= v.gte;
  if (v && typeof v === 'object' && 'notIn' in v) return !v.notIn.includes(row[k]);
  return row[k] === v;
});

const prisma = {
  club: { findUnique: vi.fn(async () => ({ timezone: 'Europe/Kyiv' })) },
  aiAgentPolicy: { findUnique: vi.fn(async () => state.policy) },
  aiAction: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: `a${++state.seq}`, status: 'PENDING', decidedAt: null, decidedById: null, executedAt: null, result: null, error: null, createdAt: new Date(), ...data };
      state.actions.push(row);
      return { ...row };
    }),
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      const r = state.actions.find((a) => matches(a, where));
      return r ? { ...r } : null;
    }),
    findFirstOrThrow: vi.fn(async ({ where }: { where: Row }) => ({ ...state.actions.find((a) => matches(a, where))! })),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = state.actions.filter((a) => matches(a, where));
      hit.forEach((a) => Object.assign(a, data));
      return { count: hit.length };
    }),
    count: vi.fn(async ({ where }: { where: Row }) => state.actions.filter((a) => matches(a, where)).length),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const r = state.actions.find((a) => a.id === where.id)!;
      Object.assign(r, data);
      return { ...r };
    }),
  },
};
vi.mock('../db', () => ({ prisma }));

const { ACTION_TTL_MS, AiActionError, approveAction, expireStaleActions, proposeAction, registerExecutor, rejectAction, resetExecutors } = await import('./actions');

const execute = vi.fn(async (_clubId: string, payload: unknown) => ({ done: payload }));
const owner = { id: 'owner-1', clubId: 'club-1' };
const propose = (over: Record<string, unknown> = {}) => proposeAction({
  clubId: 'club-1', kind: 'booking.create', payload: { court: 1 }, summary: 'Створити бронь',
  requester: { id: 'owner-1', role: 'OWNER' }, ...over,
} as Parameters<typeof proposeAction>[0]);
const code = async (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof AiActionError ? e.code : e));

beforeEach(() => {
  vi.clearAllMocks();
  state.actions = []; state.policy = null; state.seq = 0;
  resetExecutors();
  execute.mockImplementation(async (_c, payload) => ({ done: payload }));
  registerExecutor('booking.create', { scope: 'bookings', execute });
});

describe('proposeAction', () => {
  it('OFF — відмова, нічого не записано', async () => {
    state.policy = { bookings: 'OFF' };
    expect(await code(propose())).toBe('AI_ACTION_FORBIDDEN');
    expect(state.actions).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('ASK (типово) — PENDING на 48 годин, виконавець не викликаний', async () => {
    const before = Date.now();
    const a = await propose();
    expect(a.status).toBe('PENDING');
    expect(execute).not.toHaveBeenCalled();
    expect(a.expiresAt.getTime() - before).toBeGreaterThanOrEqual(ACTION_TTL_MS);
    expect(a.expiresAt.getTime() - before).toBeLessThan(ACTION_TTL_MS + 5_000);
  });

  it('AUTO — виконується одразу, рішення без людини', async () => {
    state.policy = { bookings: 'AUTO' };
    const a = await propose();
    expect(execute).toHaveBeenCalledWith('club-1', { court: 1 }, expect.objectContaining({ requestedRole: 'OWNER', decidedById: null }));
    expect(a).toMatchObject({ status: 'EXECUTED', result: { done: { court: 1 } }, decidedById: null });
    expect(a.executedAt).toBeInstanceOf(Date);
  });

  it('AUTO, виконавець упав — FAILED з повідомленням, без винятку', async () => {
    state.policy = { bookings: 'AUTO' };
    execute.mockRejectedValue(new Error('Слот зайнятий'));
    expect(await propose()).toMatchObject({ status: 'FAILED', error: 'Слот зайнятий' });
  });

  it('режим береться для ролі запитувача: ADMIN без доступу — відмова, з доступом — перетин з власником', async () => {
    state.policy = { bookings: 'ASK', roleAccess: {} };
    expect(await code(propose({ requester: { id: 'u2', role: 'ADMIN' } }))).toBe('AI_ACTION_FORBIDDEN');

    state.policy = { bookings: 'ASK', roleAccess: { ADMIN: { enabled: true, bookings: 'AUTO' } } };
    const a = await propose({ requester: { id: 'u2', role: 'ADMIN' } });
    expect(a.status).toBe('PENDING'); // AUTO ролі обрізано до ASK власника
  });

  it('невідомий kind — відмова', async () => {
    expect(await code(propose({ kind: 'nope' }))).toBe('AI_ACTION_UNKNOWN_KIND');
  });

  it('summary обрізається до 500 символів', async () => {
    const a = await propose({ summary: 'я'.repeat(900) });
    expect(a.summary).toHaveLength(500);
  });
});

describe('approveAction / rejectAction', () => {
  it('approve виконує й записує, хто підтвердив', async () => {
    const p = await propose();
    const a = await approveAction(p.id, owner);
    expect(a).toMatchObject({ status: 'EXECUTED', decidedById: 'owner-1', result: { done: { court: 1 } } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('повторне підтвердження виконує один раз (подвійний клік)', async () => {
    const p = await propose();
    const results = await Promise.all([code(approveAction(p.id, owner)), code(approveAction(p.id, owner))]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r === 'AI_ACTION_NOT_PENDING')).toHaveLength(1);
  });

  it('політику перевіряємо знову: власник вимкнув після пропозиції — FAILED, виконавець не викликаний', async () => {
    const p = await propose();
    state.policy = { bookings: 'OFF' };
    const a = await approveAction(p.id, owner);
    expect(a).toMatchObject({ status: 'FAILED', error: 'AI_ACTION_FORBIDDEN' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('роль запитувача втратила доступ — теж FAILED', async () => {
    state.policy = { roleAccess: { ADMIN: { enabled: true, bookings: 'ASK' } } };
    const p = await propose({ requester: { id: 'u2', role: 'ADMIN' } });
    state.policy = { roleAccess: {} };
    expect(await approveAction(p.id, owner)).toMatchObject({ status: 'FAILED', error: 'AI_ACTION_FORBIDDEN' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('виконавець упав при підтвердженні — FAILED з помилкою', async () => {
    const p = await propose();
    execute.mockRejectedValue(new Error('boom'));
    expect(await approveAction(p.id, owner)).toMatchObject({ status: 'FAILED', error: 'boom' });
  });

  it('виконавця вже нема (kind зник після деплою) — FAILED', async () => {
    const p = await propose();
    resetExecutors();
    expect(await approveAction(p.id, owner)).toMatchObject({ status: 'FAILED', error: 'AI_ACTION_UNKNOWN_KIND' });
  });

  it('чужий клуб — «не знайдено», нічого не виконано', async () => {
    const p = await propose();
    expect(await code(approveAction(p.id, { id: 'x', clubId: 'club-2' }))).toBe('AI_ACTION_NOT_FOUND');
    expect(await code(rejectAction(p.id, { id: 'x', clubId: 'club-2' }))).toBe('AI_ACTION_NOT_FOUND');
    expect(state.actions[0].status).toBe('PENDING');
  });

  it('прострочена — EXPIRED і відмова', async () => {
    const p = await propose();
    state.actions[0].expiresAt = new Date(Date.now() - 1000);
    expect(await code(approveAction(p.id, owner))).toBe('AI_ACTION_EXPIRED');
    expect(state.actions[0].status).toBe('EXPIRED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('reject ставить REJECTED, а потім approve неможливий', async () => {
    const p = await propose();
    expect(await rejectAction(p.id, owner)).toMatchObject({ status: 'REJECTED', decidedById: 'owner-1' });
    expect(await code(approveAction(p.id, owner))).toBe('AI_ACTION_NOT_PENDING');
    expect(execute).not.toHaveBeenCalled();
  });

  it('expireStaleActions переводить лише прострочені PENDING свого клубу', async () => {
    await propose(); await propose();
    state.actions[0].expiresAt = new Date(Date.now() - 1000);
    await expireStaleActions('club-1');
    expect(state.actions.map((a) => a.status)).toEqual(['EXPIRED', 'PENDING']);
  });
});

describe('claim і клуб', () => {
  it('прострочену дію claim не бере навіть без попередньої перевірки', async () => {
    const p = await propose();
    state.actions[0].expiresAt = new Date(Date.now() - 1000);
    expect(await code(approveAction(p.id, owner))).toBe('AI_ACTION_EXPIRED');
    expect(state.actions[0].decidedAt).toBeNull();
  });
});
