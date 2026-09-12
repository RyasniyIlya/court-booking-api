import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Нагадування перед заняттям.
 *
 * Перевіряється розподіл і момент: кому приходить, кому НЕ приходить і чи
 * не приходить двічі. Кожен кейс — помилка, яку в бою побачити майже
 * неможливо: вона виглядає як тиша або як зайве повідомлення вночі.
 */

const prisma = {
  booking: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
};
const sendMessage = vi.fn();

vi.mock('./db', () => ({ prisma }));
vi.mock('./telegram', () => ({ sendMessage }));
vi.mock('./plans', () => ({ planFeatures: (plan: unknown) => ({ telegram: plan !== 'lite' }) }));

const { runReminderTick, resetReminders } = await import('./remind');

const NOW = new Date('2026-10-15T12:00:00Z');
/** Заняття рівно через 10 хвилин — усередині будь-якого інтервалу. */
const SOON = new Date('2026-10-15T12:10:00Z');

const booking = (over: Record<string, unknown> = {}) => ({
  id: 'b-1',
  title: null,
  capacity: null,
  startTime: SOON,
  endTime: new Date('2026-10-15T13:00:00Z'),
  customerName: 'Петро',
  trainerId: 'trainer-1',
  clubId: 'club-1',
  court: { name: 'Корт 1' },
  club: { plan: 'pro', timezone: 'Europe/Kyiv' },
  _count: { seats: 4 },
  ...over,
});

const person = (over: Record<string, unknown> = {}) => ({
  id: 'u-1',
  clubId: 'club-1',
  role: 'OWNER',
  trainerId: null,
  tgChatId: 'chat-1',
  tgNotifyTournaments: true,
  tgNotifyGroups: true,
  tgNotifySessions: true,
  tgRemindMinutes: 15,
  ...over,
});

const group = { capacity: 8, title: 'Ранкова група' };
const tournament = { capacity: 16, title: '🏆 Кубок клубу' };

const text = () => sendMessage.mock.calls[0]?.[1] as string | undefined;
const chats = () => sendMessage.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  resetReminders();
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
});

