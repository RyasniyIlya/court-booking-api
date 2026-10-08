import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  club: { findFirst: vi.fn() },
  promo: { findMany: vi.fn() },
  trainer: { findMany: vi.fn() },
  customer: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
};
const sendMessage = vi.fn();

vi.mock('./db', () => ({ prisma }));
vi.mock('./telegram', () => ({ sendMessage, editMessageText: vi.fn(), answerCallback: vi.fn() }));
vi.mock('./playerBot', () => ({ handlePlayerCommand: vi.fn(async () => true) }));

const { pickActiveClub, loadClubContent, loadClubHome, askMarketingConsent, consentKeyboard } = await import('./playerHome');

const PLAN3 = { tier: 3, featTrainers: true, featGroups: true, featAnalytics: true };
const club = (over: Record<string, unknown> = {}) => ({
  id: 'club-1', slug: 'squash', name: 'Squash', address: null, phone: null, timezone: 'Europe/Kyiv',
  botSettings: { welcome: 'Свій текст для {name}' }, plan: PLAN3, ...over,
});

const entry = (id: string, lastActive: string | null, created: string) => ({
  customerId: id, customerName: id, tgLastActiveAt: lastActive ? new Date(lastActive) : null,
  createdAt: new Date(created), club: { id: `club-${id}`, slug: id, name: id },
});

beforeEach(() => {
  vi.resetAllMocks();
  prisma.club.findFirst.mockResolvedValue(club());
  prisma.promo.findMany.mockResolvedValue([]);
  prisma.trainer.findMany.mockResolvedValue([]);
  prisma.customer.findMany.mockResolvedValue([]);
  prisma.customer.update.mockResolvedValue({});
});

describe('pickActiveClub', () => {
  it('порожній список — null', () => {
    expect(pickActiveClub([])).toBeNull();
  });

  it('свіжіший tgLastActiveAt виграє, картка без активності — остання', () => {
    const list = [
      entry('a', null, '2026-09-01'),
      entry('b', '2026-09-10', '2026-01-01'),
      entry('c', '2026-09-20', '2026-01-01'),
    ];
    expect(pickActiveClub(list)?.customerId).toBe('c');
  });

  it('без жодної активності — найновіша картка', () => {
    expect(pickActiveClub([entry('a', null, '2026-01-01'), entry('b', null, '2026-06-01')])?.customerId).toBe('b');
  });

  it('не мутує вхідний масив', () => {
    const list = [entry('a', null, '2026-01-01'), entry('b', '2026-09-10', '2026-01-01')];
    pickActiveClub(list);
    expect(list.map((e) => e.customerId)).toEqual(['a', 'b']);
  });
});

describe('loadClubContent', () => {
  it('акції: активні, тижневі й «до дня народження» без обмеження, на дати — лише ті, що не минули', async () => {
    await loadClubContent('club-1');
    const where = prisma.promo.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ clubId: 'club-1', isActive: true });
    expect(where.OR[0]).toEqual({ kind: { in: ['WEEKLY', 'BIRTHDAY'] } });
    expect(where.OR[1].kind).toBe('DATES');
    /* dateTo ≥ сьогодні: календарна дата як UTC-північ, бо так лежить @db.Date. */
    const gte: Date = where.OR[1].dateTo.gte;
    expect(gte.getUTCHours()).toBe(0);
    expect(Math.abs(gte.getTime() - Date.now())).toBeLessThan(2 * 86_400_000);
  });

  it('клуб бачить лише активні схвалені; кабінет (anyState) — будь-який свій', async () => {
    await loadClubContent('club-1');
    expect(prisma.club.findFirst.mock.calls[0][0].where).toEqual({ id: 'club-1', isActive: true, approvedAt: { not: null } });
    await loadClubContent('club-1', { anyState: true });
    expect(prisma.club.findFirst.mock.calls[1][0].where).toEqual({ id: 'club-1' });
  });

  it('клуб не знайдено — null без запитів про акції', async () => {
    prisma.club.findFirst.mockResolvedValue(null);
    expect(await loadClubContent('x')).toBeNull();
    expect(prisma.promo.findMany).not.toHaveBeenCalled();
  });

  it('підписи акцій і тренери на сьогодні збираються з даних клубу', async () => {
    prisma.promo.findMany.mockResolvedValue([
      { id: 'p1', title: 'Ранок', kind: 'WEEKLY', weekdays: [1, 2, 3, 4, 5], startMinute: 420, endMinute: 720, discountType: 'PERCENT', discountValue: 20 },
    ]);
    const all = Array.from({ length: 7 }, (_, weekday) => ({ weekday, openMinute: 600, closeMinute: 1080, isClosed: false }));
    prisma.trainer.findMany.mockResolvedValue([{ id: 't1', name: 'Анна', hours: all, exceptions: [] }]);

    const c = await loadClubContent('club-1');
    expect(c!.promos).toEqual([{ id: 'p1', title: 'Ранок', summary: '−20% · пн–пт · 07:00–12:00' }]);
    expect(c!.trainers).toEqual([{ id: 't1', name: 'Анна', from: '10:00', to: '18:00' }]);
  });
});

