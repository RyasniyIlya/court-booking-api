import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Оцінка тренера в Telegram: тік запиту й кнопки ⭐1…⭐5.
 *
 * Допуск рахує lib/trainerRating.ts (його тести окремо) — тут перевіряємо
 * вибір кандидатів, мітку «запитали», текст з кнопками й розбір натискань.
 */

const prisma = {
  booking: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  bookingSeat: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  trainerRating: { findUnique: vi.fn(), upsert: vi.fn() },
};
const sendReminderMessage = vi.fn();
const editMessageText = vi.fn();
const answerCallback = vi.fn();

vi.mock('./db', () => ({ prisma }));
vi.mock('./telegram', () => ({
  sendMessage: vi.fn(), sendReminderMessage, editMessageText, answerCallback, botReady: () => true,
}));
vi.mock('./plans', () => ({
  planFeatures: (plan: string) => ({ telegram: plan !== 'no-tg', trainers: plan !== 'no-trainers' }),
}));

const { runTrainerRatingTick, ratingAskKeyboard, ratingAskText } = await import('./trainerRatingBot');
const bot = await import('./playerBot');

const BOOKING_ID = '11111111-1111-4111-8111-111111111111';
const SEAT_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-05T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

/** Рядок для loadRatingTarget('b', …): заняття скінчилось годину тому. */
const bookingRow = (over: Record<string, unknown> = {}) => ({
  id: BOOKING_ID, clubId: 'club-1', status: 'CONFIRMED', capacity: null, attendance: 'UNKNOWN',
  startTime: hoursAgo(2), endTime: hoursAgo(1), trainerId: 't-1', customerId: 'cust-1',
  trainer: { name: 'Олена <Іван>' }, customer: { telegramChatId: '111' },
  club: { timezone: 'Europe/Kyiv' },
  ...over,
});

