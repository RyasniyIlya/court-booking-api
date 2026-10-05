import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

/**
 * Реквізити, оферта, квартальні акти, профілі отримувача.
 * Prisma — простий стан у памʼяті (як у platform-partners.test.ts, але з даними,
 * які переживають кілька запитів).
 */

const A = '11111111-1111-4111-8111-111111111111'; // готовий партнер
const B = '22222222-2222-4222-8222-222222222222'; // не готовий
const C = '33333333-3333-4333-8333-333333333333'; // готовий, без оплат
const CL = '44444444-4444-4444-8444-444444444444';
const SELLER = '55555555-5555-4555-8555-555555555555';

type Row = Record<string, unknown>;
let acts: Row[] = [];
let payouts: Row[] = [];
let sellers: Row[] = [];
let partners: Row[] = [];
let invoices: Row[] = [];

const matchStatus = (cond: unknown, v: unknown) =>
  cond === undefined ? true : typeof cond === 'object' && cond && 'in' in cond ? (cond as { in: unknown[] }).in.includes(v) : cond === v;

const withPartner = (a: Row) => {
  const p = partners.find((x) => x.id === a.partnerId);
  return { ...a, partner: p ? { name: p.name, company: p.company } : null };
};

const prisma = {
  partner: {
    findMany: vi.fn(async (a?: { where?: { id?: string } }) => (a?.where?.id ? partners.filter((p) => p.id === a.where!.id) : partners).map((p) => ({ ...p, _count: { clubs: 1, leads: 0 } }))),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => partners.find((p) => p.id === where.id) ?? null),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
      const p = partners.find((x) => x.id === where.id)!;
      Object.assign(p, data);
      return p;
    }),
  },
  club: {
    findMany: vi.fn(async ({ where }: { where: { partnerId: string } }) =>
      where.partnerId === A
        ? [{ id: CL, name: '<img src=x onerror=1>Клуб', partnerAttachedAt: new Date('2026-01-01T00:00:00Z'), invoices }]
        : []),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  clubInvoice: { create: vi.fn(async ({ data }: { data: Row }) => ({ id: 'inv', ...data })), findUnique: vi.fn(), update: vi.fn() },
  crmActivity: { create: vi.fn(async () => ({})) },
  sellerProfile: {
    findFirst: vi.fn(async () => sellers.find((s) => s.isDefault && s.isActive) ?? null),
    findMany: vi.fn(async () => sellers),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => sellers.find((s) => s.id === where.id) ?? null),
    count: vi.fn(async ({ where }: { where: { isDefault: boolean; isActive: boolean } }) => sellers.filter((s) => s.isDefault === where.isDefault && s.isActive === where.isActive).length),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const s = { id: randomUUID(), isActive: true, createdAt: new Date(), ...data };
      sellers.push(s);
      return s;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
      const s = sellers.find((x) => x.id === where.id)!;
      Object.assign(s, data);
      return s;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { isDefault?: boolean; id?: { not: string } }; data: Row }) => {
      const hit = sellers.filter((s) => (where.isDefault === undefined || s.isDefault === where.isDefault) && (!where.id || s.id !== where.id.not));
      hit.forEach((s) => Object.assign(s, data));
      return { count: hit.length };
    }),
  },
  partnerPayout: {
    findMany: vi.fn(async ({ where }: { where: { partnerId: string } }) => payouts.filter((p) => p.partnerId === where.partnerId)),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const p = { id: randomUUID(), ...data };
      payouts.push(p);
      return p;
    }),
  },
  partnerAct: {
    findUnique: vi.fn(async ({ where }: { where: { id?: string; partnerId_periodFrom?: { partnerId: string; periodFrom: Date } } }) => {
      if (where.id) {
        const a = acts.find((x) => x.id === where.id);
        return a ? withPartner(a) : null;
      }
      const k = where.partnerId_periodFrom!;
      const a = acts.find((x) => x.partnerId === k.partnerId && (x.periodFrom as Date).getTime() === k.periodFrom.getTime());
      return a ? withPartner(a) : null;
    }),
    findFirst: vi.fn(async ({ where }: { where: { id?: string; partnerId?: string; status?: unknown; number?: { startsWith: string } } }) => {
      if (where.number) {
        const l = acts.filter((a) => (a.number as string).startsWith(where.number!.startsWith)).sort((x, y) => (y.number as string).localeCompare(x.number as string));
        return l[0] ?? null;
      }
      return acts.find((a) => a.id === where.id && a.partnerId === where.partnerId && matchStatus(where.status, a.status)) ?? null;
    }),
    findMany: vi.fn(async ({ where }: { where: { partnerId?: string; status?: unknown; periodFrom?: Date } }) =>
      acts
        .filter((a) => (!where.partnerId || a.partnerId === where.partnerId) && matchStatus(where.status, a.status) && (!where.periodFrom || (a.periodFrom as Date).getTime() === where.periodFrom.getTime()))
        .map(withPartner)),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const a = { id: randomUUID(), status: 'DRAFT', issuedAt: null, signedAt: null, paidAt: null, payoutId: null, note: null, createdAt: new Date(), ...data };
      acts.push(a);
      return withPartner(a);
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
      const a = acts.find((x) => x.id === where.id)!;
      Object.assign(a, data);
      return withPartner(a);
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; status: unknown }; data: Row }) => {
      const a = acts.find((x) => x.id === where.id && matchStatus(where.status, x.status));
      if (!a) return { count: 0 };
      Object.assign(a, data);
      return { count: 1 };
    }),
  },
  $transaction: vi.fn(async (fn: unknown) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn as unknown[]))),
};
vi.mock('../lib/db', () => ({ prisma }));

