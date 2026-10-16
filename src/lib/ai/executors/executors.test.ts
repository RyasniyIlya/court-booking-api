import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';

/**
 * Виконавці ІІ-менеджера: від пропозиції до виконання через журнал.
 * Доменні функції (createAdminBooking, patchAdminBooking, startTournamentBracket)
 * замінені заглушками — їхня власна поведінка покрита тестами роутів; тут
 * перевіряємо, що виконавець викликає саме їх, з правильними даними, а їхні
 * відмови перетворює на FAILED з українським текстом.
 */

type Row = Record<string, any>;
const state = {
  actions: [] as Row[], policy: null as Row | null, seq: 0,
  court: { id: '', name: 'Корт 2' } as Row | null,
  customer: { id: '', name: 'Олена Коваль', phone: '+380671112233' } as Row | null,
  trainer: { id: '', name: 'Ігор' } as Row | null,
  hours: null as Row | null,
  block: null as Row | null,
  booking: null as Row | null,
  user: { id: 'u-owner', role: 'OWNER' } as Row | null,
};

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
  court: { findFirst: vi.fn(async () => state.court) },
  customer: { findFirst: vi.fn(async () => state.customer) },
  trainer: { findFirst: vi.fn(async () => state.trainer) },
  clubHours: { findUnique: vi.fn(async () => state.hours) },
  block: { findFirst: vi.fn(async () => state.block) },
  booking: { findFirst: vi.fn(async () => state.booking) },
  user: { findFirst: vi.fn(async () => state.user) },
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
vi.mock('../../db', () => ({ prisma }));

const createAdminBooking = vi.fn();
const patchAdminBooking = vi.fn();
vi.mock('../../adminBookings', async () => ({
  ...(await vi.importActual<object>('../../adminBookings')),
  createAdminBooking, patchAdminBooking,
}));
const startTournamentBracket = vi.fn();
vi.mock('../../tournamentStart', () => ({ startTournamentBracket }));

const { AiActionError, approveAction, proposeAction } = await import('../actions');
await import('./index');

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const COURT = UUID(1);
const OWNER = { id: 'u-owner', clubId: 'club-1' };

/** Наступний четвер о заданій годині за часом клубу — завжди в майбутньому й у робочий день. */
const slot = (h1 = 18, h2 = 19) => {
  const base = DateTime.now().setZone('Europe/Kyiv').plus({ days: 7 }).startOf('day');
  return { start: base.set({ hour: h1 }).toISO()!, end: base.set({ hour: h2 }).toISO()! };
};

const propose = (kind: string, payload: unknown, requester: { id: string | null; role: any } = { id: 'u-owner', role: 'OWNER' }) =>
  proposeAction({ clubId: 'club-1', kind, payload, requester });
const code = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof AiActionError ? [e.code, e.detail] : e));

beforeEach(() => {
  vi.clearAllMocks();
  state.actions = []; state.policy = null; state.seq = 0;
  state.court = { id: COURT, name: 'Корт 2' };
  state.customer = { id: UUID(2), name: 'Олена Коваль', phone: '+380671112233' };
  state.trainer = { id: UUID(3), name: 'Ігор' };
  state.hours = null; state.block = null; state.booking = null;
  state.user = { id: 'u-owner', role: 'OWNER' };
  createAdminBooking.mockResolvedValue({ status: 201, body: { id: UUID(10), priceTotal: 90000, status: 'PENDING' } });
  patchAdminBooking.mockResolvedValue({ status: 200, body: { ok: true } });
  startTournamentBracket.mockImplementation(async (_b, _o, _a, after) => ({ ok: true, value: await after({}, {}) }));
});