describe('loadClubHome', () => {
  it('для гравця: імʼя з картки, свій текст власника, tgLastActiveAt оновлюється', async () => {
    prisma.customer.findUnique.mockResolvedValue({ name: 'Олена', telegramChatId: null });
    const view = await loadClubHome('club-1', 'c1');
    expect(view!.text).toContain('Свій текст для Олена');
    expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { tgLastActiveAt: expect.any(Date) } });
  });

  it('для гостя: нічого не оновлюється', async () => {
    const view = await loadClubHome('club-1', null);
    expect(view!.text).toContain('Свій текст для гостю');
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });

  it('без тарифу налаштування власника не діють — типовий текст', async () => {
    prisma.club.findFirst.mockResolvedValue(club({ plan: null }));
    const view = await loadClubHome('club-1', null);
    expect(view!.text).not.toContain('Свій текст');
    expect(view!.text).toContain('Це бот клубу Squash');
  });

  it('otherClubs рахує інші клуби цього чату', async () => {
    prisma.customer.findUnique.mockResolvedValue({ name: 'Олена', telegramChatId: '555' });
    prisma.customer.findMany.mockResolvedValue([
      { id: 'c1', name: 'Олена', tgLastActiveAt: null, createdAt: new Date(), club: { id: 'club-1', slug: 'squash', name: 'Squash', plan: PLAN3 } },
      { id: 'c2', name: 'Олена', tgLastActiveAt: null, createdAt: new Date(), club: { id: 'club-2', slug: 'padel', name: 'Padel', plan: PLAN3 } },
    ]);
    const view = await loadClubHome('club-1', 'c1');
    expect(view!.keyboard.flat().map((b) => b.text)).toContain('🔁 Інший клуб');
  });

  it('недоступний клуб — null', async () => {
    prisma.club.findFirst.mockResolvedValue(null);
    expect(await loadClubHome('x', null)).toBeNull();
  });
});

describe('askMarketingConsent', () => {
  it('питає один раз і записує tgMarketingAskedAt', async () => {
    prisma.customer.findUnique.mockResolvedValue({ tgMarketingAskedAt: null });
    await askMarketingConsent('555', 'c1');
    expect(sendMessage).toHaveBeenCalledWith('555', expect.stringContaining('Надсилати вам акції клубу'), consentKeyboard('c1'));
    expect(consentKeyboard('c1').inline_keyboard[0].map((b) => b.callback_data)).toEqual(['mk:yes:c1', 'mk:no:c1']);
    expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { tgMarketingAskedAt: expect.any(Date) } });
  });

  it('уже питали — мовчить', async () => {
    prisma.customer.findUnique.mockResolvedValue({ tgMarketingAskedAt: new Date() });
    await askMarketingConsent('555', 'c1');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });
});
