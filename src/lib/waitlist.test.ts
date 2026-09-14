import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Черга на зайнятий слот. Перевіряється рівно те, заради чого вона є:
 * кому й коли пишемо, і що нікому не пишемо двічі.
 */

const prisma = {
  waitlistEntry: {
    updateMany: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
  },
  booking: { findMany: vi.fn() },
  block: { findMany: vi.fn() },
  court: { findFirst: vi.fn() },
  customer: { findUnique: vi.fn() },
};
const sendMessage = vi.fn();

vi.mock('./db', () => ({ prisma }));
vi.mock('./telegram', () => ({ sendMessage, answerCallback: vi.fn(), editMessageText: vi.fn() }));
vi.mock('./plans', () => ({ planFeatures: (plan: unknown) => ({ telegram: plan === 'max' }) }));

const { runWaitlistTick, joinWaitlist, OFFER_MINUTES } = await import('./waitlist');

const NOW = new Date('2026-10-15T10:00:00Z');
const START = new Date('2026-10-15T16:00:00Z');
const END = new Date('2026-10-15T17:00:00Z');

const club = { id: 'club-1', slug: 'club', name: 'Клуб', timezone: 'Europe/Kyiv', leadTimeMinutes: 60, plan: 'max' };

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'w1', clubId: club.id, courtId: 'court-1', customerId: 'cust-1',
  startTime: START, endTime: END, status: 'WAITING', offerUntil: null,
  createdAt: new Date('2026-10-14T10:00:00Z'),
  court: { name: 'Корт 1', isActive: true },
  customer: { telegramChatId: '111', isBlocked: false },
  club,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.waitlistEntry.updateMany.mockResolvedValue({ count: 1 });
  prisma.block.findMany.mockResolvedValue([]);
  sendMessage.mockResolvedValue({ message_id: 1 });
});

describe('runWaitlistTick', () => {
  it('пише першому в черзі, коли корт звільнився, і тільки йому', async () => {
    prisma.waitlistEntry.findMany.mockResolvedValue([
      entry(),
      entry({ id: 'w2', customerId: 'cust-2', customer: { telegramChatId: '222', isBlocked: false } }),
    ]);
    prisma.booking.findMany.mockResolvedValue([]);

    expect(await runWaitlistTick(NOW)).toBe(1);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe('111');
    expect(prisma.waitlistEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'w1', status: 'WAITING' },
      data: { status: 'OFFERED', offeredAt: NOW, offerUntil: new Date(NOW.getTime() + OFFER_MINUTES * 60_000) },
    });
  });

  it('поки корт зайнятий — мовчить', async () => {
    prisma.waitlistEntry.findMany.mockResolvedValue([entry()]);
    prisma.booking.findMany.mockResolvedValue([{ customerId: 'someone' }]);

    expect(await runWaitlistTick(NOW)).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('блокування клубу — не звільнення', async () => {
    prisma.waitlistEntry.findMany.mockResolvedValue([entry()]);
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.block.findMany.mockResolvedValue([{ id: 'block' }]);

    expect(await runWaitlistTick(NOW)).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('поки діє фора першого, другому не пише', async () => {
    prisma.waitlistEntry.findMany.mockResolvedValue([
      entry({ status: 'OFFERED', offerUntil: new Date(NOW.getTime() + 5 * 60_000) }),
      entry({ id: 'w2', customerId: 'cust-2', customer: { telegramChatId: '222', isBlocked: false } }),
    ]);
    prisma.booking.findMany.mockResolvedValue([]);

    expect(await runWaitlistTick(NOW)).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('фора згоріла, час ще вільний — пише наступному', async () => {
    prisma.waitlistEntry.findMany.mockResolvedValue([
      entry({ status: 'OFFERED', offerUntil: new Date(NOW.getTime() - 60_000) }),
      entry({ id: 'w2', customerId: 'cust-2', customer: { telegramChatId: '222', isBlocked: false } }),
    ]);
    prisma.booking.findMany.mockResolvedValue([]);

    expect(await runWaitlistTick(NOW)).toBe(1);
    expect(prisma.waitlistEntry.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['w1'] } }, data: { status: 'EXPIRED' } });
    expect(sendMessage.mock.calls[0][0]).toBe('222');
  });

  it('гравець із форою забронював сам — черга для нього закрита', async () => {
    prisma.waitlistEntry.findMany.mockResolvedValue([
      entry({ status: 'OFFERED', offerUntil: new Date(NOW.getTime() + 5 * 60_000) }),
      entry({ id: 'w2', customerId: 'cust-2', customer: { telegramChatId: '222', isBlocked: false } }),
    ]);
    prisma.booking.findMany.mockResolvedValue([{ customerId: 'cust-1' }]);

    await runWaitlistTick(NOW);
    expect(prisma.waitlistEntry.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['w1'] } }, data: { status: 'DONE' } });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('час перехопив хтось інший — перший повертається в чергу на своє місце', async () => {
    prisma.waitlistEntry.findMany.mockResolvedValue([
      entry({ status: 'OFFERED', offerUntil: new Date(NOW.getTime() + 5 * 60_000) }),
    ]);
    prisma.booking.findMany.mockResolvedValue([{ customerId: 'stranger' }]);

    await runWaitlistTick(NOW);
    expect(prisma.waitlistEntry.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['w1'] } },
      data: { status: 'WAITING', offeredAt: null, offerUntil: null },
    });
  });

  it('паралельний тік уже зайняв чергу — другий раз не пише', async () => {
    prisma.waitlistEntry.findMany.mockResolvedValue([entry()]);
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.waitlistEntry.updateMany.mockImplementation(async (args: { where: { status?: string } }) =>
      ({ count: args.where.status === 'WAITING' ? 0 : 1 }));

    expect(await runWaitlistTick(NOW)).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('до початку менше за lead time — онлайн уже не забронювати, черга згорає', async () => {
    const soon = new Date(NOW.getTime() + 30 * 60_000);
    prisma.waitlistEntry.findMany.mockResolvedValue([entry({ startTime: soon, endTime: new Date(soon.getTime() + 3_600_000) })]);

    await runWaitlistTick(NOW);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
    expect(prisma.waitlistEntry.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['w1'] } }, data: { status: 'EXPIRED' } });
  });
});

