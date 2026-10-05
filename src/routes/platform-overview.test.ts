import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { DateTime } from 'luxon';

const prisma = {
  plan: { findMany: vi.fn() },
  club: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  court: { groupBy: vi.fn(), findMany: vi.fn() },
  clubHours: { findMany: vi.fn() },
  booking: { groupBy: vi.fn() },
  customer: { groupBy: vi.fn(), count: vi.fn() },
  changeLog: { groupBy: vi.fn() },
  trainer: { groupBy: vi.fn(), count: vi.fn() },
  promo: { groupBy: vi.fn(), count: vi.fn() },
  passPlan: { count: vi.fn() },
  pass: { count: vi.fn() },
  user: { groupBy: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  clubGroup: { findUnique: vi.fn() },
  passwordReset: { updateMany: vi.fn() },
  clubInvoice: {
    create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn(),
    aggregate: vi.fn(), findFirst: vi.fn(),
  },
  lead: { groupBy: vi.fn(), count: vi.fn() },
  crmActivity: { create: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
};
vi.mock('../lib/db', () => ({ prisma }));
vi.mock('../lib/telegram', () => ({ sendMessage: vi.fn() }));

process.env.PLATFORM_ADMIN_EMAIL = 'operator@test.local';
process.env.PLATFORM_ADMIN_PASSWORD_HASH = bcrypt.hashSync('operator-password', 4);

const { platformRouter } = await import('./platform');
const app = express().use(express.json()).use(platformRouter);

const DAY = 86_400_000;
const daysAhead = (n: number) => new Date(Date.now() + n * DAY);
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let authorization = '';

const plan = (over: Record<string, unknown> = {}) => ({
  id: 'p1', code: 'base', name: 'Броні', description: null, price: 1000_00, period: 'MONTH', tier: 1,
  featTrainers: false, featGroups: false, featAnalytics: false, ...over,
});

beforeAll(async () => {
  const login = await request(app).post('/login').send({
    email: 'operator@test.local', password: 'operator-password',
  });
  authorization = `Bearer ${login.body.token}`;
});

/** booking.groupBy розрізняється за формою запиту: віддаємо потрібний зріз */
function bookingGroupBy(args: any) {
  if (args.by[0] === 'courtId') return [{ courtId: 'c-1', _count: { _all: 12 } }];
  if (args.by[0] === 'source') {
    return [{ source: 'WIDGET', _count: { _all: 8 } }, { source: 'ADMIN', _count: { _all: 4 } }];
  }
  if (args._max) return [{ clubId: A, _max: { createdAt: new Date(Date.now() - DAY) } }];
  if (args.where.source) return [{ clubId: A, _count: { _all: 15 } }];
  if (args.where.capacity) return [{ clubId: A, _count: { _all: 2 } }];
  if (args.where.startTime.gte.getTime() > Date.now() - 1000) return [{ clubId: A, _count: { _all: 7 } }];
  if (args.where.startTime.lt.getTime() < Date.now() - 20 * DAY) return [{ clubId: A, _count: { _all: 10 } }];
  return [{ clubId: A, _count: { _all: 20 }, _sum: { priceTotal: 1_000_000 } }];
}

beforeEach(() => {
  vi.resetAllMocks();
  prisma.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as unknown[]));

  prisma.booking.groupBy.mockImplementation(async (args: unknown) => bookingGroupBy(args));
  prisma.court.groupBy.mockResolvedValue([
    { clubId: A, isActive: true, _count: { _all: 2 } },
    { clubId: A, isActive: false, _count: { _all: 1 } },
  ]);
  prisma.clubHours.findMany.mockResolvedValue(
    Array.from({ length: 7 }, () => ({ clubId: A, openMinute: 480, closeMinute: 1080 })),
  );
  prisma.customer.groupBy.mockImplementation(async (args: any) =>
    [{ clubId: A, _count: { _all: args.where.createdAt ? 4 : 50 } }]);
  prisma.changeLog.groupBy.mockResolvedValue([{ clubId: A, _max: { at: new Date(Date.now() - DAY) } }]);
  prisma.trainer.groupBy.mockResolvedValue([{ clubId: A, _count: { _all: 2 } }]);
  prisma.promo.groupBy.mockResolvedValue([]);
  prisma.user.groupBy.mockResolvedValue([{ clubId: A, _count: { _all: 1 } }]);
  prisma.$queryRaw.mockResolvedValue([{ clubId: A, hours: 60 }]);
  prisma.club.update.mockResolvedValue({ id: A, plan: null });
  prisma.clubInvoice.create.mockResolvedValue({ id: 'invoice' });
  prisma.crmActivity.create.mockResolvedValue({ id: 'activity' });
});

