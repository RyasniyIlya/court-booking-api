import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const prisma = {
  lead: {
    findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), create: vi.fn(),
    update: vi.fn(), delete: vi.fn(), createMany: vi.fn(), groupBy: vi.fn(),
  },
  plan: { findMany: vi.fn() },
  club: { findUnique: vi.fn(), update: vi.fn() },
  crmActivity: {
    create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), delete: vi.fn(),
  },
  $transaction: vi.fn(),
};
vi.mock('../lib/db', () => ({ prisma }));

const { JWT_SECRET } = await import('../lib/authSecret');
const { platformCrmRouter, kyivBounds } = await import('./platformCrm');

const app = express().use(express.json()).use(platformCrmRouter);
const auth = `Bearer ${jwt.sign({ scope: 'platform', email: 'op@test.local' }, JWT_SECRET)}`;

const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_LEAD_ID = '44444444-4444-4444-8444-444444444444';
const CLUB_ID = '22222222-2222-4222-8222-222222222222';
const ACT_ID = '33333333-3333-4333-8333-333333333333';

const baseLead = (over: Record<string, unknown> = {}) => ({
  id: LEAD_ID, name: 'Клуб', stage: 'NEW', tags: [], city: null, lostReason: null,
  nextActionAt: null, courtsCount: null, revenueYear: null, phone: null, ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  prisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  prisma.lead.groupBy.mockResolvedValue([]);
  prisma.lead.findMany.mockResolvedValue([]);
  prisma.lead.count.mockResolvedValue(0);
  prisma.plan.findMany.mockResolvedValue([]);
  prisma.crmActivity.create.mockImplementation(async ({ data }: { data: object }) => ({ id: ACT_ID, ...data }));
  prisma.lead.update.mockImplementation(async ({ data }: { data: object }) => baseLead(data));
});

describe('автентифікація', () => {
  it('усі маршрути дають 401 без токена', async () => {
    const calls = [
      request(app).get('/leads'),
      request(app).get('/leads/stats'),
      request(app).post('/leads').send({ name: 'x' }),
      request(app).post('/leads/import').send({ rows: [{}] }),
      request(app).get(`/leads/${LEAD_ID}`),
      request(app).patch(`/leads/${LEAD_ID}`).send({}),
      request(app).delete(`/leads/${LEAD_ID}`),
      request(app).post(`/leads/${LEAD_ID}/convert`).send({ clubId: CLUB_ID }),
      request(app).post(`/leads/${LEAD_ID}/activities`).send({}),
      request(app).get(`/clubs/${CLUB_ID}/activities`),
      request(app).post(`/clubs/${CLUB_ID}/activities`).send({}),
      request(app).patch(`/activities/${ACT_ID}`).send({}),
      request(app).delete(`/activities/${ACT_ID}`),
      request(app).get('/tasks'),
    ];
    for (const r of await Promise.all(calls)) expect(r.status).toBe(401);
    expect(prisma.lead.findMany).not.toHaveBeenCalled();
  });

  it('токен клубу (без scope platform) не пускає', async () => {
    const clubToken = jwt.sign({ clubId: CLUB_ID }, JWT_SECRET);
    const r = await request(app).get('/leads').set('Authorization', `Bearer ${clubToken}`);
    expect(r.status).toBe(401);
  });
});