const seatRow = (over: Record<string, unknown> = {}) => ({
  id: SEAT_ID, status: 'BOOKED', customerId: 'cust-1', bookingId: BOOKING_ID,
  customer: { telegramChatId: '111' },
  booking: {
    clubId: 'club-1', status: 'CONFIRMED', capacity: 6, attendance: 'UNKNOWN',
    startTime: hoursAgo(2), endTime: hoursAgo(1), trainerId: 't-1',
    trainer: { name: 'Олена' }, club: { timezone: 'Europe/Kyiv' },
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  sendReminderMessage.mockResolvedValue('sent');
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.bookingSeat.findMany.mockResolvedValue([]);
  prisma.booking.updateMany.mockResolvedValue({ count: 1 });
  prisma.bookingSeat.updateMany.mockResolvedValue({ count: 1 });
  prisma.trainerRating.findUnique.mockResolvedValue(null);
  prisma.trainerRating.upsert.mockResolvedValue({});
});

describe('тік запиту оцінки', () => {
  it('забирає мітку до відправки й шле кнопки з правильним callback_data', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: BOOKING_ID, club: { plan: 'max' } }]);
    prisma.booking.findUnique.mockResolvedValue(bookingRow());

    expect(await runTrainerRatingTick(NOW)).toBe(1);

    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: BOOKING_ID, rateAskedAt: null }, data: { rateAskedAt: NOW },
    });
    expect(prisma.booking.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(sendReminderMessage.mock.invocationCallOrder[0]);

    const [chatId, text, markup] = sendReminderMessage.mock.calls[0];
    expect(chatId).toBe('111');
    expect(text).toContain('Як пройшло заняття з тренером Олена &lt;Іван&gt;');
    expect(text).toContain('Оцінка необовʼязкова — її бачить лише клуб.');
    expect(markup.inline_keyboard[0].map((b: { text: string }) => b.text)).toEqual(['⭐1', '⭐2', '⭐3', '⭐4', '⭐5']);
    expect(markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data))
      .toEqual([1, 2, 3, 4, 5].map((n) => `tr:${n}:b:${BOOKING_ID}`));
    expect(markup.inline_keyboard[1]).toEqual([{ text: 'Не оцінювати', callback_data: `tr:0:b:${BOOKING_ID}` }]);
  });

  it('вибирає заняття, що скінчились за три години, без неявок і лише з Telegram', async () => {
    await runTrainerRatingTick(NOW);
    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      capacity: null, status: 'CONFIRMED', trainerId: { not: null }, rateAskedAt: null,
      attendance: { not: 'NO_SHOW' }, customer: { telegramChatId: { not: null } },
    });
    expect(where.endTime).toEqual({ gt: hoursAgo(3), lte: NOW });
    const seatWhere = prisma.bookingSeat.findMany.mock.calls[0][0].where;
    expect(seatWhere).toMatchObject({ status: 'BOOKED', rateAskedAt: null, customer: { telegramChatId: { not: null } } });
    expect(seatWhere.booking).toMatchObject({
      status: 'CONFIRMED', trainerId: { not: null }, attendance: { not: 'NO_SHOW' },
    });
    expect(seatWhere.booking.endTime).toEqual({ gt: hoursAgo(3), lte: NOW });
    expect(prisma.booking.findMany.mock.calls[0][0].take).toBe(100);
    expect(prisma.bookingSeat.findMany.mock.calls[0][0].take).toBe(100);
  });

  it('місце групи йде з kind s', async () => {
    prisma.bookingSeat.findMany.mockResolvedValue([{ id: SEAT_ID, booking: { club: { plan: 'max' } } }]);
    prisma.bookingSeat.findUnique.mockResolvedValue(seatRow());

    expect(await runTrainerRatingTick(NOW)).toBe(1);
    expect(prisma.bookingSeat.updateMany).toHaveBeenCalledWith({
      where: { id: SEAT_ID, rateAskedAt: null }, data: { rateAskedAt: NOW },
    });
    expect(JSON.stringify(sendReminderMessage.mock.calls[0][2])).toContain(`tr:5:s:${SEAT_ID}`);
  });

  it('не шле, якщо мітку вже забрав хтось інший', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: BOOKING_ID, club: { plan: 'max' } }]);
    prisma.booking.updateMany.mockResolvedValue({ count: 0 });

    expect(await runTrainerRatingTick(NOW)).toBe(0);
    expect(sendReminderMessage).not.toHaveBeenCalled();
    expect(prisma.booking.findUnique).not.toHaveBeenCalled();
  });

  it('не питає, якщо оцінка (або відмова) вже є', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: BOOKING_ID, club: { plan: 'max' } }]);
    prisma.booking.findUnique.mockResolvedValue(bookingRow());
    prisma.trainerRating.findUnique.mockResolvedValue({ id: 'r-1' });

    expect(await runTrainerRatingTick(NOW)).toBe(0);
    expect(sendReminderMessage).not.toHaveBeenCalled();
  });

  it('клуби без Telegram або без тренерів у плані пропускає навіть не чіпаючи мітку', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { id: 'a', club: { plan: 'no-tg' } },
      { id: 'b', club: { plan: 'no-trainers' } },
    ]);
    prisma.bookingSeat.findMany.mockResolvedValue([{ id: 'c', booking: { club: { plan: 'no-tg' } } }]);

    expect(await runTrainerRatingTick(NOW)).toBe(0);
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    expect(prisma.bookingSeat.updateMany).not.toHaveBeenCalled();
    expect(sendReminderMessage).not.toHaveBeenCalled();
  });

  it('якщо Telegram не прийняв повідомлення, мітку знімає — наступний тік спробує знову', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: BOOKING_ID, club: { plan: 'max' } }]);
    prisma.booking.findUnique.mockResolvedValue(bookingRow());
    sendReminderMessage.mockResolvedValue('retry');

    expect(await runTrainerRatingTick(NOW)).toBe(0);
    expect(prisma.booking.updateMany).toHaveBeenLastCalledWith({
      where: { id: BOOKING_ID, rateAskedAt: NOW }, data: { rateAskedAt: null },
    });
  });

  it('callback_data вміщається в 64 байти', () => {
    const kb = ratingAskKeyboard('s', SEAT_ID);
    for (const row of kb.inline_keyboard) {
      for (const button of row) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    }
  });

  it('текст містить час у таймзоні клубу', () => {
    const text = ratingAskText({
      kind: 'b', id: BOOKING_ID, bookingId: BOOKING_ID, seatId: null, clubId: 'club-1',
      timezone: 'Europe/Kyiv', trainerId: 't-1', trainerName: 'Олена', customerId: 'cust-1', chatId: '111',
      bookingStatus: 'CONFIRMED', seatStatus: null, attendance: 'UNKNOWN',
      start: new Date('2026-10-05T09:00:00.000Z'), end: new Date('2026-10-05T10:00:00.000Z'),
    }, NOW);
    expect(text).toContain('12:00–13:00');
  });
});

