import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/** Реєстрація клубу з ?ref= партнера: привʼязка, невідомий код ігнорується. */

const tx = {
  club: { create: vi.fn() },
  clubHours: { createMany: vi.fn() },
  user: { create: vi.fn() },
};
const prisma = {
  user: { findUnique: vi.fn() },
  club: { findUnique: vi.fn() },
  partner: { findUnique: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock('../../lib/db', () => ({ prisma }));

const { authRouter } = await import('./auth');
const app = express().use(express.json()).use(authRouter);

const body = (extra: Record<string, unknown> = {}) => ({
  clubName: 'Padel Test', slug: 'padel-test', email: 'owner@test.ua', password: 'password-123', ...extra,
});

beforeEach(() => {
  vi.resetAllMocks();
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.club.findUnique.mockResolvedValue(null);
  prisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
  tx.club.create.mockResolvedValue({ id: 'club-1', name: 'Padel Test', slug: 'padel-test' });
  tx.clubHours.createMany.mockResolvedValue({});
  tx.user.create.mockResolvedValue({ id: 'u1', role: 'OWNER', passwordHash: 'h' });
});

describe('POST /register з ref', () => {
  it('активний партнер: клуб отримує partnerId і partnerAttachedAt', async () => {
    prisma.partner.findUnique.mockResolvedValue({ id: 'partner-1', isActive: true });
    const res = await request(app).post('/register').send(body({ ref: 'ABCD1234' }));
    expect(res.status).toBe(201);
    expect(prisma.partner.findUnique.mock.calls[0][0].where).toEqual({ refCode: 'abcd1234' });
    const data = tx.club.create.mock.calls[0][0].data;
    expect(data.partnerId).toBe('partner-1');
    expect(data.partnerAttachedAt).toBeInstanceOf(Date);
  });

  it('невідомий код: реєстрація проходить без привʼязки', async () => {
    prisma.partner.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/register').send(body({ ref: 'nonexist' }));
    expect(res.status).toBe(201);
    const data = tx.club.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('partnerId');
    expect(data).not.toHaveProperty('partnerAttachedAt');
  });

  it('неактивний партнер ігнорується; без ref партнера не шукаємо', async () => {
    prisma.partner.findUnique.mockResolvedValue({ id: 'partner-1', isActive: false });
    expect((await request(app).post('/register').send(body({ ref: 'abcd1234' }))).status).toBe(201);
    expect(tx.club.create.mock.calls[0][0].data).not.toHaveProperty('partnerId');

    prisma.partner.findUnique.mockClear();
    expect((await request(app).post('/register').send(body())).status).toBe(201);
    expect(prisma.partner.findUnique).not.toHaveBeenCalled();
  });

  it('збій пошуку партнера не валить реєстрацію', async () => {
    prisma.partner.findUnique.mockRejectedValue(new Error('db'));
    const res = await request(app).post('/register').send(body({ ref: 'abcd1234' }));
    expect(res.status).toBe(201);
  });
});