describe('GET /leads', () => {
  it('будує where з усіх фільтрів, сортування й пагінацію', async () => {
    const r = await request(app)
      .get('/leads')
      .query({
        q: '067 133', stage: 'NEW,DEMO', tag: 'vip', priority: 'a,b', city: 'Київ',
        source: 'manual', due: 'none', sort: 'nextActionAt', page: 2, pageSize: 10,
      })
      .set('Authorization', auth);

    expect(r.status).toBe(200);
    const args = prisma.lead.findMany.mock.calls[0][0];
    expect(args.skip).toBe(10);
    expect(args.take).toBe(10);
    expect(args.orderBy[0]).toEqual({ nextActionAt: { sort: 'asc', nulls: 'last' } });

    const and = args.where.AND;
    expect(and).toContainEqual({
      OR: expect.arrayContaining([
        { name: { contains: '067 133', mode: 'insensitive' } },
        { legalName: { contains: '067 133', mode: 'insensitive' } },
        { city: { contains: '067 133', mode: 'insensitive' } },
        { email: { contains: '067 133', mode: 'insensitive' } },
        { edrpou: { contains: '067 133' } },
        // 067133 -> без ведучого 0, бо телефон зберігається як +38067…
        { phone: { contains: '67133' } },
      ]),
    });
    expect(and).toContainEqual({ stage: { in: ['NEW', 'DEMO'] } });
    expect(and).toContainEqual({ tags: { has: 'vip' } });
    expect(and).toContainEqual({ priority: { in: ['A', 'B'] } });
    expect(and).toContainEqual({ city: { equals: 'Київ', mode: 'insensitive' } });
    expect(and).toContainEqual({ source: 'manual' });
    expect(and).toContainEqual({
      stage: { in: ['NEW', 'CHECKING', 'CONTACTED', 'QUALIFIED', 'DEMO', 'PROPOSAL'] },
      nextActionAt: null,
    });
    // count і findMany фільтруються однаково
    expect(prisma.lead.count).toHaveBeenCalledWith({ where: args.where });
  });

  it('due=overdue/today/week рахуються за київською добою', async () => {
    const { startToday, startTomorrow, weekEnd } = kyivBounds();
    const get = async (due: string) => {
      prisma.lead.findMany.mockClear();
      await request(app).get('/leads').query({ due }).set('Authorization', auth);
      return prisma.lead.findMany.mock.calls[0][0].where.AND[0];
    };
    expect((await get('overdue')).nextActionAt).toEqual({ lt: startToday });
    expect((await get('today')).nextActionAt).toEqual({ gte: startToday, lt: startTomorrow });
    expect((await get('week')).nextActionAt).toEqual({ gte: startToday, lt: weekEnd });
  });

  it('без фільтрів — порожній where; невалідний stage — 400', async () => {
    await request(app).get('/leads').set('Authorization', auth);
    expect(prisma.lead.findMany.mock.calls[0][0].where).toEqual({});
    const bad = await request(app).get('/leads?stage=BOGUS').set('Authorization', auth);
    expect(bad.status).toBe(400);
    const big = await request(app).get('/leads?pageSize=500').set('Authorization', auth);
    expect(big.status).toBe(400);
  });

  it('віддає фасети, ціну по планах, прапорці й revenueYear числом', async () => {
    const { startToday } = kyivBounds();
    const yesterday = new Date(startToday.getTime() - 3600_000);
    prisma.lead.findMany
      .mockResolvedValueOnce([
        baseLead({ id: 'a', stage: 'CONTACTED', courtsCount: 6, revenueYear: 89170200n, nextActionAt: yesterday }),
        baseLead({ id: 'b', stage: 'NEW', courtsCount: 20 }),
        baseLead({ id: 'c', stage: 'WON' }),
      ])
      .mockResolvedValueOnce([{ tags: ['vip', 'падел'] }, { tags: ['vip'] }]);
    prisma.lead.count.mockResolvedValue(3);
    prisma.plan.findMany.mockResolvedValue([{ code: 'base', name: 'Базовий', price: 100000 }]);
    prisma.lead.groupBy
      .mockResolvedValueOnce([{ stage: 'NEW', _count: { _all: 5 } }, { stage: 'WON', _count: { _all: 1 } }])
      .mockResolvedValueOnce([{ city: 'Київ', _count: { _all: 4 } }])
      .mockResolvedValueOnce([{ priority: 'A', _count: { _all: 2 } }]);

    const r = await request(app).get('/leads').set('Authorization', auth);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 3, page: 1, pageSize: 50 });
    expect(r.body.facets.stages).toMatchObject({ NEW: 5, WON: 1, DEMO: 0, LOST: 0 });
    expect(r.body.facets.cities).toEqual([{ city: 'Київ', n: 4 }]);
    expect(r.body.facets.tags).toEqual([{ tag: 'vip', n: 2 }, { tag: 'падел', n: 1 }]);
    expect(r.body.facets.priorities).toEqual({ A: 2, B: 0, C: 0 });

    const [a, b, c] = r.body.items;
    expect(a.revenueYear).toBe(89170200);
    expect(a.overdue).toBe(true);
    expect(a.noNextAction).toBe(false);
    // 6 кортів: парабола збільшує ціну плану (1000 грн -> більше)
    expect(a.estimatedPrice[0]).toMatchObject({ code: 'base', name: 'Базовий' });
    expect(a.estimatedPrice[0].price).toBeGreaterThan(100000);
    expect(a.customQuote).toBe(false);
    expect(b.customQuote).toBe(true); // 20 кортів > 12
    expect(b.noNextAction).toBe(true);
    // WON — не активний: ні прострочення, ні «немає кроку»
    expect(c.noNextAction).toBe(false);
    expect(c.overdue).toBe(false);
  });
});