describe('booking.create', () => {
  const payload = () => ({ courtId: COURT, ...slot(), customerName: 'Олена Коваль', customerPhone: '+380671112233' });

  it('ASK: пропозиція з людським описом від коду, виконується після підтвердження тією ж функцією, що в кабінеті', async () => {
    const a = await propose('booking.create', payload());
    expect(a.status).toBe('PENDING');
    expect(a.summary).toMatch(/^Бронь: Корт 2, (пн|вт|ср|чт|пт|сб|нд) \d+ \S+ 18:00–19:00, Олена К\.$/);
    expect(createAdminBooking).not.toHaveBeenCalled();

    const done = await approveAction(a.id, OWNER);
    expect(done).toMatchObject({ status: 'EXECUTED', result: { bookingId: UUID(10), price: '900 грн' } });
    const [input, actor] = createAdminBooking.mock.calls[0];
    expect(input).toMatchObject({ courtId: COURT, customerName: 'Олена Коваль', customerPhone: '+380671112233', status: 'CONFIRMED' });
    expect(actor).toMatchObject({ clubId: 'club-1', userId: 'u-owner', viaAi: true });
  });

  it('клієнт за id підставляє імʼя й телефон з картки', async () => {
    const a = await propose('booking.create', { courtId: COURT, ...slot(), customerId: UUID(2) });
    await approveAction(a.id, OWNER);
    expect(createAdminBooking.mock.calls[0][0]).toMatchObject({ customerName: 'Олена Коваль', customerPhone: '+380671112233' });
  });

  it.each([
    ['без клієнта', () => ({ courtId: COURT, ...slot() })],
    ['чужі поля', () => ({ ...payload(), sql: 'drop' })],
    ['кінець раніше за початок', () => ({ ...payload(), end: slot(17, 17).end })],
  ])('валідація: %s — AI_ACTION_INVALID, у журнал нічого не потрапляє', async (_n, make) => {
    expect((await code(propose('booking.create', make())))?.[0]).toBe('AI_ACTION_INVALID');
    expect(state.actions).toHaveLength(0);
  });

  it('корт не з цього клубу / минулий час / поза графіком / блокування — відмова з поясненням', async () => {
    state.court = null;
    expect(await code(propose('booking.create', payload()))).toEqual(['AI_ACTION_INVALID', 'Корт не знайдено в цьому клубі.']);
    state.court = { id: COURT, name: 'Корт 2' };

    const past = DateTime.now().minus({ days: 1 });
    expect((await code(propose('booking.create', { ...payload(), start: past.toISO(), end: past.plus({ hours: 1 }).toISO() })))?.[1]).toBe('Цей час уже минув.');

    state.hours = { openMinute: 8 * 60, closeMinute: 12 * 60, isClosed: false };
    expect((await code(propose('booking.create', payload())))?.[1]).toMatch(/поза графіком/);
    state.hours = { openMinute: 0, closeMinute: 0, isClosed: true };
    expect((await code(propose('booking.create', payload())))?.[1]).toBe('У цей день клуб не працює.');
    state.hours = null;

    state.block = { reason: 'ремонт' };
    expect((await code(propose('booking.create', payload())))?.[1]).toBe('Корт у цей час заблоковано (ремонт).');
  });

  it('виконання: слот зайняли, поки чекала черга — FAILED з українським текстом', async () => {
    const a = await propose('booking.create', payload());
    createAdminBooking.mockResolvedValue({ status: 409, body: { error: 'SLOT_TAKEN' } });
    expect(await approveAction(a.id, OWNER)).toMatchObject({ status: 'FAILED', error: 'Цей час на корті вже зайнятий.' });
  });

  it('виконання: між пропозицією й підтвердженням додали блокування — доменна функція не викликана', async () => {
    const a = await propose('booking.create', payload());
    state.block = { reason: null };
    expect(await approveAction(a.id, OWNER)).toMatchObject({ status: 'FAILED', error: 'Корт у цей час заблоковано.' });
    expect(createAdminBooking).not.toHaveBeenCalled();
  });

  it('виконання від імені ролі, що не керує бронями — FAILED', async () => {
    state.policy = { roleAccess: { TRAINER: { enabled: true, bookings: 'ASK' } } };
    const a = await propose('booking.create', payload(), { id: 'u-tr', role: 'TRAINER' });
    state.user = { id: 'u-tr', role: 'TRAINER' };
    expect(await approveAction(a.id, OWNER)).toMatchObject({ status: 'FAILED', error: 'Ця роль не може створювати чи змінювати бронювання.' });
  });

  it('AUTO виконує одразу, без рішення людини', async () => {
    state.policy = { bookings: 'AUTO' };
    const a = await propose('booking.create', payload());
    expect(a).toMatchObject({ status: 'EXECUTED', decidedById: null });
    expect(createAdminBooking).toHaveBeenCalledTimes(1);
  });
});

