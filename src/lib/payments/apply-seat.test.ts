import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Вебхук банку по оплаті МІСЦЯ в груповому занятті.
 *
 * Тут перевіряється не «чи ходить запит», а три рішення, які в бою побачити
 * майже неможливо, а коштують вони грошей клуба й довіри гравця:
 *
 *  1. Гроші прийшли, а місця вже немає (холд протух, останній стілець пішов
 *     іншому). Автоматичного повернення ми не робимо — гроші на рахунку
 *     клубу, — але мовчати теж не можна.
 *  2. Виручка заняття росте рівно один раз і рівно тоді, коли заплатили.
 *  3. Порядок доставки не гарантований: «не вдалось» після «оплачено» не
 *     має гасити вже оплачене місце.
 */

const tx = {
  $queryRaw: vi.fn(),
  bookingSeat: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  booking: { update: vi.fn() },
  payment: { update: vi.fn() },
};

const prisma = {
  payment: { findUnique: vi.fn(), update: vi.fn() },
  booking: { update: vi.fn() },
  bookingSeat: { updateMany: vi.fn() },
  $transaction: vi.fn(),
};

const notifyClub = vi.fn();

vi.mock('../db', () => ({
  prisma,
  notifyClub,
  isSlotTakenError: () => false,
}));

const { applyPayEvent } = await import('./apply');

const GROUP_ID = 'group-1';
const SEAT_ID = 'seat-1';

const payment = (over: Record<string, unknown> = {}) => ({
  id: 'pay-1',
  providerRef: 'inv-1',
  amount: 25000,
  status: 'PENDING',
  providerAt: null,
  bookingId: null,
  seatId: SEAT_ID,
  booking: null,
  seat: {
    id: SEAT_ID,
    price: 25000,
    customerName: 'Оксана',
    customerPhone: '+380671234567',
    status: 'PENDING',
    booking: {
      id: GROUP_ID,
      title: 'Ранкова йога',
      capacity: 8,
      startTime: new Date('2026-09-01T07:00:00Z'),
    },
  },
  club: { telegramChatId: 'chat-1', timezone: 'Europe/Kyiv' },
  ...over,
});

const paid = { providerRef: 'inv-1', status: 'paid' as const, amountKop: 25000 };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.payment.findUnique.mockResolvedValue(payment());
  prisma.payment.update.mockResolvedValue({});
  prisma.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (t: typeof tx) => unknown)(tx) : arg);
  tx.$queryRaw.mockResolvedValue([{ capacity: 8, status: 'CONFIRMED' }]);
  tx.bookingSeat.findUnique.mockResolvedValue({ status: 'PENDING', price: 25000 });
  tx.bookingSeat.update.mockResolvedValue({});
  tx.bookingSeat.count.mockResolvedValue(0);
  tx.booking.update.mockResolvedValue({});
  tx.payment.update.mockResolvedValue({});
});

describe('оплата місця пройшла', () => {
  it('місце стає BOOKED і перестає протухати', async () => {
    expect(await applyPayEvent('mock', paid)).toBe('applied');
    expect(tx.bookingSeat.update).toHaveBeenCalledWith({
      where: { id: SEAT_ID },
      data: { status: 'BOOKED', expiresAt: null },
    });
  });

  /* Виручка росте саме тут, а не при записі: покинутий кошик не має
     підіймати підсумок дня на чверть години. */
  it('виручка заняття росте на ціну місця', async () => {
    await applyPayEvent('mock', paid);
    expect(tx.booking.update).toHaveBeenCalledWith({
      where: { id: GROUP_ID },
      data: { priceTotal: { increment: 25000 } },
    });
  });

  it('платіж стає PAID без причини відмови', async () => {
    await applyPayEvent('mock', paid);
    expect(prisma.payment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PAID', failReason: null }),
    }));
  });

  it('місткість рахується під FOR UPDATE — інакше двоє купили б один стілець', async () => {
    await applyPayEvent('mock', paid);
    const sql = tx.$queryRaw.mock.calls[0][0] as { strings?: string[] } | string[];
    const text = Array.isArray(sql) ? sql.join('') : (sql.strings ?? []).join('');
    expect(text).toContain('FOR UPDATE');
  });

  /* Повтор вебхука — звичайна справа: банк робить до трьох спроб. Друга
     обробка не має додати виручку ще раз. */
  it('повтор по вже проведеному місцю нічого не змінює', async () => {
    tx.bookingSeat.findUnique.mockResolvedValue({ status: 'BOOKED', price: 25000 });
    expect(await applyPayEvent('mock', paid)).toBe('applied');
    expect(tx.bookingSeat.update).not.toHaveBeenCalled();
    expect(tx.booking.update).not.toHaveBeenCalled();
  });

  it('недоплату не приймаємо — місце лишається неоплаченим', async () => {
    const res = await applyPayEvent('mock', { ...paid, amountKop: 100 });
    expect(res).toBe('amount-mismatch');
    expect(tx.bookingSeat.update).not.toHaveBeenCalled();
  });
});