describe('GET /leads/stats', () => {
  it('не плутається з /leads/:id і віддає всі лічильники', async () => {
    prisma.lead.groupBy.mockResolvedValue([{ stage: 'NEW', _count: { _all: 7 } }]);
    prisma.lead.count.mockResolvedValue(3);
    const r = await request(app).get('/leads/stats').set('Authorization', auth);
    expect(r.status).toBe(200);
    expect(r.body.byStage.NEW).toBe(7);
    expect(r.body).toMatchObject({
      overdue: 3, today: 3, noNextAction: 3, createdLast7: 3, wonLast30: 3,
    });
    expect(prisma.lead.findUnique).not.toHaveBeenCalled();
  });
});

describe('POST/PATCH/DELETE /leads', () => {
  it('нормалізує телефон, email і теги при створенні', async () => {
    prisma.lead.create.mockImplementation(async ({ data }: { data: object }) => baseLead(data));
    const r = await request(app)
      .post('/leads')
      .set('Authorization', auth)
      .send({ name: ' Padel ', phone: '067 123 45 67', email: 'INFO@Club.UA', tags: ['VIP', 'vip', 'нове'], edrpou: '' });
    expect(r.status).toBe(201);
    expect(prisma.lead.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Padel', phone: '+380671234567', email: 'info@club.ua', tags: ['VIP', 'нове'], edrpou: null,
      }),
    });
  });

  it('лишає телефон як є, якщо його не вдалось нормалізувати', async () => {
    prisma.lead.create.mockImplementation(async ({ data }: { data: object }) => baseLead(data));
    await request(app).post('/leads').set('Authorization', auth).send({ name: 'X', phone: 'через рецепцію' });
    expect(prisma.lead.create.mock.calls[0][0].data.phone).toBe('через рецепцію');
  });

  it('відхиляє зайве: порожнє ім\'я, 21 тег, courtsCount > 200, погана дата, priority', async () => {
    const bad = [
      { name: '' },
      { name: 'x', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      { name: 'x', courtsCount: 201 },
      { name: 'x', nextActionAt: 'не дата' },
      { name: 'x', priority: 'Z' },
      { name: 'x', note: 'я'.repeat(2001) },
    ];
    for (const body of bad) {
      const r = await request(app).post('/leads').set('Authorization', auth).send(body);
      expect(r.status).toBe(400);
    }
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('дата без часу — початок доби за Києвом', async () => {
    prisma.lead.create.mockImplementation(async ({ data }: { data: object }) => baseLead(data));
    await request(app).post('/leads').set('Authorization', auth).send({ name: 'X', nextActionAt: '2026-10-05' });
    // 5 жовтня Київ = UTC+3
    expect(prisma.lead.create.mock.calls[0][0].data.nextActionAt).toEqual(new Date('2026-10-04T21:00:00.000Z'));
  });

  it('EDRPOU_TAKEN при дублі коду', async () => {
    prisma.lead.create.mockRejectedValue({ code: 'P2002' });
    const r = await request(app).post('/leads').set('Authorization', auth).send({ name: 'X', edrpou: '12345678' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'EDRPOU_TAKEN' });

    prisma.lead.findUnique.mockResolvedValue(baseLead());
    prisma.lead.update.mockRejectedValue({ code: 'P2002' });
    const p = await request(app).patch(`/leads/${LEAD_ID}`).set('Authorization', auth).send({ edrpou: '12345678' });
    expect(p.status).toBe(409);
    expect(p.body).toEqual({ error: 'EDRPOU_TAKEN' });
  });

  it('LOST без причини — 400 LOST_REASON_REQUIRED, з причиною — ок', async () => {
    prisma.lead.findUnique.mockResolvedValue(baseLead({ stage: 'DEMO' }));
    const no = await request(app).patch(`/leads/${LEAD_ID}`).set('Authorization', auth).send({ stage: 'LOST' });
    expect(no.status).toBe(400);
    expect(no.body).toEqual({ error: 'LOST_REASON_REQUIRED' });
    const blank = await request(app)
      .patch(`/leads/${LEAD_ID}`).set('Authorization', auth).send({ stage: 'LOST', lostReason: '   ' });
    expect(blank.status).toBe(400);
    expect(prisma.lead.update).not.toHaveBeenCalled();

    const ok = await request(app)
      .patch(`/leads/${LEAD_ID}`).set('Authorization', auth).send({ stage: 'LOST', lostReason: 'обрали Playtomic' });
    expect(ok.status).toBe(200);
    expect(prisma.lead.update).toHaveBeenCalledOnce();

    const create = await request(app).post('/leads').set('Authorization', auth).send({ name: 'X', stage: 'LOST' });
    expect(create.status).toBe(400);
  });

  it('зміна етапу пише SYSTEM-запис з українськими назвами', async () => {
    prisma.lead.findUnique.mockResolvedValue(baseLead({ stage: 'NEW' }));
    const r = await request(app).patch(`/leads/${LEAD_ID}`).set('Authorization', auth).send({ stage: 'CONTACTED' });
    expect(r.status).toBe(200);
    expect(prisma.crmActivity.create).toHaveBeenCalledWith({
      data: { leadId: LEAD_ID, kind: 'SYSTEM', text: 'Етап: Новий → Контакт', author: 'op@test.local' },
    });
  });

  it('без зміни етапу SYSTEM-запису немає; 404 для невідомого й не-UUID', async () => {
    prisma.lead.findUnique.mockResolvedValue(baseLead({ stage: 'NEW' }));
    await request(app).patch(`/leads/${LEAD_ID}`).set('Authorization', auth).send({ stage: 'NEW', note: 'привіт' });
    expect(prisma.crmActivity.create).not.toHaveBeenCalled();

    prisma.lead.findUnique.mockResolvedValue(null);
    expect((await request(app).patch(`/leads/${LEAD_ID}`).set('Authorization', auth).send({})).status).toBe(404);
    expect((await request(app).get('/leads/not-a-uuid').set('Authorization', auth)).status).toBe(404);
  });

  it('GET /leads/:id віддає ліда з журналом і клубом', async () => {
    prisma.lead.findUnique.mockResolvedValue(
      baseLead({ revenueYear: 5n, activities: [{ id: ACT_ID }], club: { id: CLUB_ID, name: 'К', slug: 'k' } }),
    );
    const r = await request(app).get(`/leads/${LEAD_ID}`).set('Authorization', auth);
    expect(r.status).toBe(200);
    expect(r.body.revenueYear).toBe(5);
    expect(r.body.club).toEqual({ id: CLUB_ID, name: 'К', slug: 'k' });
    expect(prisma.lead.findUnique.mock.calls[0][0].include.activities).toEqual({
      orderBy: { createdAt: 'desc' }, take: 100,
    });
  });

  it('DELETE: 204 / 404', async () => {
    prisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    expect((await request(app).delete(`/leads/${LEAD_ID}`).set('Authorization', auth)).status).toBe(204);
    expect(prisma.lead.delete).toHaveBeenCalledWith({ where: { id: LEAD_ID } });
    prisma.lead.findUnique.mockResolvedValue(null);
    expect((await request(app).delete(`/leads/${LEAD_ID}`).set('Authorization', auth)).status).toBe(404);
  });
});

describe('POST /leads/import', () => {
  // Справжній рядок YouControl (clean_leads.json, .clean[0])
  const yc = {
    'Компанія': 'ТОВ "ФУТБОЛЬНИЙ КЛУБ "МЕТАЛІСТ"', 'Код': 43285931, 'КВЕД': 'Діяльність спортивних клубів',
    'Сфера': 'Спортивні організації', 'Телефон': '+380671330011', 'Email': 'HANTER083@GMAIL.COM',
    'Веб-сайт': null, 'Директор': 'ЄМАНОВ ВЛАДИСЛАВ ВІКТОРОВИЧ', 'Регіон': 'Харківський район',
    'Місто': 'Харків', 'Адреса': 'УКРАЇНА, 61001, ХАРКІВСЬКА ОБЛ.', 'MarketScore': 'A', 'FinScore': 'C',
    'Дохід 2025, грн': 89170200, 'Причина': 'готовий до контакту', 'Пріоритет': 'A',
  };

  it('створює нові ліди з мапінгом YouControl (пачкою, з дефолтом B)', async () => {
    prisma.lead.createMany.mockResolvedValue({ count: 1 });
    const r = await request(app).post('/leads/import').set('Authorization', auth)
      .send({ rows: [yc, { 'Компанія': 'ТОВ "БЕЗ КЛЮЧА"' }] });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      created: 1, updated: 0, skipped: 0, dryRun: false,
      errors: [{ index: 1, error: 'NO_DEDUPE_KEY' }],
    });
    // один пошук наявних для всього файлу
    expect(prisma.lead.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.lead.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ edrpou: { in: ['43285931'] } }, { phone: { in: ['+380671330011'] } }],
    });
    expect(prisma.lead.createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: [expect.objectContaining({
        name: 'Футбольний Клуб Металіст', edrpou: '43285931', phone: '+380671330011',
        email: 'hanter083@gmail.com', priority: 'A', source: 'youcontrol', revenueYear: 89170200n,
        contactName: 'Єманов Владислав Вікторович', contactRole: 'директор',
      })],
    });
  });

  it('dryRun рахує те саме, але нічого не пише', async () => {
    const r = await request(app).post('/leads/import').set('Authorization', auth)
      .send({ rows: [yc, { ...yc, 'Код': 11111111, 'Телефон': '0501112233' }], dryRun: true });
    expect(r.body).toMatchObject({ created: 2, updated: 0, skipped: 0, dryRun: true });
    expect(prisma.lead.createMany).not.toHaveBeenCalled();
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('дедуплікує за ЄДРПОУ й не перезаписує поля оператора', async () => {
    prisma.lead.findMany.mockResolvedValue([{
      id: LEAD_ID, edrpou: '43285931', phone: null, stage: 'DEMO', tags: ['мій-тег'],
      note: 'дзвонив у вівторок', nextAction: 'надіслати КП', city: 'Харків', email: null,
      legalName: null, region: null, address: null, sport: null, website: null, instagram: null,
      contactName: 'Оператор Ввів', contactRole: null, courtsCount: 4, currentSystem: null,
      planInterest: null, marketScore: null, finScore: null, revenueYear: null,
    }]);
    const r = await request(app).post('/leads/import').set('Authorization', auth).send({ rows: [yc] });

    expect(r.body).toMatchObject({ created: 0, updated: 1, skipped: 0 });
    expect(prisma.lead.createMany).not.toHaveBeenCalled();
    const patch = prisma.lead.update.mock.calls[0][0].data;
    expect(prisma.lead.update.mock.calls[0][0].where).toEqual({ id: LEAD_ID });
    expect(patch.email).toBe('hanter083@gmail.com');
    expect(patch.phone).toBe('+380671330011');
    expect(patch.tags).toEqual(['мій-тег', 'спортклуб']);
    for (const untouched of ['stage', 'note', 'nextAction', 'city', 'contactName', 'courtsCount', 'priority', 'source']) {
      expect(patch).not.toHaveProperty(untouched);
    }
  });

  it('дедуплікує за телефоном, якщо в наявного ліда немає ЄДРПОУ або рядок без коду', async () => {
    const existing = {
      id: LEAD_ID, edrpou: null, phone: '+380671330011', stage: 'NEW', tags: [],
      name: 'Клуб', legalName: 'вже є',
    };
    prisma.lead.findMany.mockResolvedValue([existing]);
    const r = await request(app).post('/leads/import').set('Authorization', auth)
      .send({ rows: [yc] });
    expect(r.body).toMatchObject({ created: 0, updated: 1 });
    // лід без коду отримує ЄДРПОУ з реєстру, юрназву не чіпаємо
    const patch = prisma.lead.update.mock.calls[0][0].data;
    expect(patch.edrpou).toBe('43285931');
    expect(patch).not.toHaveProperty('legalName');
  });

  it('той самий телефон в іншої юрособи (інший ЄДРПОУ) — не дубль', async () => {
    prisma.lead.findMany.mockResolvedValue([{ id: LEAD_ID, edrpou: '99999999', phone: '+380671330011', tags: [] }]);
    prisma.lead.createMany.mockResolvedValue({ count: 1 });
    const r = await request(app).post('/leads/import').set('Authorization', auth).send({ rows: [yc] });
    expect(r.body).toMatchObject({ created: 1, updated: 0 });
  });

  it('дублі всередині файлу та рядки без нових даних — skipped', async () => {
    prisma.lead.createMany.mockResolvedValue({ count: 1 });
    const r = await request(app).post('/leads/import').set('Authorization', auth).send({
      rows: [yc, yc, { name: 'Інший без коду', phone: '+380671330011' }, 'сміття'],
    });
    expect(r.body).toMatchObject({ created: 1, updated: 0, skipped: 2 });
    expect(r.body.errors).toEqual([{ index: 3, error: 'NOT_AN_OBJECT' }]);

    // наявний лід, у якого вже все заповнено
    prisma.lead.findMany.mockResolvedValue([{
      id: LEAD_ID, edrpou: '43285931', phone: '+380671330011', tags: ['спортклуб'],
      legalName: 'a', city: 'a', region: 'a', address: 'a', sport: 'a', email: 'a', website: 'a',
      instagram: 'a', contactName: 'a', contactRole: 'a', courtsCount: 1, currentSystem: 'a',
      planInterest: 'a', note: 'a', marketScore: 'a', finScore: 'a', revenueYear: 1n,
    }]);
    prisma.lead.update.mockClear();
    const r2 = await request(app).post('/leads/import').set('Authorization', auth).send({ rows: [yc] });
    expect(r2.body).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  it('валідує тіло: порожній список і > 1000 рядків', async () => {
    expect((await request(app).post('/leads/import').set('Authorization', auth).send({ rows: [] })).status).toBe(400);
    const many = Array.from({ length: 1001 }, () => ({}));
    expect((await request(app).post('/leads/import').set('Authorization', auth).send({ rows: many })).status).toBe(400);
  });
});

describe('POST /leads/:id/convert', () => {
  it('409 CLUB_ALREADY_LINKED, якщо клуб уже привʼязаний до іншого ліда', async () => {
    prisma.lead.findUnique
      .mockResolvedValueOnce(baseLead())
      .mockResolvedValueOnce({ id: OTHER_LEAD_ID });
    prisma.club.findUnique.mockResolvedValue({ id: CLUB_ID, name: 'К', city: null, crmTags: [] });
    const r = await request(app).post(`/leads/${LEAD_ID}/convert`).set('Authorization', auth).send({ clubId: CLUB_ID });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'CLUB_ALREADY_LINKED' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('404 для невідомого ліда й клубу', async () => {
    prisma.lead.findUnique.mockResolvedValue(null);
    prisma.club.findUnique.mockResolvedValue({ id: CLUB_ID });
    const a = await request(app).post(`/leads/${LEAD_ID}/convert`).set('Authorization', auth).send({ clubId: CLUB_ID });
    expect(a.status).toBe(404);
    expect(a.body.error).toBe('LEAD_NOT_FOUND');

    prisma.lead.findUnique.mockResolvedValue(baseLead());
    prisma.club.findUnique.mockResolvedValue(null);
    const b = await request(app).post(`/leads/${LEAD_ID}/convert`).set('Authorization', auth).send({ clubId: CLUB_ID });
    expect(b.status).toBe(404);
    expect(b.body.error).toBe('CLUB_NOT_FOUND');
  });

  it('привʼязує, ставить WON, копіює місто й теги лише в порожні поля клубу, пише два журнали', async () => {
    prisma.lead.findUnique
      .mockResolvedValueOnce(baseLead({ city: 'Львів', tags: ['падел'] }))
      .mockResolvedValueOnce(null);
    prisma.club.findUnique.mockResolvedValue({ id: CLUB_ID, name: 'Корт', city: null, crmTags: [] });
    const r = await request(app).post(`/leads/${LEAD_ID}/convert`).set('Authorization', auth).send({ clubId: CLUB_ID });
    expect(r.status).toBe(200);
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: LEAD_ID }, data: { clubId: CLUB_ID, stage: 'WON' } });
    expect(prisma.club.update).toHaveBeenCalledWith({ where: { id: CLUB_ID }, data: { city: 'Львів', crmTags: ['падел'] } });
    const created = prisma.crmActivity.create.mock.calls.map((c) => c[0].data);
    expect(created).toHaveLength(2);
    expect(created.map((d) => Boolean(d.leadId) !== Boolean(d.clubId))).toEqual([true, true]);
    expect(created.every((d) => d.kind === 'SYSTEM')).toBe(true);
  });

  it('не перезаписує наявні місто й теги клубу', async () => {
    prisma.lead.findUnique
      .mockResolvedValueOnce(baseLead({ city: 'Львів', tags: ['падел'] }))
      .mockResolvedValueOnce({ id: LEAD_ID }); // клуб уже привʼязаний до цього ж ліда — не конфлікт
    prisma.club.findUnique.mockResolvedValue({ id: CLUB_ID, name: 'Корт', city: 'Київ', crmTags: ['вручну'] });
    const r = await request(app).post(`/leads/${LEAD_ID}/convert`).set('Authorization', auth).send({ clubId: CLUB_ID });
    expect(r.status).toBe(200);
    expect(prisma.club.update).not.toHaveBeenCalled();
  });
});

describe('журнал дій', () => {
  it('TASK без dueAt — 400 DUE_REQUIRED (лід і клуб)', async () => {
    const a = await request(app).post(`/leads/${LEAD_ID}/activities`).set('Authorization', auth)
      .send({ kind: 'TASK', text: 'Передзвонити' });
    expect(a.status).toBe(400);
    expect(a.body).toEqual({ error: 'DUE_REQUIRED' });
    const b = await request(app).post(`/clubs/${CLUB_ID}/activities`).set('Authorization', auth)
      .send({ kind: 'TASK', text: 'Передзвонити' });
    expect(b.status).toBe(400);
    expect(b.body).toEqual({ error: 'DUE_REQUIRED' });
    expect(prisma.crmActivity.create).not.toHaveBeenCalled();
  });

  it('SYSTEM через API створити не можна, порожній текст — 400', async () => {
    const s = await request(app).post(`/leads/${LEAD_ID}/activities`).set('Authorization', auth)
      .send({ kind: 'SYSTEM', text: 'x' });
    expect(s.status).toBe(400);
    const e = await request(app).post(`/leads/${LEAD_ID}/activities`).set('Authorization', auth)
      .send({ kind: 'NOTE', text: '  ' });
    expect(e.status).toBe(400);
  });

  it('CALL оновлює lastContactAt і переводить NEW у CONTACTED зі SYSTEM-записом', async () => {
    prisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID, stage: 'NEW' });
    const r = await request(app).post(`/leads/${LEAD_ID}/activities`).set('Authorization', auth)
      .send({ kind: 'CALL', text: 'Говорили з директором' });
    expect(r.status).toBe(201);
    const upd = prisma.lead.update.mock.calls[0][0];
    expect(upd.data.stage).toBe('CONTACTED');
    expect(upd.data.lastContactAt).toBeInstanceOf(Date);
    const texts = prisma.crmActivity.create.mock.calls.map((c) => c[0].data.text);
    expect(texts).toContain('Етап: Новий → Контакт');
    expect(prisma.crmActivity.create.mock.calls[0][0].data).toMatchObject({
      leadId: LEAD_ID, kind: 'CALL', author: 'op@test.local',
    });
  });

  it('CALL для ліда на етапі DEMO лише оновлює lastContactAt; NOTE не чіпає ліда', async () => {
    prisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID, stage: 'DEMO' });
    await request(app).post(`/leads/${LEAD_ID}/activities`).set('Authorization', auth)
      .send({ kind: 'MEETING', text: 'Зустріч' });
    expect(prisma.lead.update.mock.calls[0][0].data).not.toHaveProperty('stage');
    expect(prisma.crmActivity.create).toHaveBeenCalledOnce();

    prisma.lead.update.mockClear();
    await request(app).post(`/leads/${LEAD_ID}/activities`).set('Authorization', auth)
      .send({ kind: 'NOTE', text: 'Нотатка' });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  it('TASK з dueAt на клубі створюється', async () => {
    prisma.club.findUnique.mockResolvedValue({ id: CLUB_ID });
    const r = await request(app).post(`/clubs/${CLUB_ID}/activities`).set('Authorization', auth)
      .send({ kind: 'TASK', text: 'Продовжити підписку', dueAt: '2026-11-01T09:00:00Z' });
    expect(r.status).toBe(201);
    expect(prisma.crmActivity.create).toHaveBeenCalledWith({
      data: {
        clubId: CLUB_ID, kind: 'TASK', text: 'Продовжити підписку',
        dueAt: new Date('2026-11-01T09:00:00Z'), author: 'op@test.local',
      },
    });
  });

  it('GET /clubs/:id/activities — за спаданням, до 100', async () => {
    prisma.club.findUnique.mockResolvedValue({ id: CLUB_ID });
    prisma.crmActivity.findMany.mockResolvedValue([{ id: ACT_ID }]);
    const r = await request(app).get(`/clubs/${CLUB_ID}/activities`).set('Authorization', auth);
    expect(r.body).toEqual({ items: [{ id: ACT_ID }] });
    expect(prisma.crmActivity.findMany).toHaveBeenCalledWith({
      where: { clubId: CLUB_ID }, orderBy: { createdAt: 'desc' }, take: 100,
    });
  });

  it('PATCH: done ставить і знімає doneAt; SYSTEM правити не можна', async () => {
    prisma.crmActivity.findUnique.mockResolvedValue({ id: ACT_ID, kind: 'TASK' });
    prisma.crmActivity.update.mockImplementation(async ({ data }: { data: object }) => ({ id: ACT_ID, ...data }));
    const done = await request(app).patch(`/activities/${ACT_ID}`).set('Authorization', auth).send({ done: true });
    expect(done.status).toBe(200);
    expect(prisma.crmActivity.update.mock.calls[0][0].data.doneAt).toBeInstanceOf(Date);
    await request(app).patch(`/activities/${ACT_ID}`).set('Authorization', auth).send({ done: false, text: 'нове' });
    expect(prisma.crmActivity.update.mock.calls[1][0].data).toEqual({ doneAt: null, text: 'нове' });

    const clear = await request(app).patch(`/activities/${ACT_ID}`).set('Authorization', auth).send({ dueAt: null });
    expect(clear.status).toBe(400);
    expect(clear.body.error).toBe('DUE_REQUIRED');

    prisma.crmActivity.findUnique.mockResolvedValue({ id: ACT_ID, kind: 'SYSTEM' });
    const sys = await request(app).patch(`/activities/${ACT_ID}`).set('Authorization', auth).send({ text: 'x' });
    expect(sys.status).toBe(409);
    expect(sys.body).toEqual({ error: 'SYSTEM_ENTRY' });
  });

  it('DELETE: 204, 404, 409 для SYSTEM', async () => {
    prisma.crmActivity.findUnique.mockResolvedValue({ id: ACT_ID, kind: 'NOTE' });
    expect((await request(app).delete(`/activities/${ACT_ID}`).set('Authorization', auth)).status).toBe(204);
    expect(prisma.crmActivity.delete).toHaveBeenCalledWith({ where: { id: ACT_ID } });

    prisma.crmActivity.delete.mockClear();
    prisma.crmActivity.findUnique.mockResolvedValue({ id: ACT_ID, kind: 'SYSTEM' });
    const sys = await request(app).delete(`/activities/${ACT_ID}`).set('Authorization', auth);
    expect(sys.status).toBe(409);
    expect(sys.body).toEqual({ error: 'SYSTEM_ENTRY' });
    expect(prisma.crmActivity.delete).not.toHaveBeenCalled();

    prisma.crmActivity.findUnique.mockResolvedValue(null);
    expect((await request(app).delete(`/activities/${ACT_ID}`).set('Authorization', auth)).status).toBe(404);
  });
});

