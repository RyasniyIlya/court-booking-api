import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Кому і що йде про бронь.
 *
 * Текст повідомлень тут майже не перевіряється — його перепишуть завтра.
 * Перевіряється розподіл, тобто рівно те, через що ця функція зʼявилась:
 * хто МАЄ отримати, хто НЕ має, і хто не має отримати двічі. Кожен кейс
 * нижче — окремий баг, який уже був у бою або стався б при першій же
 * зміні в маршрутах.
 */

const prisma = {
  booking: { findUnique: vi.fn() },
  bookingSeat: { findUnique: vi.fn() },
  club: { findUnique: vi.fn() },
  user: { findMany: vi.fn() },
};

const sendMessage = vi.fn();

vi.mock('./db', () => ({ prisma }));
vi.mock('./telegram', () => ({ sendMessage }));
vi.mock('./plans', () => ({ planFeatures: (plan: unknown) => ({ telegram: plan !== 'lite' }) }));

const { notifyBooking, notifySeriesCancelled } = await import('./notifyBooking');

const BOOKING_ID = 'booking-1';
const TRAINER_ID = 'trainer-1';

const booking = (over: Record<string, unknown> = {}) => ({
  title: null,
  startTime: new Date('2026-10-15T09:00:00Z'),
  endTime: new Date('2026-10-15T10:00:00Z'),
  priceTotal: 45000,
  promoNames: [],
  promoDiscount: 0,
  customerName: 'Петро',
  customerPhone: '+380671112233',
  trainerId: TRAINER_ID,
  court: { name: 'Корт 1' },
  trainer: { name: 'Марія' },
  club: { id: 'club-1', plan: 'pro', timezone: 'Europe/Kyiv', telegramChatId: 'club-chat' },
  ...over,
});

/** Текст, який дістався конкретному чату */
const textFor = (chatId: string) =>
  sendMessage.mock.calls.find((c) => c[0] === chatId)?.[1] as string | undefined;

const chats = () => sendMessage.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.booking.findUnique.mockResolvedValue(booking());
  prisma.user.findMany.mockResolvedValue([]);
  prisma.bookingSeat.findUnique.mockResolvedValue(null);
  prisma.club.findUnique.mockResolvedValue({
    plan: 'pro', timezone: 'Europe/Kyiv', telegramChatId: 'club-chat',
  });
});