describe('joinWaitlist', () => {
  const input = { club, customerId: 'cust-1', courtId: 'court-1', start: START, end: END, now: NOW };

  beforeEach(() => {
    prisma.court.findFirst.mockResolvedValue({ id: 'court-1', name: 'Корт 1' });
    prisma.customer.findUnique.mockResolvedValue({ telegramChatId: '111', isBlocked: false });
    prisma.waitlistEntry.findFirst.mockResolvedValue(null);
    prisma.waitlistEntry.count.mockResolvedValue(0);
    prisma.waitlistEntry.create.mockResolvedValue({ id: 'new' });
  });

  it('ставить у чергу на чужу бронь і пише підтвердження', async () => {
    prisma.booking.findMany.mockResolvedValue([{ customerId: 'someone' }]);
    expect(await joinWaitlist(input)).toEqual({ ok: true, id: 'new' });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  });

  it('без Telegram — не ставить: сповістити нікуди', async () => {
    prisma.customer.findUnique.mockResolvedValue({ telegramChatId: null });
    prisma.booking.findMany.mockResolvedValue([{ customerId: 'someone' }]);
    expect(await joinWaitlist(input)).toEqual({ ok: false, code: 'TELEGRAM_REQUIRED' });
  });

  it('вільний час бронюють, а не чекають', async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    expect(await joinWaitlist(input)).toEqual({ ok: false, code: 'SLOT_FREE' });
  });

  it('на власну бронь у чергу не стають', async () => {
    prisma.booking.findMany.mockResolvedValue([{ customerId: 'cust-1' }]);
    expect(await joinWaitlist(input)).toEqual({ ok: false, code: 'ALREADY_MINE' });
  });

  it('повторне натискання не створює дубль', async () => {
    prisma.booking.findMany.mockResolvedValue([{ customerId: 'someone' }]);
    prisma.waitlistEntry.findFirst.mockResolvedValue({ id: 'old' });
    expect(await joinWaitlist(input)).toEqual({ ok: true, id: 'old' });
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('план без Telegram — черги немає', async () => {
    expect(await joinWaitlist({ ...input, club: { ...club, plan: 'lite' } }))
      .toEqual({ ok: false, code: 'TELEGRAM_UNAVAILABLE' });
  });
});

describe('чорний список і вимкнений корт', () => {
  it('гравець із чорного списку не стає в чергу', async () => {
    prisma.court.findFirst.mockResolvedValue({ id: 'court-1', name: 'Корт 1' });
    prisma.customer.findUnique.mockResolvedValue({ telegramChatId: '111', isBlocked: true });
    const res = await joinWaitlist({ club, customerId: 'cust-1', courtId: 'court-1', start: START, end: END, now: NOW });
    expect(res).toEqual({ ok: false, code: 'CUSTOMER_BLOCKED' });
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('потрапив у чорний список, поки чекав, — пропозицію отримує наступний', async () => {
    prisma.waitlistEntry.findMany.mockResolvedValue([
      entry({ customer: { telegramChatId: '111', isBlocked: true } }),
      entry({ id: 'w2', customerId: 'cust-2', customer: { telegramChatId: '222', isBlocked: false } }),
    ]);
    prisma.booking.findMany.mockResolvedValue([]);

    expect(await runWaitlistTick(NOW)).toBe(1);
    expect(prisma.waitlistEntry.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['w1'] } }, data: { status: 'CANCELLED' } });
    expect(sendMessage.mock.calls[0][0]).toBe('222');
  });

  it('клуб вимкнув корт — черга згорає без повідомлень', async () => {
    prisma.waitlistEntry.findMany.mockResolvedValue([entry({ court: { name: 'Корт 1', isActive: false } })]);
    await runWaitlistTick(NOW);
    expect(prisma.waitlistEntry.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['w1'] } }, data: { status: 'EXPIRED' } });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