describe('GET /pricing', () => {
  it('повертає константи формули й таблицю 1..16 кортів по активних планах', async () => {
    prisma.plan.findMany.mockResolvedValue([plan(), plan({ id: 'p2', code: 'pro', name: 'Аналітика', price: 2500_00, tier: 2 })]);

    const res = await request(app).get('/pricing').set('Authorization', authorization);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ includedCourts: 3, autoMaxCourts: 12, roundTo: 5000 });
    expect(prisma.plan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { tier: 'asc' }] }),
    );
    expect(res.body.table).toHaveLength(16);

    const three = res.body.table[2];
    expect(three).toMatchObject({ courts: 3, multiplier: 1, customQuote: false });
    expect(three.plans[0]).toEqual({
      id: 'p1', code: 'base', name: 'Броні', period: 'MONTH', tier: 1, basePrice: 1000_00, price: 1000_00,
    });

    const seven = res.body.table[6];
    expect(seven.courts).toBe(7);
    expect(seven.multiplier).toBeCloseTo(1.696, 6);
    expect(seven.plans.map((p: any) => p.price)).toEqual([1700_00, 4250_00]);

    expect(res.body.table[11].customQuote).toBe(false);
    expect(res.body.table[12].customQuote).toBe(true);
  });

  it('без токена — 401', async () => {
    expect((await request(app).get('/pricing')).status).toBe(401);
  });
});