const { JWT_SECRET } = await import('../lib/authSecret');
vi.stubEnv('PLATFORM_ADMIN_EMAIL', 'op@test.local');
vi.stubEnv('PLATFORM_ADMIN_PASSWORD_HASH', 'isolated-platform-fixture');
const { platformCredentialVersion } = await import('../lib/platformAuth');
const { signPartnerToken } = await import('../lib/partnerAuth');
const { makeUaIban } = await import('../lib/partnerRequisites');
const { PARTNER_OFFER_VERSION } = await import('../lib/partnerOffer');
const { platformRouter } = await import('./platform');
const { partnerRouter } = await import('./partner');

const op = express().use(express.json()).use(platformRouter);
const pp = express().use(express.json()).use(partnerRouter);
const opAuth = `Bearer ${jwt.sign({ scope: 'platform', email: 'op@test.local', credentialVersion: platformCredentialVersion() }, JWT_SECRET)}`;
const partnerAuth = (id: string) => `Bearer ${signPartnerToken(id, `hash-${id}`)}`;

const IBAN = makeUaIban('300001', '26001234567890');
const IBAN2 = makeUaIban('305299', '26009876543210');

const requisites = {
  kind: 'FOP', legalName: 'ФОП Партнер', legalCode: '1234567890', taxInfo: 'ЄП 3 група', vatPayer: false, iban: IBAN,
  bankName: 'Банк', legalAddress: 'Київ', signerName: 'Партнер П.П.', signerBasis: 'виписки з ЄДР', docsEmail: 'docs@p.ua',
  kvedConfirmed: true,
};

const d = (s: string) => new Date(s);
const invoice = (id: string, amount: number, paidAt: string, status = 'PAID') => ({ id, clubId: CL, amount, status, paidAt: d(paidAt) });

function reset() {
  sellers = [{
    id: SELLER, kind: 'FOP', label: 'ФОП (тест)', legalName: 'ФОП Продавець', code: '3000000001', taxInfo: null, iban: IBAN2,
    bankName: 'Банк', address: 'Київ', signerName: 'Продавець', signerBasis: 'виписки', email: 's@x.ua', phone: null,
    isDefault: true, isActive: true, createdAt: new Date(),
  }];
  partners = [
    { id: A, name: 'А', company: 'ТОВ А', email: 'a@x.ua', phone: null, passwordHash: `hash-${A}`, refCode: 'aaaa1111', rateFirstYear: 50, rateAfter: 20, isActive: true, ...requisites, contractMode: 'PUBLIC_OFFER', offerAcceptedAt: d('2026-05-01T00:00:00Z'), offerVersion: PARTNER_OFFER_VERSION, contractNo: null, contractDate: null },
    { id: B, name: 'Б', company: null, email: 'b@x.ua', phone: null, passwordHash: `hash-${B}`, refCode: 'bbbb2222', rateFirstYear: 50, rateAfter: 20, isActive: true, kind: null, legalName: null, legalCode: null, taxInfo: null, vatPayer: false, iban: null, bankName: null, legalAddress: null, signerName: null, signerBasis: null, docsEmail: null, kvedConfirmed: false, contractMode: null, offerAcceptedAt: null, offerVersion: null, contractNo: null, contractDate: null },
    { id: C, name: 'В', company: null, email: 'c@x.ua', phone: null, passwordHash: `hash-${C}`, refCode: 'cccc3333', rateFirstYear: 50, rateAfter: 20, isActive: true, ...requisites, contractMode: 'INDIVIDUAL', offerAcceptedAt: null, offerVersion: null, contractNo: '7', contractDate: d('2026-02-01T00:00:00Z') },
  ];
  acts = [];
  payouts = [];
  /* Q3 2026 (Київ): 30.06 21:00Z .. 30.09 21:00Z. Клуб привʼязано 01.01.2026 → ставка 50%. */
  invoices = [
    invoice('i-before', 100000, '2026-06-30T20:59:59Z'), // Q2
    invoice('i-1', 200000, '2026-07-10T10:00:00Z'), // 1000 грн
    invoice('i-2', 150000, '2026-09-30T20:59:59Z'), // останній момент Q3 → 750 грн
    invoice('i-after', 100000, '2026-09-30T21:00:00Z'), // вже Q4 за Києвом
    invoice('i-void', 500000, '2026-08-01T00:00:00Z', 'VOID'),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  reset();
});

