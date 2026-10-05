import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/** Заявки на сервіс у кабінеті партнера: лише свої, чуже — 404, токен обовʼязковий. */

const A = '11111111-1111-4111-8111-111111111111';
const SR_A = '33333333-3333-4333-8333-333333333333';
const SR_B = '44444444-4444-4444-8444-444444444444';

const prisma = {
  partner: { findUnique: vi.fn(), update: vi.fn() },
  serviceRequest: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
};
vi.mock('../lib/db', () => ({ prisma }));
vi.mock('../lib/partnerAnalytics', () => ({ buildPartnerAnalytics: vi.fn() }));
vi.mock('../lib/partnerFeed', () => ({ buildPartnerFeed: vi.fn(async () => []) }));

const { hashPassword } = await import('../lib/passwordHash');
const { signPartnerToken } = await import('../lib/partnerAuth');
const { partnerRouter } = await import('./partner');
const { buildPartnerFeed } = await import('../lib/partnerFeed');

const app = express().use(express.json()).use(partnerRouter);
const hashA = await hashPassword('secret-pass-A', 4);
const partnerA = { id: A, name: 'A', company: null, email: 'a@x.ua', phone: null, passwordHash: hashA, refCode: 'aaaa1111', rateFirstYear: 50, rateAfter: 20, isActive: true, pinFails: 0, pinLockedUntil: null };
const tok = () => `Bearer ${signPartnerToken(A, hashA)}`;

const rows = [
  { id: SR_A, partnerId: A, status: 'NEW', club: { id: 'c-a', name: 'Клуб А' }, court: null },
  { id: SR_B, partnerId: 'other', status: 'NEW', club: { id: 'c-b', name: 'Чужий' }, court: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  prisma.partner.findUnique.mockResolvedValue(partnerA);
  prisma.serviceRequest.findMany.mockImplementation(async ({ where }: { where: { partnerId: string } }) => rows.filter((r) => r.partnerId === where.partnerId));
  prisma.serviceRequest.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null);
  prisma.serviceRequest.update.mockImplementation(async ({ data }: { data: object }) => ({ id: SR_A, ...data }));
});

describe('партнер /service-requests', () => {
  it('401 без токена', async () => {
    expect((await request(app).get('/service-requests')).status).toBe(401);
    expect((await request(app).patch(`/service-requests/${SR_A}`).send({ status: 'DONE' })).status).toBe(401);
    expect((await request(app).get('/feed')).status).toBe(401);
  });

  it('GET віддає лише заявки свого партнера', async () => {
    const res = await request(app).get('/service-requests').set('Authorization', tok());
    expect(res.status).toBe(200);
    expect(res.body.map((r: { id: string }) => r.id)).toEqual([SR_A]);
    expect(prisma.serviceRequest.findMany.mock.calls[0][0].where).toEqual({ partnerId: A });
    expect(JSON.stringify(res.body)).not.toContain('Чужий');
  });

  it('PATCH свою заявку оновлює статус і нотатку', async () => {
    const res = await request(app).patch(`/service-requests/${SR_A}`).set('Authorization', tok()).send({ status: 'IN_PROGRESS', partnerNote: 'виїдемо у вівторок' });
    expect(res.status).toBe(200);
    expect(prisma.serviceRequest.update.mock.calls[0][0].data).toEqual({ status: 'IN_PROGRESS', partnerNote: 'виїдемо у вівторок' });
  });

  it('PATCH чужої заявки — 404, нічого не пишеться', async () => {
    const res = await request(app).patch(`/service-requests/${SR_B}`).set('Authorization', tok()).send({ status: 'DONE' });
    expect(res.status).toBe(404);
    expect(prisma.serviceRequest.update).not.toHaveBeenCalled();
  });

  it('PATCH із кривим статусом — 400', async () => {
    const res = await request(app).patch(`/service-requests/${SR_A}`).set('Authorization', tok()).send({ status: 'HACKED' });
    expect(res.status).toBe(400);
    expect(prisma.serviceRequest.update).not.toHaveBeenCalled();
  });

  it('/feed будує стрічку для свого партнера з обмеженням limit', async () => {
    const res = await request(app).get('/feed?limit=500').set('Authorization', tok());
    expect(res.status).toBe(200);
    expect(buildPartnerFeed).toHaveBeenCalledWith(A, 100);
  });
});