describe('GET /clubs', () => {
  const clubRow = (over: Record<string, unknown> = {}) => ({
    id: A, name: 'Падел Клаб', slug: 'padel', phone: null, address: null, city: 'Київ', crmTags: ['пілот'],
    isActive: true, approvedAt: new Date(), trialEndsAt: null, paidUntil: daysAhead(40),
    billingPeriod: 'MONTH', billingNote: null, planPrice: null, plan: plan(), group: null,
    lead: { id: 'lead-1', stage: 'WON' }, createdAt: new Date(Date.now() - 200 * DAY),
    users: [{ email: 'owner@club.ua' }], _count: { bookings: 500, courts: 3 },
    ...over,
  });

  it('зберігає старі поля й додає ціну, метрики та здоровʼя', async () => {
    prisma.club.findMany.mockImplementation(async (args: any) =>
      args.select.prepayEnabled
        ? [{ id: A, prepayEnabled: true, passesEnabled: false, telegramChatId: null }]
        : [clubRow()]);

    const res = await request(app).get('/clubs').set('Authorization', authorization);

    expect(res.status).toBe(200);
    const club = res.body[0];

    // Сумісність: усе, що віддавалось раніше
    expect(club).toMatchObject({
      id: A, name: 'Падел Клаб', slug: 'padel', ownerEmail: 'owner@club.ua', bookingsCount: 500, courtsCount: 3,
      billingPeriod: 'MONTH', isActive: true,
    });
    expect(club.users).toBeUndefined();
    expect(club._count).toBeUndefined();

    // Нове
    expect(club).toMatchObject({
      city: 'Київ', crmTags: ['пілот'], activeCourtsCount: 2, listPrice: 1000_00, priceSource: 'plan',
      customQuote: false, lead: { id: 'lead-1', stage: 'WON' },
    });
    expect(club.metrics).toMatchObject({
      bookings30: 20, bookingsPrev30: 10, revenue30: 1_000_000, onlineShare30: 0.75,
      customersTotal: 50, newCustomers30: 4, upcoming7: 7, tgLinked: true,
      features: { onlinePayments: true, passes: false, trainers: true, promos: false, groups: true },
    });
    // 60 год із 2 кортів × 70 год/тиж × 30/7 = 600 год
    expect(club.metrics.occupancy30).toBeCloseTo(0.1, 6);
    expect(new Date(club.metrics.lastBookingAt).getTime()).toBeLessThan(Date.now());
    expect(club.health).toMatchObject({ tone: 'ok' });
    expect(club.health.score).toBeGreaterThanOrEqual(70);
    expect(Array.isArray(club.health.reasons)).toBe(true);
  });

  it('кількість агрегатів не залежить від кількості клубів', async () => {
    prisma.club.findMany.mockImplementation(async (args: any) =>
      args.select.prepayEnabled
        ? [{ id: A }, { id: B }]
        : [clubRow(), clubRow({ id: B, slug: 'second' })]);

    const res = await request(app).get('/clubs').set('Authorization', authorization);

    expect(res.body).toHaveLength(2);
    // Клуб B без жодної броні: нулі й null, а не падіння
    expect(res.body[1].metrics).toMatchObject({ bookings30: 0, onlineShare30: null, occupancy30: null });
    expect(prisma.booking.groupBy).toHaveBeenCalledTimes(6);
    expect(prisma.court.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('індивідуальна ціна: priceSource override, корти її не множать', async () => {
    prisma.club.findMany.mockImplementation(async (args: any) =>
      args.select.prepayEnabled ? [{ id: A }] : [clubRow({ planPrice: 700_00 })]);
    prisma.court.groupBy.mockResolvedValue([{ clubId: A, isActive: true, _count: { _all: 14 } }]);

    const res = await request(app).get('/clubs').set('Authorization', authorization);

    expect(res.body[0]).toMatchObject({ priceSource: 'override', listPrice: 700_00, customQuote: false });
  });

  it('7 активних кортів і план 1000 грн/міс — listPrice 1700 грн', async () => {
    prisma.club.findMany.mockImplementation(async (args: any) =>
      args.select.prepayEnabled ? [{ id: A }] : [clubRow()]);
    prisma.court.groupBy.mockResolvedValue([{ clubId: A, isActive: true, _count: { _all: 7 } }]);

    const res = await request(app).get('/clubs').set('Authorization', authorization);

    expect(res.body[0]).toMatchObject({ activeCourtsCount: 7, listPrice: 1700_00, priceSource: 'plan' });
  });
});

describe('GET /clubs/:id/details', () => {
  const detailsClub = {
    id: A, name: 'Падел Клаб', slug: 'padel', phone: null, address: null, city: 'Київ',
    timezone: 'Europe/Kyiv', crmTags: [], isActive: true, approvedAt: new Date(), trialEndsAt: null,
    paidUntil: daysAhead(40), billingPeriod: 'MONTH', billingNote: null, planPrice: null, plan: plan(),
    group: null, lead: null, autoConfirm: true, prepayEnabled: false, passesEnabled: false,
    createdAt: new Date(Date.now() - 200 * DAY),
  };

  it('404, якщо клубу немає', async () => {
    prisma.club.findUnique.mockResolvedValue(null);
    const res = await request(app).get(`/clubs/${A}/details`).set('Authorization', authorization);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND' });
  });

  it('віддає агрегати без персональних даних і без хешів паролів', async () => {
    prisma.club.findUnique.mockResolvedValue(detailsClub);
    prisma.club.findMany.mockResolvedValue([{ id: A, prepayEnabled: false, passesEnabled: false, telegramChatId: null }]);
    prisma.court.findMany.mockResolvedValue([
      { id: 'c-1', name: 'Корт 1', pricePerHour: 60000, isActive: true, sortOrder: 0 },
      { id: 'c-2', name: 'Корт 2', pricePerHour: 60000, isActive: false, sortOrder: 1 },
    ]);
    prisma.clubHours.findMany.mockResolvedValue([{ weekday: 1, openMinute: 480, closeMinute: 1080, isClosed: false }]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', email: 'owner@club.ua', name: 'Олег', role: 'OWNER', tgChatId: '777', createdAt: new Date() },
    ]);
    prisma.customer.count.mockResolvedValue(50);
    prisma.trainer.count.mockResolvedValue(2);
    prisma.promo.count.mockResolvedValue(1);
    prisma.passPlan.count.mockResolvedValue(3);
    prisma.pass.count.mockResolvedValue(9);
    prisma.clubInvoice.aggregate.mockResolvedValue({ _sum: { amount: 345_000 }, _count: { _all: 3 } });
    prisma.clubInvoice.findFirst.mockResolvedValue({ id: 'inv-9', amount: 115_000 });

    const thisMonth = DateTime.now().setZone('Europe/Kyiv').toFormat('yyyy-LL');
    prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('"Customer"')) return [{ month: thisMonth, customers: 4 }];
      if (sql.includes('to_char')) return [{ month: thisMonth, bookings: 5, revenue: 12_345 }];
      return [{ clubId: A, hours: 10 }];
    });

    const res = await request(app).get(`/clubs/${A}/details`).set('Authorization', authorization);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: A, activeCourtsCount: 2, courtsCount: 3, listPrice: 1000_00,
      counts: { customers: 50, trainers: 2, promos: 1, passPlans: 3, activePasses: 9 },
      sources30: { WIDGET: 8, ADMIN: 4, TELEGRAM_BOT: 0, PLAYER_APP: 0 },
      invoicesSummary: { totalPaid: 345_000, paidCount: 3, lastPaid: { id: 'inv-9' } },
    });
    expect(res.body.courts).toEqual([
      { id: 'c-1', name: 'Корт 1', pricePerHour: 60000, isActive: true, sortOrder: 0, bookings30: 12 },
      { id: 'c-2', name: 'Корт 2', pricePerHour: 60000, isActive: false, sortOrder: 1, bookings30: 0 },
    ]);
    expect(res.body.staff).toEqual([
      expect.objectContaining({ id: 'u1', email: 'owner@club.ua', role: 'OWNER', tgLinked: true }),
    ]);
    expect(res.body.staff[0].tgChatId).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);

    expect(res.body.series).toHaveLength(6);
    expect(res.body.series[5]).toEqual({ month: thisMonth, bookings: 5, revenue: 12_345, newCustomers: 4 });
    expect(res.body.series[0]).toMatchObject({ bookings: 0, revenue: 0, newCustomers: 0 });
    expect(res.body.metrics).toBeDefined();
    expect(res.body.health).toBeDefined();

    // Ніякого імені чи телефону гравця в запитах немає
    const userSelect = prisma.user.findMany.mock.calls[0][0].select;
    expect(userSelect.passwordHash).toBeUndefined();
  });
});

