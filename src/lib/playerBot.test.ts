import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Бот гравця: привʼязка, кнопки під нагадуванням і нагадування за 3 години.
 */

const prisma = {
  customer: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  booking: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  bookingSeat: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  waitlistEntry: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
};
const sendMessage = vi.fn();
const editMessageText = vi.fn();
const answerCallback = vi.fn();
const cancelBookingByCustomer = vi.fn();

vi.mock('./db', () => ({ prisma }));
vi.mock('./telegram', () => ({ sendMessage, sendReminderMessage: sendMessage, editMessageText, answerCallback, botReady: () => true }));
vi.mock('./plans', () => ({ planFeatures: (plan: unknown) => ({ telegram: plan === 'max' }) }));
vi.mock('./customerCancel', async (orig) => ({
  ...(await orig<typeof import('./customerCancel')>()),
  cancelBookingByCustomer,
  cancelSeatByCustomer: vi.fn(),
}));
vi.mock('./waitlist', () => ({ runWaitlistTick: vi.fn() }));

const bot = await import('./playerBot');
const { runPlayerReminderTick } = await import('./playerRemind');

const BOOKING_ID = '11111111-1111-4111-8111-111111111111';
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

const bookingRow = (over: Record<string, unknown> = {}) => ({
  id: BOOKING_ID, status: 'CONFIRMED', capacity: null, title: null,
  startTime: inHours(3), endTime: inHours(4), playerConfirmedAt: null,
  court: { name: 'Корт 1' }, trainer: null,
  customer: { telegramChatId: '111' },
  club: { name: 'Клуб', phone: '+380441112233', timezone: 'Europe/Kyiv', cancelCutoffMinutes: 120 },
  ...over,
});

const press = (data: string, chatId = 111) => ({
  id: 'cb', data, from: { id: chatId }, message: { message_id: 7, chat: { id: chatId } },
});

beforeEach(() => {
  vi.clearAllMocks();
  sendMessage.mockResolvedValue('sent');
  prisma.customer.findMany.mockResolvedValue([]);
});

describe('привʼязка', () => {
  it('start-параметр розбирається тільки у своєму форматі', () => {
    expect(bot.codeFromStartPayload('p_abcdEFGH1234_-xy')).toBe('abcdEFGH1234_-xy');
    expect(bot.codeFromStartPayload('club_demo')).toBeNull();
    expect(bot.codeFromStartPayload('p_short')).toBeNull();
    expect(bot.codeFromStartPayload(undefined)).toBeNull();
  });
});

describe('кнопки під нагадуванням', () => {
  it('«Прийду» ставить мітку і перемальовує картку', async () => {
    prisma.booking.findUnique.mockResolvedValue(bookingRow());
    expect(await bot.handlePlayerCallback(press(`pl:ok:b:${BOOKING_ID}`))).toBe(true);
    expect(prisma.booking.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: BOOKING_ID } }));
    expect(editMessageText.mock.calls[0][2]).toMatch(/Чекаємо вас/);
  });

  it('чужий чат не може ні підтвердити, ні скасувати', async () => {
    prisma.booking.findUnique.mockResolvedValue(bookingRow());
    await bot.handlePlayerCallback(press(`pl:yes:b:${BOOKING_ID}`, 999));
    expect(cancelBookingByCustomer).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(answerCallback).toHaveBeenCalledWith('cb', 'Цей запис вам недоступний');
  });

  it('«Скасувати» спершу перепитує, а скасовує лише «Так»', async () => {
    prisma.booking.findUnique.mockResolvedValue(bookingRow());
    await bot.handlePlayerCallback(press(`pl:ask:b:${BOOKING_ID}`));
    expect(cancelBookingByCustomer).not.toHaveBeenCalled();
    expect(editMessageText.mock.calls[0][2]).toMatch(/Точно скасувати/);

    cancelBookingByCustomer.mockResolvedValue({ ok: true, changed: true });
    await bot.handlePlayerCallback(press(`pl:yes:b:${BOOKING_ID}`));
    expect(cancelBookingByCustomer).toHaveBeenCalledWith(BOOKING_ID);
  });

  it('вікно скасування закрите — кнопки «Скасувати» немає, є телефон клубу', () => {
    const item = {
      kind: 'b' as const, id: BOOKING_ID, chatId: '111', clubName: 'Клуб', clubPhone: '+380441112233',
      timezone: 'Europe/Kyiv', start: inHours(1), end: inHours(2), courtName: 'Корт 1', title: null,
      trainerName: null, cutoffMinutes: 120, active: true, confirmedAt: null,
    };
    const kb = bot.playerCardKeyboard(item, 'remind');
    expect(JSON.stringify(kb)).not.toContain('pl:ask');
    expect(bot.playerCardText(item, 'remind')).toContain('+380441112233');
  });

  it('чужі кнопки не чіпає', async () => {
    expect(await bot.handlePlayerCallback(press('day:1'))).toBe(false);
  });
});

