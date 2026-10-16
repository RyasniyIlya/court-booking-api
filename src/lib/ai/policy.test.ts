import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POLICY, effectivePermissions, filterTools, normalizePolicy, policyBodySchema, toolScope, type AiPolicy,
} from './policy';

const role = (over: Record<string, unknown> = {}) => ({
  enabled: true, readFinance: true, readCustomers: true, readStaff: true, reports: true,
  bookings: 'AUTO', groupSessions: 'AUTO', tournaments: 'AUTO', messaging: 'AUTO', ...over,
});

describe('normalizePolicy', () => {
  it('немає рядка — типові права: читання вкл., дії з підтвердженням', () => {
    expect(normalizePolicy(null)).toEqual(DEFAULT_POLICY);
    expect(DEFAULT_POLICY).toMatchObject({ readFinance: true, bookings: 'ASK', messaging: 'ASK' });
  });

  it('сміття в полях лишає типове, а в roleAccess — вимикає роль', () => {
    const p = normalizePolicy({
      readFinance: 'yes', bookings: 'SOMETIMES', tournaments: 'AUTO',
      roleAccess: { ADMIN: 'oops', TRAINER: { enabled: 'true', readFinance: true }, ACCOUNTANT: null, OWNER: role() },
    });
    expect(p.readFinance).toBe(true);
    expect(p.bookings).toBe('ASK');
    expect(p.tournaments).toBe('AUTO');
    expect(p.roleAccess).toEqual({});
  });

  it('roleAccess не обʼєкт — жодна роль не має доступу', () => {
    expect(normalizePolicy({ roleAccess: [role()] }).roleAccess).toEqual({});
    expect(normalizePolicy({ roleAccess: 'x' }).roleAccess).toEqual({});
  });

  it('поле ролі без значення закрите, а не відкрите', () => {
    const p = normalizePolicy({ roleAccess: { ADMIN: { enabled: true, readFinance: true } } });
    expect(p.roleAccess.ADMIN).toMatchObject({ enabled: true, readFinance: true, readCustomers: false, bookings: 'OFF' });
  });
});

describe('effectivePermissions', () => {
  const base = (over: Record<string, unknown> = {}): AiPolicy => normalizePolicy({
    readFinance: true, readCustomers: true, readStaff: true, reports: true,
    bookings: 'ASK', groupSessions: 'AUTO', tournaments: 'OFF', messaging: 'ASK',
    roleAccess: { ADMIN: role(), TRAINER: role({ readFinance: false, bookings: 'OFF' }) },
    ...over,
  });

  it('власник отримує політику як є, доступ завжди', () => {
    expect(effectivePermissions(base(), 'OWNER')).toEqual({
      access: true, readFinance: true, readCustomers: true, readStaff: true, reports: true,
      bookings: 'ASK', groupSessions: 'AUTO', tournaments: 'OFF', messaging: 'ASK',
    });
  });

  it('роль без запису або вимкнена — нічого', () => {
    for (const r of ['ACCOUNTANT', 'ADMIN', 'UNKNOWN']) {
      const e = effectivePermissions(base({ roleAccess: {} }), r);
      expect(e).toMatchObject({ access: false, readFinance: false, bookings: 'OFF', messaging: 'OFF' });
    }
  });

  it('роль ніколи не ширша за власника: булеві — «і», режими — менший', () => {
    const e = effectivePermissions(base({ readFinance: false, messaging: 'OFF' }), 'ADMIN');
    expect(e).toMatchObject({
      access: true,
      readFinance: false, // власник закрив — роль з AUTO/true нічого не змінює
      bookings: 'ASK', groupSessions: 'AUTO', tournaments: 'OFF', messaging: 'OFF',
    });
  });

  it('роль вужча за власника лишається вужчою', () => {
    const e = effectivePermissions(base(), 'TRAINER');
    expect(e).toMatchObject({ access: true, readFinance: false, bookings: 'OFF', groupSessions: 'AUTO' });
  });

  it('вимкнений доступ ролі (enabled:false) не відкриває нічого навіть при повних правах у JSON', () => {
    const p = normalizePolicy({ roleAccess: { ADMIN: role({ enabled: false }) } });
    expect(effectivePermissions(p, 'ADMIN').access).toBe(false);
  });
});

describe('filterTools', () => {
  const tools = Object.keys(toolScope).concat('brand_new_tool').map((name) => ({ decl: { name } }));
  const names = (p: AiPolicy, r: string) => filterTools(tools, effectivePermissions(p, r)).map((t) => t.decl.name);

  it('власник з повними правами бачить усе, включно з новим інструментом', () => {
    expect(names(DEFAULT_POLICY, 'OWNER')).toHaveLength(tools.length);
  });

  it('без readFinance зникають фінансові інструменти, нейтральні лишаються', () => {
    const got = names({ ...DEFAULT_POLICY, readFinance: false }, 'OWNER');
    expect(got).not.toContain('get_revenue_trend');
    expect(got).not.toContain('get_day_summary');
    expect(got).not.toContain('get_passes_status');
    expect(got).toEqual(expect.arrayContaining(['get_booking_outlook', 'get_load_heatmap', 'web_lookup', 'get_customer_health']));
  });

  it('без readCustomers зникає здоровʼя клієнтів', () => {
    expect(names({ ...DEFAULT_POLICY, readCustomers: false }, 'OWNER')).not.toContain('get_customer_health');
  });

  it('невідомий інструмент вимагає всіх читань — без одного з них його нема', () => {
    expect(names({ ...DEFAULT_POLICY, readStaff: false }, 'OWNER')).not.toContain('brand_new_tool');
  });

  it('роль без доступу не бачить нічого', () => {
    expect(names(DEFAULT_POLICY, 'ACCOUNTANT')).toEqual([]);
  });
});

describe('policyBodySchema', () => {
  const body = { readFinance: true, readCustomers: true, readStaff: false, reports: true, bookings: 'ASK', groupSessions: 'OFF', tournaments: 'AUTO', messaging: 'ASK' };

  it('приймає повне тіло, roleAccess типово порожній', () => {
    expect(policyBodySchema.parse(body).roleAccess).toEqual({});
  });
  it('відкидає невідомий режим, зайві поля й невідому роль', () => {
    expect(policyBodySchema.safeParse({ ...body, bookings: 'MAYBE' }).success).toBe(false);
    expect(policyBodySchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
    expect(policyBodySchema.safeParse({ ...body, roleAccess: { OWNER: role() } }).success).toBe(false);
    expect(policyBodySchema.safeParse({ ...body, roleAccess: { ADMIN: { ...role(), bookings: 'X' } } }).success).toBe(false);
  });
  it('приймає запис ролі', () => {
    expect(policyBodySchema.safeParse({ ...body, roleAccess: { ADMIN: role() } }).success).toBe(true);
  });
});