describe('GET /overview', () => {
  const base = { createdAt: new Date(Date.now() - 200 * DAY), trialEndsAt: null, approvedAt: new Date(), isActive: true };

  it('MRR рахується з оплачених клубів за їхніми цінами й активними кортами', async () => {
    prisma.club.findMany.mockImplementation(async (args: any) => {
      if (args.select.prepayEnabled) {
        return ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) => ({ id, prepayEnabled: false, passesEnabled: false, telegramChatId: null }));
      }
      return [
        // 7 активних кортів × план 1000/міс → 1700 грн/міс, платить ще 30 днів
        { ...base, id: 'c1', name: 'Один', paidUntil: daysAhead(30), billingPeriod: 'MONTH', planPrice: null, plan: plan() },
        // індивідуальна ціна 2500 грн за рік без плану → 250 грн/міс, спливає за 10 днів
        { ...base, id: 'c2', name: 'Два', paidUntil: daysAhead(10), billingPeriod: 'YEAR', planPrice: 2500_00, plan: null },
        // пробний спливає за 3 дні
        { ...base, id: 'c3', name: 'Три', paidUntil: null, trialEndsAt: daysAhead(3), billingPeriod: 'MONTH', planPrice: null, plan: null },
        // прострочив на 3 дні — пільга
        { ...base, id: 'c4', name: 'Чотири', paidUntil: daysAhead(-3), billingPeriod: 'MONTH', planPrice: null, plan: null },
        // чекає схвалення
        { ...base, id: 'c5', name: 'П’ять', approvedAt: null, paidUntil: null, billingPeriod: 'MONTH', planPrice: null, plan: null },
        // вимкнений
        { ...base, id: 'c6', name: 'Шість', isActive: false, paidUntil: daysAhead(90), billingPeriod: 'MONTH', planPrice: null, plan: null },
      ];
    });
    prisma.court.groupBy.mockResolvedValue([
      { clubId: 'c1', isActive: true, _count: { _all: 7 } },
      { clubId: 'c2', isActive: true, _count: { _all: 2 } },
      { clubId: 'c6', isActive: true, _count: { _all: 5 } },
    ]);
    prisma.booking.groupBy.mockResolvedValue([]);
    prisma.clubInvoice.aggregate.mockResolvedValue({ _sum: { amount: 500_000 }, _count: { _all: 2 } });
    prisma.lead.groupBy.mockResolvedValue([{ stage: 'NEW', _count: { _all: 3 } }, { stage: 'WON', _count: { _all: 1 } }]);
    prisma.lead.count.mockImplementation(async (args: any) => (args.where.nextActionAt === null ? 4 : 2));

    const res = await request(app).get('/overview').set('Authorization', authorization);

    expect(res.status).toBe(200);
    expect(res.body.clubs).toEqual({
      total: 6, active: 4, pending: 1, onTrial: 1, paying: 2, overdue: 1, disabled: 1,
    });
    // 1700 грн + 2500/10 = 250 грн
    expect(res.body.mrr).toBe(1700_00 + 250_00);
    expect(res.body.arr).toBe((1700_00 + 250_00) * 12);

    expect(res.body.expiring14).toEqual([
      expect.objectContaining({ id: 'c2', name: 'Два', listPrice: 2500_00 }),
    ]);
    expect(res.body.trialsEnding7.map((c: any) => c.id)).toEqual(['c3']);
    expect(res.body.overdueList).toEqual([expect.objectContaining({ id: 'c4', state: 'grace' })]);
    expect(res.body.newClubs30).toBe(0);
    expect(res.body.totals).toMatchObject({ activeCourts: 9, bookings30: 0, revenue30: 0, customers: 0 });
    expect(res.body.invoices30).toEqual({ count: 2, amount: 500_000 });

    // Здоровʼя — по схвалених клубах (5 із 6), вимкнений завжди bad
    const h = res.body.health;
    expect(h.ok + h.warn + h.bad).toBe(5);
    expect(h.bad).toBeGreaterThanOrEqual(1);

    expect(res.body.leads.byStage).toMatchObject({ NEW: 3, WON: 1, LOST: 0, NOT_FIT: 0 });
    expect(res.body.leads).toMatchObject({ overdueNextActions: 2, noNextAction: 4 });
  });
});