describe('нагадування за 3 години', () => {
  it('claims a lease before sending and marks delivered only afterwards', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: BOOKING_ID, club: { plan: 'max' } }]);
    prisma.bookingSeat.findMany.mockResolvedValue([]);
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });
    prisma.booking.findUnique.mockResolvedValue(bookingRow());

    expect(await runPlayerReminderTick()).toBe(1);
    expect(prisma.booking.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(sendMessage.mock.invocationCallOrder[0]);
    expect(JSON.stringify(sendMessage.mock.calls[0][2])).toContain('pl:ok');
    expect(prisma.booking.updateMany.mock.calls[0][0].data).not.toHaveProperty('playerRemindedAt');
    expect(prisma.booking.updateMany.mock.calls[1][0].data.playerRemindedAt).toBeInstanceOf(Date);
  });

  it('вже нагадане іншим процесом — не шле вдруге', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: BOOKING_ID, club: { plan: 'max' } }]);
    prisma.bookingSeat.findMany.mockResolvedValue([]);
    prisma.booking.updateMany.mockResolvedValue({ count: 0 });

    expect(await runPlayerReminderTick()).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('план без Telegram — нічого не шле і мітку не ставить', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: BOOKING_ID, club: { plan: 'lite' } }]);
    prisma.bookingSeat.findMany.mockResolvedValue([]);

    expect(await runPlayerReminderTick()).toBe(0);
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });
});

describe('де крутиться гравцевий тік', async () => {
  const { playerSchedulerEnabled } = await import('./playerRemind');

  it('на проді — так, локально — лише за явним PLAYER_SCHEDULER=on', () => {
    expect(playerSchedulerEnabled({ NODE_ENV: 'production' })).toBe(true);
    expect(playerSchedulerEnabled({})).toBe(false);
    expect(playerSchedulerEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(playerSchedulerEnabled({ PLAYER_SCHEDULER: 'on' })).toBe(true);
    expect(playerSchedulerEnabled({ NODE_ENV: 'production', PLAYER_SCHEDULER: 'off' })).toBe(false);
  });
});

describe('привʼязка чату до картки', () => {
  it('інші картки цього клубу з тим самим чатом відвʼязуються разом із чергою', async () => {
    prisma.customer.findMany.mockResolvedValue([{ id: 'old-card' }]);
    await bot.linkChatToCustomer('111', 'club-1', 'new-card');
    expect(prisma.customer.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { clubId: 'club-1', telegramChatId: '111', id: { not: 'new-card' } },
    }));
    expect(prisma.waitlistEntry.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { customerId: { in: ['old-card'] }, status: { in: ['WAITING', 'OFFERED'] } },
    }));
    expect(prisma.customer.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-card'] } }, data: { telegramChatId: null },
    });
  });
});

describe('/stop', () => {
  it('відвʼязує чат і знімає згоду на акції, щоб після повторного підключення спитали заново', async () => {
    prisma.customer.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    expect(await bot.handlePlayerCommand('111', '/stop', [])).toBe(true);
    expect(prisma.customer.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['c1', 'c2'] } },
      data: {
        telegramChatId: null, tgLinkCode: null, tgLinkUntil: null,
        tgMarketingAt: null, tgMarketingAskedAt: null,
      },
    });
  });
});

it.each(['retry', 'permanent'])('reminder handles %s without claiming delivery', async outcome => {
  prisma.booking.findMany.mockResolvedValue([{ id: BOOKING_ID, club: { plan: 'max' } }]);
  prisma.bookingSeat.findMany.mockResolvedValue([]);
  prisma.booking.updateMany.mockResolvedValue({ count: 1 });
  prisma.booking.findUnique.mockResolvedValue(bookingRow());
  sendMessage.mockResolvedValue(outcome);
  expect(await runPlayerReminderTick()).toBe(0);
  const data = prisma.booking.updateMany.mock.calls[1][0].data;
  expect(data.playerReminderLeaseUntil).toBeNull();
  if (outcome === 'retry') expect(data).not.toHaveProperty('playerRemindedAt');
});