const post = (url: string, body?: object) => request(op).post(url).set('Authorization', opAuth).send(body ?? {});
const get = (url: string) => request(op).get(url).set('Authorization', opAuth);

/* -------------------------------------------------------------------------- */

describe('партнер: /me, реквізити, готовність', () => {
  it('не ready: refLink null і missing людськими кодами', async () => {
    const res = await request(pp).get('/me').set('Authorization', partnerAuth(B));
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
    expect(res.body.refLink).toBeNull();
    expect(res.body.missing).toContain('iban');
    expect(res.body.missing).toContain('contract');
    expect(res.body.requisites).toMatchObject({ kind: null, kvedConfirmed: false });
    expect(res.body.contract).toMatchObject({ mode: null, offerAcceptedAt: null });
    expect(res.body).not.toHaveProperty('passwordHash');
    expect(res.body).not.toHaveProperty('offerSnapshot');
  });

  it('ready: refLink є, requisites/contract віддаються', async () => {
    const res = await request(pp).get('/me').set('Authorization', partnerAuth(A));
    expect(res.body.ready).toBe(true);
    expect(res.body.missing).toEqual([]);
    expect(res.body.refLink).toMatch(/\/register\?ref=aaaa1111$/);
    expect(res.body.requisites.iban).toBe(IBAN);
    expect(res.body.contract).toMatchObject({ mode: 'PUBLIC_OFFER', offerVersion: PARTNER_OFFER_VERSION });
  });

  it('PUT /requisites: нормалізує IBAN, ставить requisitesAt, переводить у готовність за договором', async () => {
    const res = await request(pp).put('/requisites').set('Authorization', partnerAuth(B))
      .send({ ...requisites, iban: IBAN.toLowerCase().replace(/(.{4})/g, '$1 '), docsEmail: 'Docs@P.ua' });
    expect(res.status).toBe(200);
    const saved = partners.find((p) => p.id === B)!;
    expect(saved.iban).toBe(IBAN);
    expect(saved.docsEmail).toBe('docs@p.ua');
    expect(saved.requisitesAt).toBeInstanceOf(Date);
    expect(res.body.missing).toEqual(['contract']);
    expect(res.body.refLink).toBeNull();
  });

  it('PUT /requisites: невалідні IBAN/код/вид — 400 з переліком полів', async () => {
    const auth = partnerAuth(B);
    const badIban = await request(pp).put('/requisites').set('Authorization', auth).send({ ...requisites, iban: IBAN.slice(0, -1) + (Number(IBAN.at(-1)) + 1) % 10 });
    expect(badIban.status).toBe(400);
    expect(badIban.body.fields).toContain('iban');
    const badCode = await request(pp).put('/requisites').set('Authorization', auth).send({ ...requisites, kind: 'TOV' });
    expect(badCode.status).toBe(400);
    expect(badCode.body.fields).toContain('legalCode');
    const individual = await request(pp).put('/requisites').set('Authorization', auth).send({ ...requisites, kind: 'INDIVIDUAL' });
    expect(individual.status).toBe(400);
    expect(prisma.partner.update).not.toHaveBeenCalled();
  });

  it('без токена — 401 на всіх нових партнерських маршрутах', async () => {
    for (const r of [
      request(pp).put('/requisites').send({}), request(pp).get('/offer'), request(pp).post('/offer/accept').send({}),
      request(pp).get('/acts'), request(pp).get(`/acts/${randomUUID()}/html`), request(pp).post(`/acts/${randomUUID()}/sign`),
    ]) expect((await r).status).toBe(401);
  });
});