describe('booking.cancel / booking.reschedule', () => {
  const future = () => ({
    id: UUID(20), clubId: 'club-1', courtId: COURT, status: 'CONFIRMED', capacity: null, comment: 'VIP',
    customerName: 'Олена Коваль', startTime: new Date(slot().start), endTime: new Date(slot().end),
    court: { name: 'Корт 2' }, payment: null, ledgerEntries: [],
  });

  it('скасування: причина дописується в коментар, а не затирає його', async () => {
    state.booking = future();
    const a = await propose('booking.cancel', { bookingId: UUID(20), reason: 'клієнт захворів' });
    expect(a.summary).toMatch(/^Скасувати бронь: Корт 2, .*Олена К. — причина: клієнт захворів$/);
    expect(await approveAction(a.id, OWNER)).toMatchObject({ status: 'EXECUTED' });
    expect(patchAdminBooking).toHaveBeenCalledWith(UUID(20), { status: 'CANCELLED', comment: 'VIP · Скасовано: клієнт захворів' }, expect.objectContaining({ viaAi: true }));
  });

  it('оплачену бронь ІІ не скасовує — і на пропозиції, і на виконанні', async () => {
    state.booking = { ...future(), ledgerEntries: [{ kind: 'PAYMENT', amount: 50000 }] };
    expect((await code(propose('booking.cancel', { bookingId: UUID(20), reason: 'x' })))?.[1]).toMatch(/оплачена \(500 грн\)/);

    state.booking = future();
    const a = await propose('booking.cancel', { bookingId: UUID(20), reason: 'x' });
    state.booking = { ...future(), payment: { status: 'PAID', amount: 30000 } };
    expect(await approveAction(a.id, OWNER)).toMatchObject({ status: 'FAILED' });
    expect(patchAdminBooking).not.toHaveBeenCalled();
  });

  it('вже скасована між пропозицією й підтвердженням — FAILED', async () => {
    state.booking = future();
    const a = await propose('booking.cancel', { bookingId: UUID(20), reason: 'x' });
    state.booking = { ...future(), status: 'CANCELLED' };
    expect(await approveAction(a.id, OWNER)).toMatchObject({ status: 'FAILED', error: 'Бронь уже скасована або завершена.' });
  });

  it('групове заняття не скасовується як приватна бронь', async () => {
    state.booking = { ...future(), capacity: 8 };
    expect((await code(propose('booking.cancel', { bookingId: UUID(20), reason: 'x' })))?.[0]).toBe('AI_ACTION_INVALID');
  });

  it('перенесення: викликає ту саму правку, що PATCH у кабінеті; конфлікт слота — FAILED', async () => {
    state.booking = future();
    const to = slot(20, 21);
    const a = await propose('booking.reschedule', { bookingId: UUID(20), start: to.start, end: to.end });
    expect(a.summary).toMatch(/^Перенести бронь Олена К\.: Корт 2, .* → Корт 2, .*20:00–21:00$/);
    expect(await approveAction(a.id, OWNER)).toMatchObject({ status: 'EXECUTED' });
    expect(patchAdminBooking).toHaveBeenCalledWith(UUID(20), { courtId: COURT, start: to.start, end: to.end }, expect.anything());

    const b = await propose('booking.reschedule', { bookingId: UUID(20), start: to.start, end: to.end });
    patchAdminBooking.mockResolvedValue({ status: 409, body: { error: 'SLOT_TAKEN' } });
    expect(await approveAction(b.id, OWNER)).toMatchObject({ status: 'FAILED', error: 'Цей час на корті вже зайнятий.' });
  });
});