describe('кнопки оцінки', () => {
  const press = (data: string, chatId = 111) => ({
    id: 'cb', data, from: { id: chatId }, message: { message_id: 7, chat: { id: chatId } },
  });

  it('зберігає оцінку з source TELEGRAM й перемальовує повідомлення', async () => {
    prisma.booking.findUnique.mockResolvedValue(bookingRow({ trainer: { name: 'Олена' } }));

    expect(await bot.handlePlayerCallback(press(`tr:4:b:${BOOKING_ID}`))).toBe(true);

    expect(prisma.trainerRating.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.trainerRating.upsert.mock.calls[0][0];
    expect(call.create).toMatchObject({
      bookingId: BOOKING_ID, customerId: 'cust-1', trainerId: 't-1', clubId: 'club-1',
      score: 4, source: 'TELEGRAM',
    });
    expect(editMessageText).toHaveBeenCalledWith('111', 7, 'Дякуємо! Ваша оцінка тренеру Олена: ★★★★☆');
    expect(answerCallback).toHaveBeenCalledWith('cb', 'Дякуємо');
  });

  it('оцінка місця групи пишеться з seatId', async () => {
    prisma.bookingSeat.findUnique.mockResolvedValue(seatRow());
    await bot.handlePlayerCallback(press(`tr:5:s:${SEAT_ID}`));
    expect(prisma.trainerRating.upsert.mock.calls[0][0].create).toMatchObject({
      bookingId: BOOKING_ID, seatId: SEAT_ID, score: 5, source: 'TELEGRAM',
    });
    expect(editMessageText.mock.calls[0][2]).toContain('★★★★★');
  });

  it('«Не оцінювати» (0) зберігає score null', async () => {
    prisma.booking.findUnique.mockResolvedValue(bookingRow());

    await bot.handlePlayerCallback(press(`tr:0:b:${BOOKING_ID}`));

    expect(prisma.trainerRating.upsert.mock.calls[0][0].create).toMatchObject({ score: null, source: 'TELEGRAM' });
    expect(editMessageText).toHaveBeenCalledWith('111', 7, 'Добре, не будемо питати про це заняття.');
    expect(answerCallback).toHaveBeenCalledWith('cb', 'Готово');
  });

  it('чужий чат відхиляється й нічого не пише', async () => {
    prisma.booking.findUnique.mockResolvedValue(bookingRow());

    expect(await bot.handlePlayerCallback(press(`tr:5:b:${BOOKING_ID}`, 999))).toBe(true);

    expect(prisma.trainerRating.upsert).not.toHaveBeenCalled();
    expect(editMessageText).not.toHaveBeenCalled();
    expect(answerCallback).toHaveBeenCalledWith('cb', 'Цей запис вам недоступний');
  });

  it('неіснуюче заняття — те саме повідомлення', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);
    await bot.handlePlayerCallback(press(`tr:5:b:${BOOKING_ID}`));
    expect(prisma.trainerRating.upsert).not.toHaveBeenCalled();
    expect(answerCallback).toHaveBeenCalledWith('cb', 'Цей запис вам недоступний');
  });

  it('поза вікном семи днів оцінити вже не можна', async () => {
    prisma.booking.findUnique.mockResolvedValue(bookingRow({
      startTime: new Date(Date.now() - 9 * 86_400_000), endTime: new Date(Date.now() - 8 * 86_400_000),
    }));

    await bot.handlePlayerCallback(press(`tr:5:b:${BOOKING_ID}`));

    expect(prisma.trainerRating.upsert).not.toHaveBeenCalled();
    expect(editMessageText).toHaveBeenCalledWith('111', 7, 'Оцінити це заняття вже не можна.');
    expect(answerCallback).toHaveBeenCalled();
  });

  it('неявка — теж не можна', async () => {
    prisma.booking.findUnique.mockResolvedValue(bookingRow({ attendance: 'NO_SHOW' }));
    await bot.handlePlayerCallback(press(`tr:3:b:${BOOKING_ID}`));
    expect(prisma.trainerRating.upsert).not.toHaveBeenCalled();
    expect(editMessageText.mock.calls[0][2]).toBe('Оцінити це заняття вже не можна.');
  });

  it('зіпсовані дані ігноруються без звернення до бази', async () => {
    for (const data of [
      'tr:6:b:' + BOOKING_ID,
      'tr:5:x:' + BOOKING_ID,
      'tr:5:b:not-a-uuid',
      'tr:55:b:' + BOOKING_ID,
      'tr:5:b:' + BOOKING_ID + 'x',
      'tr:',
    ]) {
      expect(await bot.handlePlayerCallback(press(data))).toBe(false);
    }
    expect(prisma.booking.findUnique).not.toHaveBeenCalled();
    expect(prisma.bookingSeat.findUnique).not.toHaveBeenCalled();
    expect(prisma.trainerRating.upsert).not.toHaveBeenCalled();
  });
});