describe('GET /tasks', () => {
  const { startToday, startTomorrow, weekEnd } = kyivBounds();
  const h = 3600_000;
  const overdueAt = new Date(startToday.getTime() - 5 * h);
  const todayAt = new Date(startToday.getTime() + 1 * h);
  const laterTodayAt = new Date(startTomorrow.getTime() - 1 * h);
  const inThreeDays = new Date(startToday.getTime() + 3 * 24 * h);
  const farAway = new Date(weekEnd.getTime() + 24 * h);

  beforeEach(() => {
    prisma.crmActivity.findMany.mockResolvedValue([
      { id: 't-far', text: 'Далека', dueAt: farAway, lead: null, club: { id: CLUB_ID, name: 'Корт' } },
      { id: 't-today', text: 'Сьогодні', dueAt: laterTodayAt, lead: { id: LEAD_ID, name: 'Клуб', stage: 'DEMO', phone: '+380671330011' }, club: null },
      { id: 't-over', text: 'Прострочена', dueAt: overdueAt, lead: null, club: null },
    ]);
    prisma.lead.findMany.mockResolvedValue([
      { id: 'l-na', name: 'Лід А', stage: 'CONTACTED', phone: '+380501112233', nextAction: 'Надіслати КП', nextActionAt: todayAt },
      { id: 'l-na2', name: 'Лід Б', stage: 'NEW', phone: null, nextAction: null, nextActionAt: inThreeDays },
    ]);
  });

  it('зливає задачі й nextAction, сортує за dueAt і рахує лічильники', async () => {
    const r = await request(app).get('/tasks').set('Authorization', auth);
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual(['t-over', 'l-na', 't-today', 'l-na2', 't-far']);
    expect(r.body.counts).toEqual({ overdue: 1, today: 2, week: 3 });

    const na = r.body.items.find((i: { id: string }) => i.id === 'l-na');
    expect(na).toMatchObject({
      type: 'nextAction', text: 'Надіслати КП',
      lead: { id: 'l-na', name: 'Лід А', stage: 'CONTACTED', phone: '+380501112233' },
    });
    expect(na.club).toBeUndefined();
    expect(r.body.items[0].type).toBe('task');
    expect(r.body.items.find((i: { id: string }) => i.id === 'l-na2').text).toBe('Наступний крок');
    // лише відкриті задачі й активні ліди
    expect(prisma.crmActivity.findMany.mock.calls[0][0].where).toEqual({ kind: 'TASK', doneAt: null });
    expect(prisma.lead.findMany.mock.calls[0][0].where.nextActionAt).toEqual({ not: null });
  });

  it('scope фільтрує список, лічильники лишаються повними', async () => {
    const ids = async (scope: string) => {
      const r = await request(app).get('/tasks').query({ scope }).set('Authorization', auth);
      expect(r.body.counts).toEqual({ overdue: 1, today: 2, week: 3 });
      return r.body.items.map((i: { id: string }) => i.id);
    };
    expect(await ids('overdue')).toEqual(['t-over']);
    expect(await ids('today')).toEqual(['l-na', 't-today']);
    expect(await ids('week')).toEqual(['l-na', 't-today', 'l-na2']);
    expect(await ids('all')).toHaveLength(5);
    expect((await request(app).get('/tasks?scope=nope').set('Authorization', auth)).status).toBe(400);
  });
});
