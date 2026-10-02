import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/** Зміна пароля вимагає поточний; успіх віддає свіжий токен (старий відкликається). */

const prisma = { user: { findUnique: vi.fn(), update: vi.fn() } };
const checkPassword = vi.fn();
vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('../../lib/passwordCheck', () => ({ checkPassword }));

const { authRouter } = await import('./auth');
const { signToken } = await import('./shared');
const app = express().use(express.json()).use(authRouter);

const userId = '44444444-4444-4444-8444-444444444444';
const clubId = '22222222-2222-4222-8222-222222222222';
const auth = () => `Bearer ${signToken({ userId, clubId, role: 'OWNER', trainerId: null }, '1h', 'old-hash')}`;
const change = (body: Record<string, unknown>) =>
  request(app).post('/password').set('Authorization', auth()).send(body);

beforeEach(() => {
  vi.resetAllMocks();
  prisma.user.findUnique.mockResolvedValue({ id: userId, clubId, role: 'OWNER', trainerId: null, passwordHash: 'old-hash' });
  prisma.user.update.mockResolvedValue({});
});

describe('POST /password', () => {
  it('403 INVALID_PASSWORD при хибному поточному, без запису', async () => {
    checkPassword.mockResolvedValue({ ok: false, reason: 'INVALID' });
    const res = await change({ currentPassword: 'wrong', password: 'new-password-1' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'INVALID_PASSWORD' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('423 PASSWORD_LOCKED при блокуванні', async () => {
    checkPassword.mockResolvedValue({ ok: false, reason: 'LOCKED' });
    const res = await change({ currentPassword: 'x', password: 'new-password-1' });
    expect(res.status).toBe(423);
    expect(res.body).toEqual({ error: 'PASSWORD_LOCKED' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('400 без currentPassword', async () => {
    const res = await change({ password: 'new-password-1' });
    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('200 і свіжий токен при вірному поточному', async () => {
    checkPassword.mockResolvedValue({ ok: true });
    const res = await change({ currentPassword: 'right', password: 'new-password-1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.token).toBe('string');
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const { default: jwt } = await import('jsonwebtoken');
    const payload = jwt.decode(res.body.token) as { userId: string; credentialVersion: string };
    expect(payload.userId).toBe(userId);
    expect(payload.credentialVersion).toBeTruthy();
  });
});
