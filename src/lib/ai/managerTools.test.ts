import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../botAnalytics', () => ({ courtAnalytics: vi.fn() }));
vi.mock('../db', () => ({ prisma: { club: { findUnique: vi.fn() }, court: { findMany: vi.fn() }, customer: { findMany: vi.fn() }, booking: { findMany: vi.fn() } } }));
vi.mock('../clubLoad', () => ({ loadClubLoadProfile: vi.fn() }));
vi.mock('./customerHealth', () => ({ loadCustomerHealth: vi.fn() }));
vi.mock('../digest', () => ({ dayDigest: vi.fn(), weekReport: vi.fn() }));
vi.mock('../financeData', () => ({ loadLiabilityPasses: vi.fn() }));
vi.mock('../sections', () => ({ revenueBreakdown: vi.fn(), staffReport: vi.fn() }));
vi.mock('./outlook', () => ({ bookingOutlook: vi.fn() }));
const { proposeAction } = vi.hoisted(() => ({ proposeAction: vi.fn() }));
vi.mock('./actions', async () => ({ ...(await vi.importActual<object>('./actions')), proposeAction }));

import { prisma } from '../db';
import { AiActionError } from './actions';
import { ownerSystemPrompt, ownerTools, type OwnerClub } from './ownerAssistant';
import { DEFAULT_POLICY, effectivePermissions, normalizePolicy } from './policy';
import type { ManagerContext, ProposedAction } from './managerTools';

const club: OwnerClub = { id: 'c1', name: 'Клуб', timezone: 'Europe/Kyiv', address: null };
const COURT = '11111111-1111-4111-8111-111111111111';
const perms = (over: Record<string, unknown>, role = 'OWNER') => effectivePermissions({ ...DEFAULT_POLICY, ...over }, role);

const collected: ProposedAction[] = [];
const ctx = (role: ManagerContext['requester']['role'] = 'OWNER'): ManagerContext => ({
  requester: { id: 'u1', role },
  collect: (a) => { collected.push(a); },
});
const names = (p: ReturnType<typeof perms>, role: any = 'OWNER') => ownerTools(club, undefined, p, ctx(role)).map((t) => t.decl.name);
const tool = (n: string, p = perms({}), role: any = 'OWNER') => ownerTools(club, undefined, p, ctx(role)).find((t) => t.decl.name === n)!;

const ACTION_TOOLS = ['propose_booking', 'propose_cancel_booking', 'propose_reschedule', 'propose_group_session', 'propose_cancel_group_session', 'propose_tournament_bracket', 'make_report'];

beforeEach(() => {
  vi.clearAllMocks();
  collected.length = 0;
});