describe('оферта: перегляд і акцепт', () => {
  beforeEach(() => {
    Object.assign(partners.find((p) => p.id === A)!, { contractMode: null, offerAcceptedAt: null, offerVersion: null });
  });

  it('GET /offer: html з реквізитами, accepted=false; значення екрануються', async () => {
    partners.find((p) => p.id === A)!.legalName = '<script>x</script>ФОП';
    sellers[0].legalName = '<img src=x>Продавець';
    const res = await request(pp).get('/offer').set('Authorization', partnerAuth(A));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: PARTNER_OFFER_VERSION, accepted: false });
    expect(res.body.html).toContain('&lt;script&gt;x&lt;/script&gt;ФОП');
    expect(res.body.html).toContain('&lt;img src=x&gt;Продавець');
    expect(res.body.html).not.toMatch(/<script|<img/);
  });

  it('немає основного профілю отримувача — 409 SELLER_NOT_CONFIGURED', async () => {
    sellers = [];
    const get1 = await request(pp).get('/offer').set('Authorization', partnerAuth(A));
    expect(get1.status).toBe(409);
    const acc = await request(pp).post('/offer/accept').set('Authorization', partnerAuth(A)).send({ version: PARTNER_OFFER_VERSION });
    expect(acc.status).toBe(409);
    expect(acc.body).toEqual({ error: 'SELLER_NOT_CONFIGURED' });
  });

  it('акцепт пише версію, IP, режим і знімок обох сторін; партнер стає ready', async () => {
    const res = await request(pp).post('/offer/accept').set('Authorization', partnerAuth(A)).send({ version: PARTNER_OFFER_VERSION });
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.refLink).not.toBeNull();
    const p = partners.find((x) => x.id === A)!;
    expect(p).toMatchObject({ contractMode: 'PUBLIC_OFFER', offerVersion: PARTNER_OFFER_VERSION });
    expect(p.offerAcceptedAt).toBeInstanceOf(Date);
    expect(p.offerIp).toBeTruthy();
    const snap = p.offerSnapshot as { version: string; seller: { legalName: string; iban: string }; partner: { legalName: string; iban: string } };
    expect(snap.version).toBe(PARTNER_OFFER_VERSION);
    expect(snap.seller).toMatchObject({ legalName: 'ФОП Продавець', iban: IBAN2 });
    expect(snap.partner).toMatchObject({ legalName: 'ФОП Партнер', iban: IBAN });
  });

  it('стара версія відхиляється, нічого не пишеться', async () => {
    const res = await request(pp).post('/offer/accept').set('Authorization', partnerAuth(A)).send({ version: '2020-01' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('OFFER_VERSION_CHANGED');
    expect(partners.find((p) => p.id === A)!.offerAcceptedAt).toBeNull();
    const noBody = await request(pp).post('/offer/accept').set('Authorization', partnerAuth(A)).send({});
    expect(noBody.status).toBe(400);
  });

  it('без реквізитів акцепт неможливий; повторний акцепт тієї ж версії дату не змінює', async () => {
    const early = await request(pp).post('/offer/accept').set('Authorization', partnerAuth(B)).send({ version: PARTNER_OFFER_VERSION });
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('REQUISITES_REQUIRED');

    await request(pp).post('/offer/accept').set('Authorization', partnerAuth(A)).send({ version: PARTNER_OFFER_VERSION });
    const first = partners.find((p) => p.id === A)!.offerAcceptedAt;
    await request(pp).post('/offer/accept').set('Authorization', partnerAuth(A)).send({ version: PARTNER_OFFER_VERSION });
    expect(partners.find((p) => p.id === A)!.offerAcceptedAt).toBe(first);
  });

  it('партнеру з індивідуальним договором оферту приймати не потрібно — 409', async () => {
    const res = await request(pp).post('/offer/accept').set('Authorization', partnerAuth(C)).send({ version: PARTNER_OFFER_VERSION });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INDIVIDUAL_CONTRACT');
  });

  it('зміна реквізитів після акцепту оферту не скидає', async () => {
    await request(pp).post('/offer/accept').set('Authorization', partnerAuth(A)).send({ version: PARTNER_OFFER_VERSION });
    const res = await request(pp).put('/requisites').set('Authorization', partnerAuth(A)).send({ ...requisites, legalName: 'ФОП Нова Назва' });
    expect(res.body.ready).toBe(true);
    expect(partners.find((p) => p.id === A)!.offerVersion).toBe(PARTNER_OFFER_VERSION);
  });
});

