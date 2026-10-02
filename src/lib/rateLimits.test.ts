import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeLimiter, publicWriteLimiter } from './rateLimits';

describe('rateLimits', () => {
  it('повертає 429 TOO_MANY_REQUESTS після ліміту, коли не пропущений', async () => {
    const app = express().post('/x', makeLimiter({ windowMs: 60_000, limit: 2, enforceInTests: true }), (_q, r) => { r.json({ ok: true }); });
    expect((await request(app).post('/x')).status).toBe(200);
    expect((await request(app).post('/x')).status).toBe(200);
    const res = await request(app).post('/x');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'TOO_MANY_REQUESTS' });
  });

  it('ліміти за замовчуванням вимкнені під тестами', async () => {
    const app = express().post('/x', publicWriteLimiter, (_q, r) => { r.json({ ok: true }); });
    for (let i = 0; i < 35; i++) expect((await request(app).post('/x')).status).toBe(200);
  });

  it('skip пропускає шлях навіть із увімкненим лімітом', async () => {
    const app = express().post('/webhook/a', makeLimiter({
      windowMs: 60_000, limit: 1, enforceInTests: true, skip: (req) => req.path.startsWith('/webhook/'),
    }), (_q, r) => { r.json({ ok: true }); });
    for (let i = 0; i < 3; i++) expect((await request(app).post('/webhook/a')).status).toBe(200);
  });
});