describe('гроші прийшли, а місця вже немає', () => {
  /* Головний сценарій цього файлу. Гравець платив на останній хвилині
     холду, прибирання встигло першим, останній стілець пішов іншому. */
  it('холд протух і група заповнилась — місце НЕ повертаємо, клуб сповіщаємо', async () => {
    tx.bookingSeat.findUnique.mockResolvedValue({ status: 'EXPIRED', price: 25000 });
    tx.bookingSeat.count.mockResolvedValue(8);

    expect(await applyPayEvent('mock', paid)).toBe('applied');

    expect(tx.bookingSeat.update).not.toHaveBeenCalled();
    expect(tx.booking.update).not.toHaveBeenCalled();
    expect(prisma.payment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PAID', failReason: 'GROUP_FULL' }),
    }));
    expect(notifyClub).toHaveBeenCalledWith('chat-1', expect.stringContaining('Оплата без місця'));
  });

  /* А от якщо холд протух, але місце ще вільне — гроші прийшли, місце є,
     повертати гравцю нічого не треба. */
  it('холд протух, але місце вільне — місце повертається гравцю', async () => {
    tx.bookingSeat.findUnique.mockResolvedValue({ status: 'EXPIRED', price: 25000 });
    tx.bookingSeat.count.mockResolvedValue(3);

    await applyPayEvent('mock', paid);
    expect(tx.bookingSeat.update).toHaveBeenCalled();
    expect(notifyClub).toHaveBeenCalledWith('chat-1', expect.stringContaining('Оплачено місце'));
  });

  it('гравець устиг зняти запис сам — клуб дізнається про це', async () => {
    tx.bookingSeat.findUnique.mockResolvedValue({ status: 'CANCELLED', price: 25000 });

    await applyPayEvent('mock', paid);
    expect(prisma.payment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ failReason: 'SEAT_CANCELLED' }),
    }));
    expect(notifyClub).toHaveBeenCalledWith('chat-1', expect.stringContaining('Оплата без місця'));
  });

  it('клуб скасував саме заняття — теж сповіщення, а не тиха оплата', async () => {
    tx.$queryRaw.mockResolvedValue([{ capacity: 8, status: 'CANCELLED' }]);

    await applyPayEvent('mock', paid);
    expect(prisma.payment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ failReason: 'GROUP_CANCELLED' }),
    }));
  });

  /* PENDING усе ще тримає місткість, тому перераховувати її не треба —
     і, головне, не можна: перерахунок міг би відхилити власне ж місце. */
  it('місце ще в PENDING — місткість не перераховується', async () => {
    await applyPayEvent('mock', paid);
    expect(tx.bookingSeat.count).not.toHaveBeenCalled();
  });
});

describe('оплата не пройшла', () => {
  it('відмова банку звільняє місце', async () => {
    prisma.bookingSeat.updateMany.mockReturnValue({});
    await applyPayEvent('mock', { providerRef: 'inv-1', status: 'failed' });

    expect(prisma.bookingSeat.updateMany).toHaveBeenCalledWith({
      where: { id: SEAT_ID, status: 'PENDING' },
      data: { status: 'EXPIRED', expiresAt: null },
    });
  });

  /* Умова `status: 'PENDING'` у where — не прикраса: порядок доставки
     вебхуків не гарантований, і «не вдалось» може прилетіти після
     «оплачено». Затирати оплачене місце протухлим ми не маємо права. */
  it('відмова після успіху не гасить уже оплачене місце', async () => {
    prisma.bookingSeat.updateMany.mockReturnValue({});
    await applyPayEvent('mock', { providerRef: 'inv-1', status: 'expired' });

    const { where } = prisma.bookingSeat.updateMany.mock.calls[0][0];
    expect(where.status).toBe('PENDING');
  });
});

describe('повернення грошей', () => {
  it('оплачене місце знімається, виручка зменшується', async () => {
    prisma.payment.findUnique.mockResolvedValue(payment({ status: 'PAID' }));
    tx.bookingSeat.updateMany.mockResolvedValue({ count: 1 });

    await applyPayEvent('mock', { providerRef: 'inv-1', status: 'refunded' });

    expect(tx.booking.update).toHaveBeenCalledWith({
      where: { id: GROUP_ID },
      data: { priceTotal: { decrement: 25000 } },
    });
  });

  /* Місце вже було знято раніше — виручку воно з собою забрало тоді ж.
     Другий decrement загнав би підсумок дня в мінус. */
  it('місце вже було зняте — виручка не зменшується вдруге', async () => {
    prisma.payment.findUnique.mockResolvedValue(payment({ status: 'PAID' }));
    tx.bookingSeat.updateMany.mockResolvedValue({ count: 0 });

    await applyPayEvent('mock', { providerRef: 'inv-1', status: 'refunded' });
    expect(tx.booking.update).not.toHaveBeenCalled();
  });
});