describe('інструменти менеджера за політикою й роллю', () => {
  it('без контексту автора (сводка, старі виклики) — ні довідників, ні дій', () => {
    const all = ownerTools(club, undefined, perms({})).map((t) => t.decl.name);
    expect(all.filter((n) => n.startsWith('propose_') || n.startsWith('list_') || n === 'make_report' || n === 'find_customer')).toEqual([]);
  });

  it('за замовчуванням (ASK) власник бачить усі інструменти дій і довідники', () => {
    const n = names(perms({}));
    for (const t of [...ACTION_TOOLS, 'list_courts', 'list_bookings', 'list_tournaments', 'find_customer', 'list_trainers']) expect(n).toContain(t);
  });

  it.each([
    [{ bookings: 'OFF' }, ['propose_booking', 'propose_cancel_booking', 'propose_reschedule']],
    [{ groupSessions: 'OFF' }, ['propose_group_session', 'propose_cancel_group_session']],
    [{ tournaments: 'OFF' }, ['propose_tournament_bracket']],
    [{ reports: false }, ['make_report']],
  ])('режим OFF %j — інструмента в моделі немає', (over, hidden) => {
    const n = names(perms(over));
    for (const h of hidden) expect(n).not.toContain(h);
    /* решта дій лишається */
    expect(ACTION_TOOLS.filter((t) => !hidden.includes(t)).every((t) => n.includes(t))).toBe(true);
  });

  it('AUTO теж пропонує інструмент (рішення — за політикою в журналі)', () => {
    expect(names(perms({ bookings: 'AUTO' }))).toContain('propose_booking');
  });

  it('довідники клієнтів і тренерів закриті відповідними читаннями', () => {
    expect(names(perms({ readCustomers: false }))).not.toContain('find_customer');
    expect(names(perms({ readStaff: false }))).not.toContain('list_trainers');
  });

  it('ADMIN з дозволом власника отримує дії лише в межах власницького рівня (перетин)', () => {
    const p = effectivePermissions(normalizePolicy({
      bookings: 'ASK', groupSessions: 'OFF', tournaments: 'ASK', reports: false,
      roleAccess: { ADMIN: { enabled: true, readFinance: false, readCustomers: true, readStaff: false, reports: true, bookings: 'AUTO', groupSessions: 'AUTO', tournaments: 'OFF', messaging: 'OFF' } },
    }), 'ADMIN');
    const n = names(p, 'ADMIN');
    expect(n).toContain('propose_booking');
    expect(n).not.toContain('propose_group_session'); // власник вимкнув
    expect(n).not.toContain('propose_tournament_bracket'); // роль вимкнена
    expect(n).not.toContain('make_report'); // власник вимкнув звіти
    expect(n).not.toContain('list_trainers');
  });

  it('TRAINER і ACCOUNTANT не отримують дій над бронями, навіть коли власник їм усе відкрив; звіти — отримують', () => {
    const open = { enabled: true, readFinance: true, readCustomers: true, readStaff: true, reports: true, bookings: 'AUTO', groupSessions: 'AUTO', tournaments: 'AUTO', messaging: 'OFF' };
    for (const role of ['TRAINER', 'ACCOUNTANT'] as const) {
      const p = effectivePermissions(normalizePolicy({ roleAccess: { [role]: open } }), role);
      const n = names(p, role);
      expect(n.filter((t) => t.startsWith('propose_'))).toEqual([]);
      expect(n).toContain('make_report');
    }
  });

  it('роль без доступу не бачить нічого', () => {
    expect(names(effectivePermissions(normalizePolicy(null), 'ADMIN'), 'ADMIN')).toEqual([]);
  });

  it('системний промпт вчить не казати «готово» без EXECUTED лише коли дії доступні', () => {
    expect(ownerSystemPrompt(club, '', perms({}), 'OWNER', true)).toMatch(/Ніколи не пиши «готово.*EXECUTED/s);
    expect(ownerSystemPrompt(club, '', perms({}), 'OWNER', false)).not.toMatch(/propose_/);
  });
});

describe('відповіді інструментів-дій', () => {
  const booking = { court_id: COURT, date: '2026-10-23', start_time: '18:00', end_time: '19:00', customer_name: 'Олена' };
  const row = (over: Record<string, unknown>) => ({ id: 'a1', kind: 'booking.create', summary: 'Бронь: Корт 2', status: 'PENDING', error: null, ...over });

  it('PENDING: каже, що ще не виконано, і збирає картку для кабінету', async () => {
    proposeAction.mockResolvedValue(row({}));
    const res: any = await tool('propose_booking').run(booking);
    expect(res).toMatchObject({ status: 'PENDING', action_id: 'a1' });
    expect(res.note).toMatch(/ЩЕ НЕ виконано/);
    expect(collected).toEqual([{ id: 'a1', kind: 'booking.create', summary: 'Бронь: Корт 2', status: 'PENDING', error: null }]);
  });

  it('локальний час клубу переводиться в ISO з офсетом (літній час: +03:00)', async () => {
    proposeAction.mockResolvedValue(row({}));
    await tool('propose_booking').run(booking);
    expect(proposeAction.mock.calls[0][0]).toMatchObject({
      clubId: 'c1', kind: 'booking.create', requester: { id: 'u1', role: 'OWNER' },
      payload: { courtId: COURT, start: '2026-10-23T18:00:00.000+03:00', end: '2026-10-23T19:00:00.000+03:00', customerName: 'Олена' },
    });
  });

  it('EXECUTED і FAILED описані чесно', async () => {
    proposeAction.mockResolvedValue(row({ status: 'EXECUTED' }));
    expect(((await tool('propose_booking').run(booking)) as any).note).toBe('Дію виконано.');
    proposeAction.mockResolvedValue(row({ status: 'FAILED', error: 'Цей час на корті вже зайнятий.' }));
    const failed: any = await tool('propose_booking').run(booking);
    expect(failed).toMatchObject({ status: 'FAILED', error: 'Цей час на корті вже зайнятий.' });
    expect(failed.note).toMatch(/НЕ виконано/);
  });

  it('неповні дані від моделі — помилка введення, у журнал нічого не йде', async () => {
    await expect(tool('propose_booking').run({ ...booking, court_id: 'Корт 2' })).rejects.toThrow(/id from the lists/);
    await expect(tool('propose_booking').run({ ...booking, start_time: 'вечір' })).rejects.toThrow(/HH:mm/);
    expect(proposeAction).not.toHaveBeenCalled();
  });

  it('пояснення валідатора доходить до моделі, відмова політики — теж', async () => {
    proposeAction.mockRejectedValue(new AiActionError('AI_ACTION_INVALID', 'Цей час уже минув.'));
    await expect(tool('propose_booking').run(booking)).rejects.toThrow('Цей час уже минув.');
    proposeAction.mockRejectedValue(new AiActionError('AI_ACTION_FORBIDDEN'));
    await expect(tool('propose_booking').run(booking)).rejects.toThrow(/Власник не дозволив/);
  });

  it('кінець до опівночі переходить на наступну добу', async () => {
    proposeAction.mockResolvedValue(row({}));
    await tool('propose_booking').run({ ...booking, start_time: '23:00', end_time: '00:00' });
    expect(proposeAction.mock.calls[0][0].payload.end).toBe('2026-10-24T00:00:00.000+03:00');
  });

  it('кінець за північ у ніч переходу на зимовий час (2026-10-25, Київ) лишається опівночею', async () => {
    proposeAction.mockResolvedValue(row({}));
    await tool('propose_booking').run({ ...booking, date: '2026-10-25', start_time: '23:00', end_time: '00:00' });
    expect(proposeAction.mock.calls[0][0].payload).toMatchObject({
      start: '2026-10-25T23:00:00.000+02:00', end: '2026-10-26T00:00:00.000+02:00',
    });
  });

  it('make_report: закритий звіт відхиляється до журналу, дати за замовчуванням — 30 днів', async () => {
    await expect(tool('make_report', perms({ readFinance: false })).run({ type: 'revenue' })).rejects.toThrow(/потребує доступу до даних про фінанси/);
    await expect(tool('make_report', perms({ readCustomers: false })).run({ type: 'customers' })).rejects.toThrow(/клієнтів/);
    await expect(tool('make_report', perms({ readStaff: false })).run({ type: 'trainers' })).rejects.toThrow(/персонал/);
    expect(proposeAction).not.toHaveBeenCalled();

    proposeAction.mockResolvedValue(row({ kind: 'report.xlsx', status: 'EXECUTED', summary: 'Звіт' }));
    const res: any = await tool('make_report').run({ type: 'bookings', to: '2026-10-30' });
    expect(res.note).toMatch(/кнопку «Завантажити»/);
    expect(proposeAction.mock.calls[0][0].payload).toEqual({ type: 'bookings', from: '2026-10-01', to: '2026-10-30' });
  });
});