describe('notifyBooking', () => {
  it('клубна група і персонал бачать телефон і гроші', async () => {
    prisma.user.findMany.mockResolvedValue([
      { tgChatId: 'owner-chat', role: 'OWNER' },
      { tgChatId: 'mod-chat', role: 'ADMIN' },
    ]);

    await notifyBooking({ bookingId: BOOKING_ID, event: 'created' });

    expect(chats().sort()).toEqual(['club-chat', 'mod-chat', 'owner-chat']);
    for (const chat of ['club-chat', 'owner-chat', 'mod-chat']) {
      expect(textFor(chat)).toContain('+380671112233');
      expect(textFor(chat)).toContain('450.00 грн');
    }
  });

  it('клуб і модератор бачать, яку акцію використав клієнт', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({
      priceTotal: 36000,
      promoNames: ['Щаслива година'],
      promoDiscount: 9000,
    }));
    prisma.user.findMany.mockResolvedValue([{ tgChatId: 'mod-chat', role: 'ADMIN' }]);

    await notifyBooking({ bookingId: BOOKING_ID, event: 'created' });

    for (const chat of ['club-chat', 'mod-chat']) {
      expect(textFor(chat)).toContain('Акція: Щаслива година');
      expect(textFor(chat)).toContain('знижка 90.00 грн');
    }
  });

  /* Головне правило видимості: у кабінеті виручка від ролі TRAINER
     закрита, і бот не має бути обхідним шляхом до неї. */
  it('тренер бачить своє заняття, але не гроші клубу', async () => {
    prisma.user.findMany.mockResolvedValue([{ tgChatId: 'trainer-chat', role: 'TRAINER' }]);

    await notifyBooking({ bookingId: BOOKING_ID, event: 'created' });

    const text = textFor('trainer-chat')!;
    expect(text).toContain('Корт 1');
    expect(text).toContain('Петро');
    expect(text).not.toContain('450.00');
    expect(text).not.toContain('грн');
  });

  /* Власник, який сам стоїть у розкладі тренером, підпадає під обидві
     гілки OR. Без збірки в Map він отримав би бронь двічі. */
  it('власник-тренер отримує одне повідомлення, і саме повне', async () => {
    prisma.user.findMany.mockResolvedValue([{ tgChatId: 'boss-chat', role: 'OWNER' }]);

    await notifyBooking({ bookingId: BOOKING_ID, event: 'created' });

    expect(chats().filter((c) => c === 'boss-chat')).toHaveLength(1);
    expect(textFor('boss-chat')).toContain('450.00 грн');
  });

  it('skipClubChat лишає групу мовчазною, але персонал повідомляє', async () => {
    prisma.user.findMany.mockResolvedValue([{ tgChatId: 'owner-chat', role: 'OWNER' }]);

    await notifyBooking({ bookingId: BOOKING_ID, event: 'created', skipClubChat: true });

    expect(chats()).toEqual(['owner-chat']);
  });

  /* Той, хто натиснув кнопку, не має отримувати підтвердження власної дії.
     Відсіює його SQL — перевіряємо, що параметр справді доїжджає. */
  it('автора дії виключено із запиту', async () => {
    await notifyBooking({ bookingId: BOOKING_ID, event: 'cancelled', actorUserId: 'user-9' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { not: 'user-9' } }),
    }));
  });

  it('вимкнені сповіщення й непідключені чати відсіюються запитом', async () => {
    await notifyBooking({ bookingId: BOOKING_ID, event: 'created' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tgNotifyBookings: true,
        tgChatId: { not: null },
      }),
    }));
  });

  /* Telegram — можливість максимального пакета. Перевірка живе в одному
     місці саме для того, щоб її не забули в черговому маршруті. */
  it('на молодшому тарифі не йде нікуди, включно з групою', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({
      club: { id: 'club-1', plan: 'lite', timezone: 'Europe/Kyiv', telegramChatId: 'club-chat' },
    }));

    await notifyBooking({ bookingId: BOOKING_ID, event: 'created' });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('без тренера в броні його ніхто не шукає', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({ trainerId: null, trainer: null }));

    await notifyBooking({ bookingId: BOOKING_ID, event: 'created' });

    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ role: { in: ['OWNER', 'ADMIN'] } }]);
  });

  it('місце в групі підставляє учасника й ціну місця, а не всього заняття', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({ title: 'Ранкова група' }));
    prisma.bookingSeat.findUnique.mockResolvedValue({
      customerName: 'Олена', customerPhone: '+380509998877', price: 25000,
    });

    await notifyBooking({ bookingId: BOOKING_ID, seatId: 'seat-1', event: 'created' });

    const text = textFor('club-chat')!;
    expect(text).toContain('Ранкова група');
    expect(text).toContain('Олена');
    expect(text).toContain('250.00 грн');
    expect(text).not.toContain('Петро');
  });

  it('зниклу бронь і зникле місце обходить мовчки', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);
    await notifyBooking({ bookingId: BOOKING_ID, event: 'created' });
    expect(sendMessage).not.toHaveBeenCalled();

    prisma.booking.findUnique.mockResolvedValue(booking());
    prisma.bookingSeat.findUnique.mockResolvedValue(null);
    await notifyBooking({ bookingId: BOOKING_ID, seatId: 'seat-1', event: 'created' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  /* Людина заблокувала бота — Telegram віддає помилку. Решта чатів має
     отримати своє, а бронь — не впасти. */
  it('недоступний чат не ховає повідомлення від решти', async () => {
    prisma.user.findMany.mockResolvedValue([{ tgChatId: 'owner-chat', role: 'OWNER' }]);
    sendMessage.mockRejectedValueOnce(new Error('bot was blocked'));

    await expect(notifyBooking({ bookingId: BOOKING_ID, event: 'created' })).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('імʼя з кутовими дужками не ламає HTML-розмітку', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({ customerName: '<b>Петро' }));

    await notifyBooking({ bookingId: BOOKING_ID, event: 'created' });

    expect(textFor('club-chat')).toContain('&lt;b&gt;Петро');
  });

  it('заголовок відрізняє скасування від нової броні', async () => {
    await notifyBooking({ bookingId: BOOKING_ID, event: 'cancelled' });
    expect(textFor('club-chat')).toContain('скасовано');
  });
});

describe('notifySeriesCancelled', () => {
  const series = [
    { trainerId: TRAINER_ID, startTime: new Date('2026-10-15T09:00:00Z'), courtName: 'Корт 1' },
    { trainerId: TRAINER_ID, startTime: new Date('2026-10-22T09:00:00Z'), courtName: 'Корт 1' },
    { trainerId: 'trainer-2', startTime: new Date('2026-10-29T09:00:00Z'), courtName: 'Корт 2' },
  ];

  /* Заради цього функція й існує окремо від notifyBooking: дванадцять
     щотижневих занять не мають перетворитись на дванадцять повідомлень. */
  it('серія — одне повідомлення на отримувача, а не одне на заняття', async () => {
    prisma.user.findMany.mockResolvedValue([{ tgChatId: 'owner-chat', role: 'OWNER' }]);

    await notifySeriesCancelled({ clubId: 'club-1', bookings: series });

    expect(chats().filter((c) => c === 'owner-chat')).toHaveLength(1);
    expect(chats().filter((c) => c === 'club-chat')).toHaveLength(1);
    expect(textFor('club-chat')).toContain('3');
  });

  /* Кожен тренер має побачити СВОЇ зняті заняття: «скасовано 3» тренеру,
     у якого зняли одне, — неправда про його ж розклад. */
  it('кожен тренер бачить число саме своїх занять', async () => {
    prisma.user.findMany.mockImplementation((args: {
      where: { OR?: { trainerId?: string }[] };
    }) => {
      const byTrainer = args.where.OR?.find((o) => o.trainerId);
      if (!byTrainer) return Promise.resolve([]);
      return Promise.resolve([
        { tgChatId: `chat-${byTrainer.trainerId}`, role: 'TRAINER' },
      ]);
    });

    await notifySeriesCancelled({ clubId: 'club-1', bookings: series });

    expect(textFor(`chat-${TRAINER_ID}`)).toContain('2');
    expect(textFor('chat-trainer-2')).toContain('1');
  });

  it('порожня серія не турбує нікого', async () => {
    await notifySeriesCancelled({ clubId: 'club-1', bookings: [] });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
