import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Рішення власника 2026-09-28: модератор не бачить прибуток, витрати,
 * виплати тренерам і аналітику. Відкриті лише картки клієнтів.
 */

const touched = vi.fn();
const prisma = new Proxy({}, {
  get: () => new Proxy({}, { get: () => (...a: unknown[]) => { touched(...a); return Promise.resolve(null); } }),
});
vi.mock('../lib/db', () => ({ prisma }));

let role = 'ADMIN';
vi.mock('./admin', async () => {
  const shared = await vi.importActual<typeof import('./admin/shared')>('./admin/shared');
  return {
    requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
      req.auth = { userId: 'u1', clubId: 'club-1', role, trainerId: null };
      next();
    },
    requireRole: shared.requireRole,
    requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

const { analyticsRouter } = await import('./analytics');
const app = express().use(express.json()).use(analyticsRouter);
const UUID = '22222222-2222-4222-8222-222222222222';

describe('analytics для ADMIN', () => {
  const blocked: [string, string][] = [
    ['get', '/summary'], ['get', '/deep'], ['get', '/forecast'], ['get', '/load'], ['get', '/traffic'],
    ['get', '/trainers/load'], ['get', '/trainers/popular'], ['get', '/customers/top'],
    ['get', '/expenses'], ['post', '/expenses'], ['delete', `/expenses/${UUID}`],
  ];

  it.each(blocked)('%s %s — 403, БД не торкається', async (method, path) => {
    role = 'ADMIN';
    touched.mockClear();
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](path);
    expect(res.status).toBe(403);
    expect(touched).not.toHaveBeenCalled();
  });

  it.each(['/customers', `/customers/${UUID}/visits`])('картка клієнта %s не закрита для ADMIN', async (path) => {
    role = 'ADMIN';
    const res = await request(app).get(path);
    expect(res.status).not.toBe(403);
  });

  it('OWNER проходить на /expenses', async () => {
    role = 'OWNER';
    const res = await request(app).get('/expenses');
    expect(res.status).not.toBe(403);
  });

  it('ACCOUNTANT на analytics — як і раніше 403', async () => {
    role = 'ACCOUNTANT';
    expect((await request(app).get('/summary')).status).toBe(403);
  });
});