describe('довідники', () => {
  it('list_bookings: без readCustomers/readStaff/readFinance не віддає імен, тренерів і цін', async () => {
    vi.mocked(prisma.booking.findMany).mockResolvedValue([{
      id: 'b1', capacity: null, title: null, courtId: COURT, status: 'CONFIRMED', customerName: 'Олена Коваль', priceTotal: 90000,
      startTime: new Date('2026-10-23T15:00:00Z'), endTime: new Date('2026-10-23T16:00:00Z'),
      court: { name: 'Корт 2' }, trainer: { name: 'Ігор' },
    }] as never);
    const closed: any = await tool('list_bookings', perms({ readFinance: false, readCustomers: false, readStaff: false })).run({ date: '2026-10-23' });
    expect(closed[0]).toMatchObject({ id: 'b1', kind: 'private', court: 'Корт 2', start: '18:00', end: '19:00' });
    expect(JSON.stringify(closed)).not.toMatch(/Олена|Ігор|price/);
    const open: any = await tool('list_bookings').run({ date: '2026-10-23' });
    expect(open[0]).toMatchObject({ customer: 'Олена К.', trainer: 'Ігор', price_uah: 900 });
    /* Приватність: прізвище повністю й будь-які контакти до Gemini не йдуть. */
    expect(JSON.stringify(open)).not.toMatch(/Коваль|\+380|@/);
  });

  it('find_customer: моделі йде лише id, «Імʼя П.» і hint за однофамільців — без телефону й пошти', async () => {
    vi.mocked(prisma.customer.findMany).mockResolvedValue([
      { id: '22222222-2222-4222-8222-222222222222', name: 'Володимир Олійник', phone: '+380000000007', email: 'v@example.com' },
      { id: '33333333-3333-4333-8333-333333333333', name: 'Володимир Олійник', phone: '+380000000042', email: null },
      { id: '44444444-4444-4444-8444-444444444444', name: 'Олена', phone: '+380991112233' },
    ] as never);
    const res: any = await tool('find_customer').run({ query: 'Володимир' });
    expect(res).toEqual([
      { id: '22222222-2222-4222-8222-222222222222', name: 'Володимир О.', hint: '…07' },
      { id: '33333333-3333-4333-8333-333333333333', name: 'Володимир О.', hint: '…42' },
      { id: '44444444-4444-4444-8444-444444444444', name: 'Олена' },
    ]);
    expect(JSON.stringify(res)).not.toMatch(/\+380|000000|@|Олійник/);
  });

  it('find_customer → propose_booking працює лише з customer_id', async () => {
    proposeAction.mockResolvedValue({ id: 'a1', kind: 'booking.create', summary: 'Бронь: Корт 1, Володимир О.', status: 'PENDING', error: null });
    const id = '22222222-2222-4222-8222-222222222222';
    const res: any = await tool('propose_booking').run({ court_id: COURT, date: '2026-10-23', start_time: '18:00', end_time: '19:00', customer_id: id });
    expect(proposeAction.mock.calls[0][0].payload).toMatchObject({ customerId: id, customerName: undefined, customerPhone: undefined });
    expect(res.status).toBe('PENDING');
  });

  it('find_customer шукає тільки в клубі автора', async () => {
    vi.mocked(prisma.customer.findMany).mockResolvedValue([{ id: 'x', name: 'Олена', phone: '+380' }] as never);
    await tool('find_customer').run({ query: 'Олена' });
    expect(vi.mocked(prisma.customer.findMany).mock.calls[0][0]).toMatchObject({ where: { clubId: 'c1' } });
    await expect(tool('find_customer').run({ query: 'О' })).rejects.toThrow(/too short/);
  });
});