describe('PATCH /clubs/:id', () => {
  const patch = (body: unknown) =>
    request(app).patch(`/clubs/${A}`).set('Authorization', authorization).send(body as object);

  beforeEach(() => {
    prisma.club.findUnique.mockResolvedValue({
      isActive: true, approvedAt: new Date(), planPrice: null, plan: { id: 'p1', name: 'Броні' },
    });
  });

  it('21 мітка — 400', async () => {
    const tags = Array.from({ length: 21 }, (_, i) => `тег${i}`);
    expect((await patch({ crmTags: tags })).status).toBe(400);
    expect(prisma.club.update).not.toHaveBeenCalled();
  });

  it('мітка довше 40 символів або порожня — 400', async () => {
    expect((await patch({ crmTags: ['x'.repeat(41)] })).status).toBe(400);
    expect((await patch({ crmTags: ['   '] })).status).toBe(400);
  });

  it('дублі без огляду на регістр зливаються, лишається перше написання', async () => {
    const res = await patch({ crmTags: ['Мережа ', 'мережа', 'Київ', 'МЕРЕЖА'], city: ' Львів ' });

    expect(res.status).toBe(200);
    expect(prisma.club.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { crmTags: ['Мережа', 'Київ'], city: 'Львів' } }),
    );
  });

  it('city: null чистить місто, надто довге — 400', async () => {
    expect((await patch({ city: null })).status).toBe(200);
    expect(prisma.club.update).toHaveBeenCalledWith(expect.objectContaining({ data: { city: null } }));
    expect((await patch({ city: 'м'.repeat(81) })).status).toBe(400);
  });

  it('зміна плану лишає рядок журналу «План: Броні → Аналітика»', async () => {
    prisma.club.update.mockResolvedValue({ id: A, plan: { id: 'p2', name: 'Аналітика' } });

    const res = await patch({ planId: '33333333-3333-4333-8333-333333333333' });

    expect(res.status).toBe(200);
    expect(prisma.crmActivity.create).toHaveBeenCalledWith({
      data: { clubId: A, kind: 'SYSTEM', text: 'План: Броні → Аналітика', author: 'operator@test.local' },
    });
  });

  it('вимкнення й схвалення журналяться, повторне значення — ні', async () => {
    prisma.club.update.mockResolvedValue({ id: A, plan: null });

    await patch({ isActive: false, approved: true, name: 'Нова назва' });

    const texts = prisma.crmActivity.create.mock.calls.map((c: any) => c[0].data.text);
    expect(texts).toEqual(['Клуб вимкнено']);
  });

  it('клубу немає — 404 без запису в журнал', async () => {
    prisma.club.findUnique.mockResolvedValue(null);
    expect((await patch({ city: 'Київ' })).status).toBe(404);
    expect(prisma.crmActivity.create).not.toHaveBeenCalled();
  });
});