describe('оператор: профілі отримувача', () => {
  const body = { kind: 'TOV', label: 'ТОВ Спільне', legalName: 'ТОВ «Корт»', code: '12345678', iban: IBAN };

  it('без токена — 401 на всіх нових маршрутах', async () => {
    const id = randomUUID();
    for (const r of [
      request(op).get('/sellers'), request(op).post('/sellers').send({}), request(op).patch(`/sellers/${id}`).send({}),
      request(op).post(`/sellers/${id}/default`), request(op).patch(`/partners/${id}/contract`).send({}),
      request(op).patch(`/partners/${id}/requisites`).send({}), request(op).get('/partner-acts'),
      request(op).post('/partner-acts/generate').send({}), request(op).post(`/partner-acts/${id}/issue`),
      request(op).post(`/partner-acts/${id}/sign`), request(op).post(`/partner-acts/${id}/void`),
      request(op).post(`/partner-acts/${id}/pay`).send({}), request(op).get(`/partner-acts/${id}/html`),
      request(op).patch(`/invoices/${id}/seller`).send({ sellerId: null }),
    ]) expect((await r).status).toBe(401);
  });

  it('POST /sellers: перший стає основним, другий — ні; невалідний IBAN/код — 400', async () => {
    sellers = [];
    const first = await post('/sellers', body);
    expect(first.status).toBe(201);
    expect(first.body.isDefault).toBe(true);
    const second = await post('/sellers', { ...body, label: 'ТОВ 2' });
    expect(second.body.isDefault).toBe(false);
    expect(sellers.filter((s) => s.isDefault)).toHaveLength(1);

    expect((await post('/sellers', { ...body, iban: 'UA12' })).status).toBe(400);
    expect((await post('/sellers', { ...body, code: '1234567890' })).status).toBe(400);
    expect((await post('/sellers', { ...body, kind: 'INDIVIDUAL', code: '1234567890' })).status).toBe(201);
  });

  it('POST /sellers/:id/default перемикає основний; неактивний — 409; PATCH основного вимкнути не можна', async () => {
    const created = await post('/sellers', body);
    const res = await post(`/sellers/${created.body.id}/default`);
    expect(res.status).toBe(200);
    expect(sellers.find((s) => s.id === SELLER)!.isDefault).toBe(false);
    expect(sellers.filter((s) => s.isDefault).map((s) => s.id)).toEqual([created.body.id]);

    const off = await request(op).patch(`/sellers/${created.body.id}`).set('Authorization', opAuth).send({ isActive: false });
    expect(off.status).toBe(409);
    expect(off.body.error).toBe('DEFAULT_SELLER');

    sellers.find((s) => s.id === SELLER)!.isActive = false;
    expect((await post(`/sellers/${SELLER}/default`)).status).toBe(409);
    expect((await post(`/sellers/${randomUUID()}/default`)).status).toBe(404);
  });

  it('PATCH /sellers/:id: частково, перевірка коду за видом', async () => {
    const ok = await request(op).patch(`/sellers/${SELLER}`).set('Authorization', opAuth).send({ label: 'Нова назва' });
    expect(ok.status).toBe(200);
    expect(ok.body.label).toBe('Нова назва');
    const bad = await request(op).patch(`/sellers/${SELLER}`).set('Authorization', opAuth).send({ kind: 'TOV' });
    expect(bad.status).toBe(400);
  });

  it('PATCH /invoices/:id/seller: призначає профіль, null знімає, чужий id — 404', async () => {
    prisma.clubInvoice.findUnique.mockResolvedValueOnce({ id: 'inv-1' });
    const ok = await request(op).patch('/invoices/inv-1/seller').set('Authorization', opAuth).send({ sellerId: SELLER });
    expect(ok.status).toBe(200);
    expect(ok.body.seller).toEqual({ id: SELLER, label: 'ФОП (тест)' });
    expect(prisma.clubInvoice.update).toHaveBeenCalledWith({ where: { id: 'inv-1' }, data: { sellerId: SELLER } });

    prisma.clubInvoice.findUnique.mockResolvedValueOnce({ id: 'inv-1' });
    const missing = await request(op).patch('/invoices/inv-1/seller').set('Authorization', opAuth).send({ sellerId: randomUUID() });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('SELLER_NOT_FOUND');

    prisma.clubInvoice.findUnique.mockResolvedValueOnce(null);
    expect((await request(op).patch('/invoices/nope/seller').set('Authorization', opAuth).send({ sellerId: null })).status).toBe(404);
  });

  it('нове зарахування оплати ставить основний профіль на рахунок', async () => {
    prisma.club.findUnique.mockResolvedValueOnce({
      id: CL, name: 'К', paidUntil: null, billingPeriod: 'MONTH', planPrice: 100000, plan: null, users: [], _count: { courts: 2 },
    });
    prisma.club.update.mockResolvedValueOnce({});
    const res = await post(`/clubs/${CL}/subscription`, { amount: 90000 });
    expect(res.status).toBe(200);
    expect(prisma.clubInvoice.create.mock.calls.at(-1)![0].data).toMatchObject({ sellerId: SELLER, amount: 90000 });
  });
});