describe('ownerAssistant з менеджером', () => {
  it('картки пропозицій повертаються разом із відповіддю, а підказки у промпті є лише в режимі дій', async () => {
    const { ownerAssistant } = await import('./ownerAssistant');
    proposeAction.mockResolvedValue({ id: 'a9', kind: 'booking.cancel', summary: 'Скасувати бронь', status: 'PENDING', error: null });
    const generate = vi.fn()
      .mockResolvedValueOnce({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'propose_cancel_booking', args: { booking_id: COURT, reason: 'хворий' } } }] } }] })
      .mockResolvedValueOnce({ candidates: [{ content: { role: 'model', parts: [{ text: 'Запропонувала, чекає підтвердження.' }] } }] });

    const out = await ownerAssistant({
      club, messages: [{ role: 'user', content: 'скасуй бронь' }], generate, snapshot: null,
      perms: perms({}), role: 'OWNER', manager: { requester: { id: 'u1', role: 'OWNER' } },
    });
    expect(out.reply).toBe('Запропонувала, чекає підтвердження.');
    expect(out.actions).toEqual([{ id: 'a9', kind: 'booking.cancel', summary: 'Скасувати бронь', status: 'PENDING', error: null }]);
    expect(generate.mock.calls[0][0].systemInstruction.parts[0].text).toMatch(/propose_/);

    generate.mockReset().mockResolvedValue({ candidates: [{ content: { role: 'model', parts: [{ text: 'ок' }] } }] });
    const plain = await ownerAssistant({ club, messages: [{ role: 'user', content: 'привіт' }], generate, snapshot: null, perms: perms({}) });
    expect(plain.actions).toEqual([]);
    expect(generate.mock.calls[0][0].systemInstruction.parts[0].text).not.toMatch(/propose_/);
  });
});

describe('стеля пропозицій за запит (maxProposals)', () => {
  const booking = { court_id: COURT, date: '2026-10-23', start_time: '18:00', end_time: '19:00', customer_name: 'Олена' };
  const limited = (max: number | undefined) => ownerTools(club, undefined, perms({}), { ...ctx(), maxProposals: max }).find((t) => t.decl.name === 'propose_booking')!;

  it('після ліміту інструмент відмовляє, і нової дії в журналі не створюється', async () => {
    proposeAction.mockResolvedValue({ id: 'a1', kind: 'booking.create', summary: 'x', status: 'PENDING', error: null });
    const t = limited(2);
    await t.run(booking);
    await t.run(booking);
    await expect(t.run(booking)).rejects.toThrow(/Ліміт пропозицій/);
    expect(proposeAction).toHaveBeenCalledTimes(2);
    expect(collected).toHaveLength(2);
  });

  it('без maxProposals обмеження немає', async () => {
    proposeAction.mockResolvedValue({ id: 'a1', kind: 'booking.create', summary: 'x', status: 'PENDING', error: null });
    const t = limited(undefined);
    for (let i = 0; i < 8; i++) await t.run(booking);
    expect(proposeAction).toHaveBeenCalledTimes(8);
  });
});