describe('groupSession.*', () => {
  const create = () => ({ courtId: COURT, ...slot(), title: 'Дитяча група', capacity: 8, pricePerSeat: 25000, trainerId: UUID(3) });

  it('створення: опис у гривнях, виконання через createAdminBooking з capacity', async () => {
    const a = await propose('groupSession.create', create());
    expect(a.summary).toMatch(/^Групове заняття «Дитяча група»: Корт 2, .*, тренер Ігор, 8 місць по 250 грн$/);
    expect(await approveAction(a.id, OWNER)).toMatchObject({ status: 'EXECUTED' });
    expect(createAdminBooking.mock.calls[0][0]).toMatchObject({ capacity: 8, title: 'Дитяча група', pricePerSeat: 25000, trainerId: UUID(3) });
  });

  it('валідація: 1 місце, невідомий тренер', async () => {
    expect((await code(propose('groupSession.create', { ...create(), capacity: 1 })))?.[0]).toBe('AI_ACTION_INVALID');
    state.trainer = null;
    expect((await code(propose('groupSession.create', create())))?.[1]).toBe('Тренера не знайдено або він неактивний.');
  });

  it('виконання: тариф без груп і зайнятий тренер перетворюються на FAILED', async () => {
    const a = await propose('groupSession.create', create());
    createAdminBooking.mockResolvedValue({ status: 402, body: { error: 'PLAN_REQUIRED' } });
    expect(await approveAction(a.id, OWNER)).toMatchObject({ status: 'FAILED', error: 'Групові заняття недоступні на тарифі клубу.' });

    const b = await propose('groupSession.create', create());
    createAdminBooking.mockResolvedValue({ status: 409, body: { error: 'TRAINER_BUSY' } });
    expect(await approveAction(b.id, OWNER)).toMatchObject({ status: 'FAILED', error: 'Тренер у цей час зайнятий.' });
  });

  const group = (seats: number) => ({
    id: UUID(30), clubId: 'club-1', courtId: COURT, status: 'CONFIRMED', capacity: 8, title: 'Йога', comment: null,
    startTime: new Date(slot().start), endTime: new Date(slot().end), court: { name: 'Корт 2' },
    seats: Array.from({ length: seats }, (_, i) => ({ id: `s${i}` })),
  });

  it('скасування порожнього заняття — виконується; з записаними учасниками — відмова', async () => {
    state.booking = group(0);
    const a = await propose('groupSession.cancel', { bookingId: UUID(30), reason: 'тренер хворий' });
    expect(await approveAction(a.id, OWNER)).toMatchObject({ status: 'EXECUTED' });
    expect(patchAdminBooking).toHaveBeenCalledWith(UUID(30), { status: 'CANCELLED', comment: 'Скасовано: тренер хворий' }, expect.anything());

    state.booking = group(3);
    expect((await code(propose('groupSession.cancel', { bookingId: UUID(30), reason: 'x' })))?.[1]).toMatch(/записано 3/);
  });
});

describe('tournament.buildBracket', () => {
  const tournament = (over: Row = {}) => ({
    id: UUID(40), title: '🏆 Осінь', capacity: 16, status: 'CONFIRMED', startTime: new Date(slot().start), endTime: new Date(slot().end),
    thirdPlace: false, tournamentScope: 'CLUB', tournamentStatus: 'DRAFT', tournamentTeamSize: 1, _count: { tournamentEntries: 8 }, ...over,
  });
  const payload = { tournamentId: UUID(40), seeding: 'shuffle', thirdPlace: true };

  it('happy path: стартує через startTournamentBracket з жеребкуванням', async () => {
    state.booking = tournament();
    const a = await propose('tournament.buildBracket', payload);
    expect(a.summary).toMatch(/^Сітка турніру «Осінь» \(.*\): 8 учасн\., жеребкування, з матчем за 3 місце$/);
    startTournamentBracket.mockImplementation(async (_b, _o, _a, after) => ({ ok: true, value: 7 }));
    expect(await approveAction(a.id, OWNER)).toMatchObject({ status: 'EXECUTED', result: { tournamentId: UUID(40), matches: 7 } });
    expect(startTournamentBracket.mock.calls[0].slice(1, 3)).toEqual([{ thirdPlace: true, shuffle: true }, { clubId: 'club-1', userId: 'u-owner' }]);
  });

  it('валідація стану: менше двох учасників, уже запущений, не турнір', async () => {
    state.booking = tournament({ _count: { tournamentEntries: 1 } });
    expect((await code(propose('tournament.buildBracket', payload)))?.[1]).toBe('Для сітки потрібно щонайменше двоє учасників.');
    state.booking = tournament({ tournamentStatus: 'RUNNING' });
    expect((await code(propose('tournament.buildBracket', payload)))?.[1]).toBe('Сітку вже зібрано.');
    state.booking = { ...tournament(), title: 'Йога', capacity: null };
    expect((await code(propose('tournament.buildBracket', payload)))?.[1]).toBe('Турнір не знайдено.');
  });

  it('виконання: турнір стартували руками між пропозицією й підтвердженням — FAILED', async () => {
    state.booking = tournament();
    const a = await propose('tournament.buildBracket', payload);
    state.booking = tournament({ tournamentStatus: 'RUNNING' });
    expect(await approveAction(a.id, OWNER)).toMatchObject({ status: 'FAILED', error: 'Сітку вже зібрано.' });
    expect(startTournamentBracket).not.toHaveBeenCalled();
  });

  it('відмова доменної функції (гравці не привʼязані) — FAILED з поясненням', async () => {
    state.booking = tournament();
    const a = await propose('tournament.buildBracket', payload);
    startTournamentBracket.mockResolvedValue({ ok: false, status: 409, error: 'PLAYERS_REQUIRED' });
    expect(await approveAction(a.id, OWNER)).toMatchObject({ status: 'FAILED', error: 'Не всі учасники привʼязані до гравців клубу.' });
  });
});