describe('оператор: договір і реквізити партнера', () => {
  it('GET /partners: ready, missing, contractMode, offerAcceptedAt, contractNo', async () => {
    const res = await get('/partners');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.map((p: { id: string }) => [p.id, p]));
    expect(byId[A]).toMatchObject({ ready: true, missing: [], contractMode: 'PUBLIC_OFFER', contractNo: null });
    expect(byId[A].offerAcceptedAt).toBeTruthy();
    expect(byId[B]).toMatchObject({ ready: false, contractMode: null });
    expect(byId[B].missing).toContain('iban');
    expect(byId[C]).toMatchObject({ ready: true, contractMode: 'INDIVIDUAL', contractNo: '7' });
    expect(byId[A].requisites.iban).toBe(IBAN);
    expect(prisma.partner.findMany.mock.calls[0][0]!.select).not.toHaveProperty('passwordHash');
expect(prisma.partner.findMany.mock.calls[0][0]!.select).not.toHaveProperty('offerSnapshot');
  });

  it('PATCH contract: INDIVIDUAL вимагає номер і дату; PUBLIC_OFFER очищає їх', async () => {
    const bad = await request(op).patch(`/partners/${B}/contract`).set('Authorization', opAuth).send({ contractMode: 'INDIVIDUAL' });
    expect(bad.status).toBe(400);
    const ok = await request(op).patch(`/partners/${B}/contract`).set('Authorization', opAuth).send({ contractMode: 'INDIVIDUAL', contractNo: 'П-12', contractDate: '2026-03-01' });
    expect(ok.status).toBe(200);
    expect(ok.body.contract).toMatchObject({ mode: 'INDIVIDUAL', contractNo: 'П-12' });
    expect(ok.body.ready).toBe(false); // реквізитів ще немає
    const back = await request(op).patch(`/partners/${C}/contract`).set('Authorization', opAuth).send({ contractMode: 'PUBLIC_OFFER' });
    expect(back.body.contract).toMatchObject({ mode: 'PUBLIC_OFFER', contractNo: null, contractDate: null });
    expect(back.body.missing).toEqual(['contract']);
    expect((await request(op).patch(`/partners/${randomUUID()}/contract`).set('Authorization', opAuth).send({ contractMode: 'PUBLIC_OFFER' })).status).toBe(404);
  });

  it('PATCH requisites: оператор виправляє за партнера, валідація зберігається', async () => {
    const ok = await request(op).patch(`/partners/${B}/requisites`).set('Authorization', opAuth).send({ ...requisites, iban: IBAN });
    expect(ok.status).toBe(200);
    expect(partners.find((p) => p.id === B)!.legalName).toBe('ФОП Партнер');
    const bad = await request(op).patch(`/partners/${B}/requisites`).set('Authorization', opAuth).send({ iban: 'UA00' });
    expect(bad.status).toBe(400);
    const mismatch = await request(op).patch(`/partners/${B}/requisites`).set('Authorization', opAuth).send({ kind: 'TOV' });
    expect(mismatch.status).toBe(400); // код вже 10 цифр
  });
});

