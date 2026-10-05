import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Стрічка подій партнера: порядок, ліміт, українські тексти, жодних сум. */

const prisma = {
  club: { findMany: vi.fn() },
  clubInvoice: { findMany: vi.fn() },
  partnerAct: { findMany: vi.fn() },
  serviceRequest: { findMany: vi.fn() },
  lead: { findMany: vi.fn() },
};
vi.mock('./db', () => ({ prisma }));
const { buildPartnerFeed } = await import('./partnerFeed');

const d = (s: string) => new Date(`${s}T00:00:00Z`);

beforeEach(() => {
  vi.resetAllMocks();
  prisma.club.findMany.mockResolvedValue([{ id: 'c1', name: 'Падел Арена', partnerAttachedAt: d('2026-01-10') }]);
  prisma.clubInvoice.findMany.mockResolvedValue([{ id: 'i1', paidAt: d('2026-03-01'), amount: 123456, club: { name: 'Падел Арена' } }]);
  prisma.partnerAct.findMany.mockImplementation(async ({ where }: { where: { issuedAt?: unknown } }) =>
    where.issuedAt ? [{ id: 'a1', issuedAt: d('2026-04-01'), number: 'А-1' }] : [{ id: 'a1', paidAt: d('2026-05-01'), number: 'А-1' }]);
  prisma.serviceRequest.findMany.mockResolvedValue([{ id: 's1', kind: 'nets', createdAt: d('2026-02-01'), club: { name: 'Падел Арена' } }]);
  prisma.lead.findMany.mockResolvedValue([{ id: 'l1', stage: 'DEMO', updatedAt: d('2026-06-01'), name: 'Клуб Х' }]);
});

describe('buildPartnerFeed', () => {
  it('новіші першими', async () => {
    const feed = await buildPartnerFeed('p1');
    expect(feed.map((e) => e.type)).toEqual(['LEAD_STAGE', 'ACT_PAID', 'ACT_ISSUED', 'INVOICE_PAID', 'SERVICE_REQUEST', 'CLUB_ATTACHED']);
  });

  it('поважає limit', async () => {
    const feed = await buildPartnerFeed('p1', 2);
    expect(feed).toHaveLength(2);
    expect(feed[0].type).toBe('LEAD_STAGE');
  });

  it('тексти українською', async () => {
    const feed = await buildPartnerFeed('p1');
    const by = Object.fromEntries(feed.map((e) => [e.type, e.text]));
    expect(by.CLUB_ATTACHED).toBe('Клуб «Падел Арена» привʼязаний до вас');
    expect(by.SERVICE_REQUEST).toContain('заміна сіток');
    expect(by.LEAD_STAGE).toContain('демо проведено');
    expect(by.ACT_ISSUED).toBe('Акт А-1 видано');
    expect(by.ACT_PAID).toBe('Акт А-1 оплачено');
  });

  it('INVOICE_PAID без суми', async () => {
    const e = (await buildPartnerFeed('p1')).find((x) => x.type === 'INVOICE_PAID')!;
    expect(e.text).toBe('Клуб «Падел Арена» оплатив підписку');
    expect(JSON.stringify(e)).not.toContain('123456');
  });

  it('усі запити обмежені партнером', async () => {
    await buildPartnerFeed('p1');
    expect(prisma.club.findMany.mock.calls[0][0].where.partnerId).toBe('p1');
    expect(prisma.clubInvoice.findMany.mock.calls[0][0].where.club).toEqual({ partnerId: 'p1' });
    for (const c of prisma.partnerAct.findMany.mock.calls) expect(c[0].where.partnerId).toBe('p1');
    expect(prisma.serviceRequest.findMany.mock.calls[0][0].where).toEqual({ partnerId: 'p1' });
    expect(prisma.lead.findMany.mock.calls[0][0].where).toEqual({ partnerId: 'p1' });
  });
});