describe('POST /clubs/:id/subscription', () => {
  const clubRow = (over: Record<string, unknown> = {}) => ({
    id: A, name: 'Падел Клаб', paidUntil: null, billingPeriod: 'MONTH', planPrice: null,
    plan: plan(), users: [], _count: { courts: 7 }, ...over,
  });

  it('сума рахується з активних кортів: план 1000 грн/міс і 7 кортів — рахунок 1700 грн', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow());

    const res = await request(app).post(`/clubs/${A}/subscription`).set('Authorization', authorization).send({});

    expect(res.status).toBe(200);
    expect(prisma.club.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ _count: { select: { courts: { where: { isActive: true } } } } }),
      }),
    );
    expect(prisma.clubInvoice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ clubId: A, amount: 1700_00, status: 'PAID' }),
    });
  });

  it('видача підписки пише SYSTEM-запис у журнал', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow());

    await request(app)
      .post(`/clubs/${A}/subscription`)
      .set('Authorization', authorization)
      .send({ period: 'QUARTER' });

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.crmActivity.create).toHaveBeenCalledOnce();
    const { data } = prisma.crmActivity.create.mock.calls[0][0];
    expect(data).toMatchObject({ clubId: A, kind: 'SYSTEM', author: 'operator@test.local' });
    // квартал = 3 місячні ставки за 7 кортів
    expect(data.text).toMatch(/^Зараховано оплату: квартал · 5 100 грн, до \d{2}\.\d{2}\.\d{4}$/);
  });

  it('вручну введена сума не множиться', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow());

    await request(app)
      .post(`/clubs/${A}/subscription`)
      .set('Authorization', authorization)
      .send({ amount: 90000 });

    expect(prisma.clubInvoice.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 90000 }) });
  });
});