describe('квартальні акти', () => {
  it('генерація: Σ винагород у кварталі за Києвом, рядки, номер, DRAFT, знімки сторін', async () => {
    const res = await post('/partner-acts/generate', { quarter: '2026-Q3' });
    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(1);
    const act = res.body.created[0];
    // 1000 грн + 750 грн, 50%: 100000 + 75000; i-before (Q2), i-after (Q4) і VOID не входять
    expect(act).toMatchObject({
      partnerId: A, partnerName: 'ТОВ А', quarter: '2026-Q3', amount: 100000 + 75000, belowMinimum: false,
      status: 'DRAFT', number: 'А-2026-Q3-0001',
    });
    expect(act.lines.map((l: { invoiceId: string }) => l.invoiceId)).toEqual(['i-1', 'i-2']);
    expect(act.lines[0]).toMatchObject({ clubName: '<img src=x onerror=1>Клуб', invoiceAmount: 200000, rate: 50, commission: 100000 });
    expect(act.periodFrom).toBe('2026-06-30T21:00:00.000Z');
    expect(act.periodTo).toBe('2026-09-30T21:00:00.000Z');
    const row = acts[0];
    expect(row.sellerSnapshot).toMatchObject({ legalName: 'ФОП Продавець', iban: IBAN2 });
    expect(row.partnerSnapshot).toMatchObject({ legalName: 'ФОП Партнер', iban: IBAN, contract: { mode: 'PUBLIC_OFFER' } });
  });

  it('сума збігається з calcCommissions за той самий квартал', async () => {
    const { calcCommissions } = await import('../lib/partnerCommission');
    const calc = calcCommissions([{ id: CL, partnerAttachedAt: d('2026-01-01T00:00:00Z'), invoices }], { rateFirstYear: 50, rateAfter: 20 });
    const from = d('2026-06-30T21:00:00Z').getTime();
    const to = d('2026-09-30T21:00:00Z').getTime();
    const expected = calc.rows.filter((r) => r.paidAt.getTime() >= from && r.paidAt.getTime() < to).reduce((s, r) => s + r.commission, 0);
    const res = await post('/partner-acts/generate', { quarter: '2026-Q3', partnerId: A });
    expect(res.body.created[0].amount).toBe(expected);
  });

  it('skipped: не ready, нульова сума; belowMinimum для суми < 1000 грн', async () => {
    const res = await post('/partner-acts/generate', { quarter: '2026-Q3' });
    expect(res.body.skipped).toEqual(expect.arrayContaining([
      { partnerId: B, name: 'Б', reason: 'NOT_READY' },
      { partnerId: C, name: 'В', reason: 'ZERO_AMOUNT' },
    ]));

    reset();
    invoices = [invoice('small', 100000, '2026-07-10T10:00:00Z')]; // 500 грн
    const small = await post('/partner-acts/generate', { quarter: '2026-Q3', partnerId: A });
    expect(small.body.created[0]).toMatchObject({ amount: 50000, belowMinimum: true });
  });

  it('дубль кварталу: 409 для partnerId, у пакеті — skipped ACT_EXISTS; після VOID можна знову', async () => {
    const first = await post('/partner-acts/generate', { quarter: '2026-Q3' });
    const id = first.body.created[0].id;

    const dupSingle = await post('/partner-acts/generate', { quarter: '2026-Q3', partnerId: A });
    expect(dupSingle.status).toBe(409);
    expect(dupSingle.body.error).toBe('ACT_EXISTS');
    const dupBatch = await post('/partner-acts/generate', { quarter: '2026-Q3' });
    expect(dupBatch.body.created).toEqual([]);
    expect(dupBatch.body.skipped).toContainEqual({ partnerId: A, name: 'ТОВ А', reason: 'ACT_EXISTS' });
    expect(acts).toHaveLength(1);

    expect((await post(`/partner-acts/${id}/void`)).status).toBe(200);
    const again = await post('/partner-acts/generate', { quarter: '2026-Q3', partnerId: A });
    expect(again.status).toBe(200);
    expect(again.body.created[0]).toMatchObject({ id, status: 'DRAFT', number: 'А-2026-Q3-0001' });
    expect(acts).toHaveLength(1);
  });

  it('номери: наступний порядковий у кварталі; поганий квартал — 400; немає профілю — 409', async () => {
    acts.push({ id: randomUUID(), partnerId: C, number: 'А-2026-Q3-0007', status: 'PAID', periodFrom: d('2026-06-30T21:00:00Z'), periodTo: d('2026-09-30T21:00:00Z') });
    const res = await post('/partner-acts/generate', { quarter: '2026-Q3', partnerId: A });
    expect(res.body.created[0].number).toBe('А-2026-Q3-0008');

    expect((await post('/partner-acts/generate', { quarter: '2026-Q5' })).status).toBe(400);
    expect((await post('/partner-acts/generate', {})).status).toBe(400);
    sellers = [];
    const noSeller = await post('/partner-acts/generate', { quarter: '2026-Q3' });
    expect(noSeller.status).toBe(409);
    expect(noSeller.body.error).toBe('SELLER_NOT_CONFIGURED');
  });

  it('GET /partner-acts: фільтри status/partnerId/quarter; /generate не плутається з :id', async () => {
    await post('/partner-acts/generate', { quarter: '2026-Q3' });
    expect((await get('/partner-acts')).body).toHaveLength(1);
    expect((await get('/partner-acts?status=ISSUED')).body).toHaveLength(0);
    expect((await get(`/partner-acts?partnerId=${B}`)).body).toHaveLength(0);
    expect((await get('/partner-acts?quarter=2026-Q3')).body).toHaveLength(1);
    expect((await get('/partner-acts?quarter=2026-Q2')).body).toHaveLength(0);
    expect((await get('/partner-acts?quarter=zzz')).status).toBe(400);
  });

  it('ланцюжок DRAFT → ISSUED → SIGNED → PAID і заборонені переходи — 409 BAD_STATUS', async () => {
    const id = (await post('/partner-acts/generate', { quarter: '2026-Q3' })).body.created[0].id;

    for (const bad of ['sign', 'pay']) expect((await post(`/partner-acts/${id}/${bad}`)).body.error).toBe('BAD_STATUS');
    const issued = await post(`/partner-acts/${id}/issue`);
    expect(issued.body.status).toBe('ISSUED');
    expect(issued.body.issuedAt).toBeTruthy();
    expect((await post(`/partner-acts/${id}/issue`)).status).toBe(409);
    expect((await post(`/partner-acts/${id}/pay`)).status).toBe(409);
    const signed = await post(`/partner-acts/${id}/sign`);
    expect(signed.body.status).toBe('SIGNED');
    expect((await post(`/partner-acts/${id}/void`)).status).toBe(409); // підписаний не анулюється
    const paid = await post(`/partner-acts/${id}/pay`, { paidAt: '2026-10-05' });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('PAID');
    expect(new Date(paid.body.paidAt).toISOString().slice(0, 10)).toBe('2026-10-05');
    for (const a of ['issue', 'sign', 'void', 'pay']) expect((await post(`/partner-acts/${id}/${a}`)).status).toBe(409);
    expect((await post(`/partner-acts/${randomUUID()}/issue`)).status).toBe(404);
  });

  it('«Оплачено» створює PartnerPayout з приміткою, due зменшується, повторна оплата неможлива', async () => {
    const before = await get(`/partners/${A}/commissions`);
    const id = (await post('/partner-acts/generate', { quarter: '2026-Q3', partnerId: A })).body.created[0].id;
    await post(`/partner-acts/${id}/issue`);
    await post(`/partner-acts/${id}/sign`);
    await post(`/partner-acts/${id}/pay`);

    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({ partnerId: A, amount: 175000, note: 'Акт №А-2026-Q3-0001' });
    expect(acts[0].payoutId).toBe(payouts[0].id);
    const after = await get(`/partners/${A}/commissions`);
    expect(after.body.totals.due).toBe(before.body.totals.due - 175000);
    expect((await post(`/partner-acts/${id}/pay`)).status).toBe(409);
    expect(payouts).toHaveLength(1);
  });

  it('GET /partner-acts/:id/html: text/html, значення екрануються', async () => {
    partners.find((p) => p.id === A)!.legalName = '<script>x</script>';
    const id = (await post('/partner-acts/generate', { quarter: '2026-Q3', partnerId: A })).body.created[0].id;
    const res = await get(`/partner-acts/${id}/html`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.text).toContain('А-2026-Q3-0001');
    expect(res.text).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(res.text).toContain('&lt;img src=x onerror=1&gt;Клуб');
    expect(res.text).not.toMatch(/<script|<img/);
    expect((await get(`/partner-acts/${randomUUID()}/html`)).status).toBe(404);
  });
});