describe('добовий ліміт AUTO', () => {
  const payload = () => ({ courtId: COURT, ...slot(), customerName: 'Олена' });

  it('понад AI_AUTO_DAILY_CAP дія лишається PENDING, а не губиться; звіти ліміт не їдять', async () => {
    process.env.AI_AUTO_DAILY_CAP = '2';
    try {
      state.policy = { bookings: 'AUTO', reports: true };
      const statuses: string[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await propose('booking.create', payload())).status);
      expect(statuses).toEqual(['EXECUTED', 'EXECUTED', 'PENDING', 'PENDING']);
      expect(createAdminBooking).toHaveBeenCalledTimes(2);

      const report = await propose('report.xlsx', { type: 'bookings', from: '2026-10-01', to: '2026-10-15' });
      expect(report.status).toBe('EXECUTED');

      /* Людина може підтвердити те, що вийшло за ліміт. */
      const pending = state.actions.find((a) => a.status === 'PENDING')!;
      expect(await approveAction(pending.id, OWNER)).toMatchObject({ status: 'EXECUTED', decidedById: 'u-owner' });
    } finally {
      delete process.env.AI_AUTO_DAILY_CAP;
    }
  });

  it('ліміт рахується з журналу: рядки, виконані людиною, не зараховуються', async () => {
    process.env.AI_AUTO_DAILY_CAP = '1';
    try {
      state.policy = { bookings: 'AUTO' };
      state.actions.push({ id: 'old', clubId: 'club-1', kind: 'booking.create', status: 'EXECUTED', decidedAt: new Date(), decidedById: 'u-owner' });
      expect((await propose('booking.create', payload())).status).toBe('EXECUTED');
      expect((await propose('booking.create', payload())).status).toBe('PENDING');
    } finally {
      delete process.env.AI_AUTO_DAILY_CAP;
    }
  });
});

describe('report.xlsx', () => {
  it('виконується одразу без підтвердження, у результаті лише параметри', async () => {
    const a = await propose('report.xlsx', { type: 'courts', from: '2026-10-01', to: '2026-10-15' });
    expect(a).toMatchObject({ status: 'EXECUTED', summary: 'Звіт «Корти»: 2026-10-01 — 2026-10-15', result: { type: 'courts', from: '2026-10-01', to: '2026-10-15' } });
  });

  it('вимкнені звіти — відмова; некоректний період — INVALID', async () => {
    state.policy = { reports: false };
    expect((await code(propose('report.xlsx', { type: 'courts', from: '2026-10-01', to: '2026-10-15' })))?.[0]).toBe('AI_ACTION_FORBIDDEN');
    state.policy = null;
    expect((await code(propose('report.xlsx', { type: 'courts', from: '2026-10-15', to: '2026-10-01' })))?.[0]).toBe('AI_ACTION_INVALID');
    expect((await code(propose('report.xlsx', { type: 'secrets', from: '2026-10-01', to: '2026-10-02' })))?.[0]).toBe('AI_ACTION_INVALID');
  });
});