describe('POST /clubs/:id/subscription і відкритий рахунок', () => {
  const clubRow = () => ({
    id: A, name: 'Падел Клаб', paidUntil: null, billingPeriod: 'MONTH', planPrice: null,
    plan: plan(), users: [], _count: { courts: 2 },
  });

  it('є ISSUED-рахунок: він стає PAID, дубль не створюється', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow());
    prisma.clubInvoice.findFirst.mockResolvedValue({ id: 'open-1' });
    prisma.clubInvoice.update.mockResolvedValue({ id: 'open-1' });

    const res = await request(app).post(`/clubs/${A}/subscription`).set('Authorization', authorization).send({ method: 'transfer' });

    expect(res.status).toBe(200);
    expect(prisma.clubInvoice.create).not.toHaveBeenCalled();
    expect(prisma.clubInvoice.update).toHaveBeenCalledWith({
      where: { id: 'open-1' },
      data: expect.objectContaining({ status: 'PAID', amount: 1000_00, method: 'transfer' }),
    });
  });

  it('відкритого немає: новий PAID-рахунок отримує номер К-рік-00001', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow());
    prisma.clubInvoice.findFirst.mockResolvedValue(null);

    await request(app).post(`/clubs/${A}/subscription`).set('Authorization', authorization).send({});

    const { data } = prisma.clubInvoice.create.mock.calls[0][0];
    expect(data.number).toMatch(/^К-\d{4}-00001$/);
    expect(data.status).toBe('PAID');
  });
});

describe('POST /invoices/:id/void', () => {
  it('скасування рахунку лишає запис у журналі в тій самій транзакції', async () => {
    prisma.clubInvoice.findUnique.mockResolvedValue({
      id: 'inv', clubId: A, periodFrom: new Date('2026-09-01T00:00:00Z'), periodTo: new Date('2026-10-01T00:00:00Z'),
      amount: 3450_00, status: 'PAID',
    });
    prisma.clubInvoice.count.mockResolvedValue(0);
    prisma.clubInvoice.update.mockResolvedValue({});
    prisma.club.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).post('/invoices/inv/void').set('Authorization', authorization);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, rolledBack: true });
    const { data } = prisma.crmActivity.create.mock.calls[0][0];
    expect(data.kind).toBe('SYSTEM');
    expect(data.text).toBe('Скасовано рахунок 3 450 грн за 01.09.2026–01.10.2026, дату оплати відкочено');
  });
});

describe('POST /groups/:id/subscription', () => {
  it('кожній точці мережі — свій рахунок за її активними кортами й свій запис у журналі', async () => {
    prisma.clubGroup.findUnique.mockResolvedValue({
      name: 'Мережа',
      clubs: [
        { id: A, paidUntil: null, billingPeriod: 'MONTH', planPrice: null, plan: plan(), _count: { courts: 7 } },
        { id: B, paidUntil: null, billingPeriod: 'MONTH', planPrice: null, plan: plan(), _count: { courts: 2 } },
      ],
    });

    const res = await request(app).post('/groups/g1/subscription').set('Authorization', authorization).send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: 2, totalAmount: 1700_00 + 1000_00 });
    const texts = prisma.crmActivity.create.mock.calls.map((c: any) => c[0].data.text);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/^Зараховано оплату: місяць · 1 700 грн, до \d{2}\.\d{2}\.\d{4} \(мережа «Мережа»\)$/);
    expect(prisma.crmActivity.create.mock.calls[1][0].data.clubId).toBe(B);
  });
});

describe('POST /clubs/:id/owner-password', () => {
  it('зміна пароля власника журналиться без самого пароля', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'u1', email: 'owner@club.ua', tgChatId: null });
    prisma.user.update.mockResolvedValue({});

    const res = await request(app)
      .post(`/clubs/${A}/owner-password`)
      .set('Authorization', authorization)
      .send({ password: 'super-secret-pass' });

    expect(res.status).toBe(200);
    const { data } = prisma.crmActivity.create.mock.calls[0][0];
    expect(data).toMatchObject({ clubId: A, kind: 'SYSTEM', text: 'Змінено пароль власника (owner@club.ua)' });
    expect(JSON.stringify(data)).not.toContain('super-secret-pass');
  });
});