describe('партнер і його акти', () => {
  let actA: string;
  beforeEach(async () => {
    actA = (await post('/partner-acts/generate', { quarter: '2026-Q3', partnerId: A })).body.created[0].id;
  });

  it('DRAFT і VOID партнер не бачить; після видачі бачить, без чужих', async () => {
    acts.push({ id: randomUUID(), partnerId: C, number: 'А-2026-Q3-0099', status: 'ISSUED', periodFrom: d('2026-06-30T21:00:00Z'), periodTo: d('2026-09-30T21:00:00Z'), amount: 1, lines: [], sellerSnapshot: {}, partnerSnapshot: {}, issuedAt: new Date() });
    expect((await request(pp).get('/acts').set('Authorization', partnerAuth(A))).body).toEqual([]);
    await post(`/partner-acts/${actA}/issue`);
    const list = await request(pp).get('/acts').set('Authorization', partnerAuth(A));
    expect(list.body.map((a: { id: string }) => a.id)).toEqual([actA]);
    expect(list.body[0]).toMatchObject({ status: 'ISSUED', amount: 175000, quarter: '2026-Q3', belowMinimum: false });
    expect(list.body[0]).not.toHaveProperty('sellerSnapshot');
    expect(list.body[0]).not.toHaveProperty('partnerSnapshot');
    await post(`/partner-acts/${actA}/void`);
    expect((await request(pp).get('/acts').set('Authorization', partnerAuth(A))).body).toEqual([]);
  });

  it('html: свій виданий акт — так, DRAFT і чужий — 404', async () => {
    expect((await request(pp).get(`/acts/${actA}/html`).set('Authorization', partnerAuth(A))).status).toBe(404);
    await post(`/partner-acts/${actA}/issue`);
    const own = await request(pp).get(`/acts/${actA}/html`).set('Authorization', partnerAuth(A));
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toMatch(/^text\/html/);
    expect(own.text).not.toMatch(/<img/);
    expect((await request(pp).get(`/acts/${actA}/html`).set('Authorization', partnerAuth(C))).status).toBe(404);
  });

  it('«Підписую»: тільки свій ISSUED → SIGNED; DRAFT/чужий — 404; повторно — 409', async () => {
    expect((await request(pp).post(`/acts/${actA}/sign`).set('Authorization', partnerAuth(A))).status).toBe(404); // DRAFT
    await post(`/partner-acts/${actA}/issue`);
    expect((await request(pp).post(`/acts/${actA}/sign`).set('Authorization', partnerAuth(C))).status).toBe(404);
    const ok = await request(pp).post(`/acts/${actA}/sign`).set('Authorization', partnerAuth(A));
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('SIGNED');
    expect(ok.body.signedAt).toBeTruthy();
    expect((await request(pp).post(`/acts/${actA}/sign`).set('Authorization', partnerAuth(A))).status).toBe(409);
  });
});