describe('кому що нагадують', () => {
  /* Головне, заради чого все це: тренер о 17:45 зайнятий попереднім
     заняттям і в кабінет не дивиться. */
  it('тренер отримує нагадування про власне заняття', async () => {
    prisma.booking.findMany.mockResolvedValue([booking()]);
    prisma.user.findMany.mockResolvedValue([
      person({ role: 'TRAINER', trainerId: 'trainer-1', tgChatId: 'trainer-chat' }),
    ]);

    expect(await runReminderTick(NOW)).toBe(1);
    expect(chats()).toEqual(['trainer-chat']);
    expect(text()).toContain('ваше заняття');
  });

  /* Приватних броней у клубі з десятьма кортами сорок на день. Персонал,
     якому вони приходили б, вимкнув би бота цілком. */
  it('персоналу про приватну бронь не нагадують', async () => {
    prisma.booking.findMany.mockResolvedValue([booking({ trainerId: null })]);
    prisma.user.findMany.mockResolvedValue([person({ role: 'OWNER' }), person({ id: 'u-2', role: 'ADMIN' })]);

    expect(await runReminderTick(NOW)).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(['OWNER', 'ADMIN'])('%s отримує нагадування про турнір і групове', async (role) => {
    prisma.booking.findMany.mockResolvedValue([
      booking({ id: 'b-t', ...tournament }),
      booking({ id: 'b-g', ...group }),
    ]);
    prisma.user.findMany.mockResolvedValue([person({ role })]);

    expect(await runReminderTick(NOW)).toBe(2);
    const all = sendMessage.mock.calls.map((c) => c[1] as string).join('\n');
    expect(all).toContain('турнір');
    expect(all).toContain('групове заняття');
  });

  it('вимкнений рядок гасить саме свій потік, не чіпаючи сусідній', async () => {
    prisma.booking.findMany.mockResolvedValue([
      booking({ id: 'b-t', ...tournament }),
      booking({ id: 'b-g', ...group }),
    ]);
    prisma.user.findMany.mockResolvedValue([person({ tgNotifyGroups: false })]);

    expect(await runReminderTick(NOW)).toBe(1);
    expect(text()).toContain('турнір');
  });

  it('тренер із вимкненими нагадуваннями не отримує нічого', async () => {
    prisma.booking.findMany.mockResolvedValue([booking()]);
    prisma.user.findMany.mockResolvedValue([
      person({ role: 'TRAINER', trainerId: 'trainer-1', tgNotifySessions: false }),
    ]);

    expect(await runReminderTick(NOW)).toBe(0);
  });

  /* Чужий розклад — не його справа. */
  it('тренер не бачить занять іншого тренера', async () => {
    prisma.booking.findMany.mockResolvedValue([booking({ ...group, trainerId: 'trainer-2' })]);
    prisma.user.findMany.mockResolvedValue([
      person({ role: 'TRAINER', trainerId: 'trainer-1' }),
    ]);

    expect(await runReminderTick(NOW)).toBe(0);
  });

  it('чужий клуб не зачіпає', async () => {
    prisma.booking.findMany.mockResolvedValue([booking(group)]);
    prisma.user.findMany.mockResolvedValue([person({ clubId: 'club-2' })]);

    expect(await runReminderTick(NOW)).toBe(0);
  });

  it('на молодшому тарифі не йде нікуди', async () => {
    prisma.booking.findMany.mockResolvedValue([
      booking({ ...group, club: { plan: 'lite', timezone: 'Europe/Kyiv' } }),
    ]);
    prisma.user.findMany.mockResolvedValue([person()]);

    expect(await runReminderTick(NOW)).toBe(0);
  });

  /* Власник, який сам веде групу, отримує її як СВОЄ заняття. */
  it('власник-тренер отримує одне повідомлення про власну групу', async () => {
    prisma.booking.findMany.mockResolvedValue([booking({ ...group, trainerId: 'trainer-1' })]);
    prisma.user.findMany.mockResolvedValue([person({ role: 'OWNER', trainerId: 'trainer-1' })]);

    expect(await runReminderTick(NOW)).toBe(1);
    expect(text()).toContain('ваше заняття');
  });
});

describe('коли саме', () => {
  /* Інтервал у кожного свій: адміністратор за годину готує зал, тренеру
     за годину рано — він ще на попередньому занятті. */
  it('кожному за його інтервал, а не за спільний', async () => {
    /* Заняття через 40 хвилин: для «за 60» уже пора, для «за 15» — ні. */
    prisma.booking.findMany.mockResolvedValue([
      booking({ ...group, startTime: new Date('2026-10-15T12:40:00Z') }),
    ]);
    prisma.user.findMany.mockResolvedValue([
      person({ id: 'u-early', tgChatId: 'chat-60', tgRemindMinutes: 60 }),
      person({ id: 'u-late', tgChatId: 'chat-15', tgRemindMinutes: 15 }),
    ]);

    expect(await runReminderTick(NOW)).toBe(1);
    expect(chats()).toEqual(['chat-60']);
  });

  it('двічі про те саме не нагадує', async () => {
    prisma.booking.findMany.mockResolvedValue([booking(group)]);
    prisma.user.findMany.mockResolvedValue([person()]);

    expect(await runReminderTick(NOW)).toBe(1);
    expect(await runReminderTick(new Date(NOW.getTime() + 60_000))).toBe(0);
  });

  /* Якщо тік пропустили (рестарт, завислий запит), нагадування має
     прийти із запізненням — це краще, ніж не прийти зовсім. */
  it('пропущений тік надолужує, а не мовчить', async () => {
    prisma.booking.findMany.mockResolvedValue([
      booking({ ...group, startTime: new Date('2026-10-15T12:02:00Z') }),
    ]);
    prisma.user.findMany.mockResolvedValue([person({ tgRemindMinutes: 15 })]);

    expect(await runReminderTick(NOW)).toBe(1);
  });

  /* Заняття, яке вже почалось, у вибірку не потрапляє — за це відповідає
     умова запиту, і саме її тут і перевіряємо. */
  it('бере тільки майбутнє і тільки живі статуси', async () => {
    await runReminderTick(NOW);

    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['PENDING', 'CONFIRMED'] });
    expect(where.startTime.gt).toEqual(NOW);
    expect(where.startTime.lte.getTime()).toBe(NOW.getTime() + 60 * 60_000);
  });

  it('непідключені чати відсіюються запитом', async () => {
    prisma.booking.findMany.mockResolvedValue([booking(group)]);
    await runReminderTick(NOW);

    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tgChatId: { not: null } }),
    }));
  });
});

describe('текст', () => {
  it('у груповому головне — скільки людей прийде', async () => {
    prisma.booking.findMany.mockResolvedValue([booking({ ...group, _count: { seats: 5 } })]);
    prisma.user.findMany.mockResolvedValue([person()]);

    await runReminderTick(NOW);
    expect(text()).toContain('Учасників: 5 з 8');
    expect(text()).toContain('Ранкова група');
  });

  it('час — у таймзоні клубу, а не сервера', async () => {
    prisma.booking.findMany.mockResolvedValue([booking(group)]);
    prisma.user.findMany.mockResolvedValue([person()]);

    await runReminderTick(NOW);
    /* 12:10 UTC — це 15:10 у Києві. */
    expect(text()).toContain('15:10');
  });

  it('недоступний чат не ламає розсилку решті', async () => {
    prisma.booking.findMany.mockResolvedValue([booking(group)]);
    prisma.user.findMany.mockResolvedValue([
      person({ id: 'u-1', tgChatId: 'blocked' }),
      person({ id: 'u-2', tgChatId: 'chat-2' }),
    ]);
    sendMessage.mockRejectedValueOnce(new Error('bot was blocked'));

    expect(await runReminderTick(NOW)).toBe(1);
    expect(chats()).toEqual(['blocked', 'chat-2']);
  });
});
