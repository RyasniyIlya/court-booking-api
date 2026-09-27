import { describe, expect, it, vi } from 'vitest';
import { blockAccountant, requireRole, requireStaff } from './shared';

/**
 * requireStaff і blockAccountant — два кільця, що не мають дірки одне в
 * одному. requireStaff відсікає TRAINER і ACCOUNTANT (той самий рівень:
 * обидва мають вужчий, окремо визначений доступ). blockAccountant —
 * ширше кільце для всього adminRouter (index.test.ts перевіряє його на
 * справжній композиції роутерів; тут — сама функція, ізольовано).
 */

function ctx(role?: string) {
  const req = role ? { auth: { userId: 'u', clubId: 'c', role, trainerId: null } } : {};
  const json = vi.fn();
  const res = { status: vi.fn(() => ({ json })) } as unknown as Parameters<typeof requireStaff>[1];
  const next = vi.fn();
  return { req: req as Parameters<typeof requireStaff>[0], res, next, json };
}

describe('requireStaff', () => {
  it('без токена — 401', () => {
    const { req, res, next, json } = ctx();
    requireStaff(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ error: 'UNAUTHORIZED' });
  });

  it.each(['TRAINER', 'ACCOUNTANT'])('%s — 403, у обох вужчий, окремо визначений доступ', (role) => {
    const { req, res, next, json } = ctx(role);
    requireStaff(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: 'FORBIDDEN', requiredRole: ['OWNER', 'ADMIN'] });
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['OWNER', 'ADMIN'])('%s проходить', (role) => {
    const { req, res, next } = ctx(role);
    requireStaff(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('blockAccountant', () => {
  it('ACCOUNTANT — 403 без requiredRole: це периметр, а не рольова перевірка роута', () => {
    const { req, res, next, json } = ctx('ACCOUNTANT');
    blockAccountant(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: 'FORBIDDEN' });
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['OWNER', 'ADMIN', 'TRAINER'])('%s проходить — периметр закриває тільки бухгалтера', (role) => {
    const { req, res, next } = ctx(role);
    blockAccountant(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('без auth пропускає далі — рішення «чи залогінений» лишається за requireAuth', () => {
    const { req, res, next } = ctx();
    blockAccountant(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('requireRole', () => {
  it('ACCOUNTANT не проходить список без себе', () => {
    const { req, res, next, json } = ctx('ACCOUNTANT');
    requireRole('OWNER', 'ADMIN')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: 'FORBIDDEN', requiredRole: ['OWNER', 'ADMIN'] });
  });

  it('ACCOUNTANT проходить, коли явно в списку', () => {
    const { req, res, next } = ctx('ACCOUNTANT');
    requireRole('OWNER', 'ADMIN', 'ACCOUNTANT')(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
