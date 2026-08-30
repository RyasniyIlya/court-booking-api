import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Вебхук банку по оплаті ПРИВАТНОЇ броні корту.
 *
 * Дзеркало apply-seat.test.ts, якого досі не було: місця в групі покриті
 * детально, а бронь корту — найчастіший платіж узагалі — не була покрита
 * зовсім. Перевіряються рішення, які в бою побачити майже неможливо:
 *
 *  1. Гроші прийшли на слот, який устигли зайняти, поки вони йшли. Бронь
 *     не воскресає, оплата фіксується, клуб дізнається — і банк НЕ ганяє
 *     вебхук по колу.
 *  2. Порядок доставки не гарантований: «не вдалось» після «оплачено» не
 *     має гасити вже оплачену бронь.
 *  3. Недоплату не приймаємо: у нас 100% передоплата.
 */

const prisma = {
  payment: { findUnique: vi.fn(), update: vi.fn() },
  booking: { update: vi.fn() },
  bookingSeat: { updateMany: vi.fn() },
  $transaction: vi.fn(),
};

const notifyClub = vi.fn();
const isSlotTakenError = vi.fn(() => false);

vi.mock('../db', () => ({ prisma, notifyClub, isSlotTakenError }));

const { applyPayEvent } = await import('./apply');

const BOOKING_ID = 'booking-1';

const payment = (over: Record<string, unknown> = {}) => ({
  id: 'pay-1',
  providerRef: 'inv-1',
  amount: 45000,
  status: 'PENDING',
  providerAt: null,
  bookingId: BOOKING_ID,
  seatId: null,
  seat: null,
  booking: {
    id: BOOKING_ID,
    customerName: 'Петро',
    customerPhone: '+380671234567',
    capacity: null,
    title: null,
    status: 'PENDING',
    startTime: new Date('2026-09-01T16:00:00Z'),
  },
  club: { telegramChatId: 'chat-1', timezone: 'Europe/Kyiv' },
  ...over,
});

const paid = { providerRef: 'inv-1', status: 'paid' as const, amountKop: 45000 };

/** Дані, з якими пішов конкретний update. */
const updateArg = (m: { mock: { calls: unknown[][] } }, i = 0) =>
  (m.mock.calls[i]?.[0] as { data?: Record<string, unknown> } | undefined)?.data;

/**
 * Дані останнього update.
 *
 * Потрібен через те, як влаштований $transaction зі списком: аргументи
 * масиву — це вже побудовані PrismaPromise, тобто prisma.payment.update()
 * і prisma.booking.update() встигають викликатись ДО того, як транзакція
 * відхилиться. Тож у гілці «слот зайняли» перший виклик — той, що не
 * доїхав, а справжній запис іде другим.
 */
const lastUpdateArg = (m: { mock: { calls: unknown[][] } }) =>
  updateArg(m, m.mock.calls.length - 1);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  prisma.payment.findUnique.mockResolvedValue(payment());
  prisma.payment.update.mockReturnValue({});
  prisma.booking.update.mockReturnValue({});
  prisma.$transaction.mockResolvedValue([{}, {}]);
  isSlotTakenError.mockReturnValue(false);
});

describe('оплата броні пройшла', () => {
  it('бронь стає CONFIRMED і перестає протухати', async () => {
    expect(await applyPayEvent('mono', paid)).toBe('applied');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(updateArg(prisma.booking.update)).toEqual({
      status: 'CONFIRMED',
      expiresAt: null,
    });
  });

  it('платіж стає PAID без причини відмови', async () => {
    await applyPayEvent('mono', paid);

    expect(updateArg(prisma.payment.update)).toMatchObject({
      status: 'PAID',
      failReason: null,
    });
  });

  it('клуб дізнається про оплату', async () => {
    await applyPayEvent('mono', paid);

    expect(notifyClub).toHaveBeenCalledTimes(1);
    const [chat, text] = notifyClub.mock.calls[0] as unknown as [string, string];
    expect(chat).toBe('chat-1');
    expect(text).toContain('Оплачено');
    expect(text).toContain('Петро');
    expect(text).toContain('450.00 грн');
  });

  it('повтор по вже оплаченій броні нічого не змінює', async () => {
    prisma.payment.findUnique.mockResolvedValue(payment({ status: 'PAID' }));

    expect(await applyPayEvent('mono', paid)).toBe('already-final');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  /* Час банку старіший за вже збережений — подія приїхала не в тому
     порядку. Мовчки ігноруємо, а не відкочуємо стан назад. */
  it('подія, старіша за збережену, ігнорується', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      payment({ providerAt: new Date('2026-08-30T12:00:00Z') }),
    );

    const stale = { ...paid, at: new Date('2026-08-30T11:00:00Z') };
    expect(await applyPayEvent('mono', stale)).toBe('stale');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('недоплату не приймаємо — бронь не підтверджується', async () => {
    expect(await applyPayEvent('mono', { ...paid, amountKop: 44999 }))
      .toBe('amount-mismatch');

    expect(updateArg(prisma.payment.update)).toMatchObject({
      status: 'FAILED',
      failReason: 'AMOUNT_MISMATCH',
    });
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  it('невідомий рахунок — жодного запису', async () => {
    prisma.payment.findUnique.mockResolvedValue(null);

    expect(await applyPayEvent('mono', paid)).toBe('unknown-invoice');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });
});

/**
 * Гравець платить на останній хвилині холду, прибирання встигає першим і
 * повертає слот у сітку, слот займає інший — і аж тоді долітає «оплачено».
 * EXCLUDE-констрейнт не дасть повернути бронь у CONFIRMED.
 *
 * До появи цієї гілки виняток летів нагору, роут віддавав 500, банк
 * повторював вебхук по колу — а гроші були списані, броні не було, і в
 * логах лежав лише стек.
 */
describe('гроші прийшли, а слот уже зайнятий', () => {
  beforeEach(() => {
    isSlotTakenError.mockReturnValue(true);
    prisma.$transaction.mockRejectedValue(new Error('23P01'));
  });

  it('оплата фіксується з причиною SLOT_LOST', async () => {
    expect(await applyPayEvent('mono', paid)).toBe('applied');

    expect(lastUpdateArg(prisma.payment.update)).toMatchObject({
      status: 'PAID',
      failReason: 'SLOT_LOST',
    });
  });

  /* Один виклик — той, що пішов у відхилену транзакцію. Головне: після
     її падіння бронь НЕ переписують окремо, тобто CONFIRMED вона не
     отримує ніяк. Нуля тут бути не може, див. lastUpdateArg. */
  it('бронь не воскресає — окремого запису по ній немає', async () => {
    await applyPayEvent('mono', paid);

    expect(prisma.booking.update).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    await expect(prisma.$transaction.mock.results[0].value).rejects.toThrow();
  });

  it('клуб отримує попередження, а не звичайне «оплачено»', async () => {
    await applyPayEvent('mono', paid);

    const [, text] = notifyClub.mock.calls[0] as unknown as [string, string];
    expect(text).toContain('Оплата без броні');
    expect(text).toContain('Передзвоніть');
    expect(text).toContain('450.00 грн');
  });

  /* 'applied', а не помилка: подію обробили як змогли, і банку нема чого
     ганяти цей вебхук по колу. */
  it('банку віддається успіх, щоб він не повторював вічно', async () => {
    expect(await applyPayEvent('mono', paid)).toBe('applied');
  });

  /* Будь-яка інша помилка бази — не наш випадок: її треба прокинути, щоб
     роут віддав 500 і банк повторив. Проковтнути її означало б визнати
     платіж обробленим, коли він не обробився. */
  it('чужа помилка бази прокидається нагору', async () => {
    isSlotTakenError.mockReturnValue(false);
    prisma.$transaction.mockRejectedValue(new Error('база лягла'));

    await expect(applyPayEvent('mono', paid)).rejects.toThrow('база лягла');
  });
});

describe('оплата не пройшла', () => {
  it('відмова банку звільняє слот', async () => {
    const ev = { providerRef: 'inv-1', status: 'failed' as const, failReason: 'Недостатньо коштів' };

    expect(await applyPayEvent('mono', ev)).toBe('applied');

    expect(updateArg(prisma.payment.update)).toMatchObject({
      status: 'FAILED',
      failReason: 'Недостатньо коштів',
    });
    expect(updateArg(prisma.booking.update)).toEqual({
      status: 'EXPIRED',
      expiresAt: null,
    });
  });

  it('протермінований рахунок теж звільняє слот', async () => {
    const ev = { providerRef: 'inv-1', status: 'expired' as const };

    expect(await applyPayEvent('mono', ev)).toBe('applied');

    expect(updateArg(prisma.payment.update)).toMatchObject({ status: 'EXPIRED' });
    expect(updateArg(prisma.booking.update)).toMatchObject({ status: 'EXPIRED' });
  });

  /* Порядок доставки не гарантований. «Не вдалось», що приїхало після
     «оплачено», не має гасити вже оплачену бронь. */
  it('відмова після успіху не гасить оплачену бронь', async () => {
    prisma.payment.findUnique.mockResolvedValue(payment({ status: 'PAID' }));

    expect(await applyPayEvent('mono', { providerRef: 'inv-1', status: 'failed' }))
      .toBe('already-final');
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });
});

describe('повернення грошей', () => {
  it('оплачена бронь скасовується', async () => {
    prisma.payment.findUnique.mockResolvedValue(payment({ status: 'PAID' }));
    const at = new Date('2026-09-02T10:00:00Z');

    expect(await applyPayEvent('mono', { providerRef: 'inv-1', status: 'refunded', at }))
      .toBe('applied');

    expect(updateArg(prisma.payment.update)).toMatchObject({
      status: 'REFUNDED',
      refundedAt: at,
    });
    expect(updateArg(prisma.booking.update)).toMatchObject({
      status: 'CANCELLED',
      cancelledAt: at,
    });
  });

  it('повторне повернення нічого не чіпає', async () => {
    prisma.payment.findUnique.mockResolvedValue(payment({ status: 'REFUNDED' }));

    expect(await applyPayEvent('mono', { providerRef: 'inv-1', status: 'refunded' }))
      .toBe('already-final');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

/* Проміжні статуси банку («рахунок створено», «обробляється») не мають
   робити нічого, крім позначки часу: бронь у цей момент і так у PENDING. */
describe('проміжні статуси', () => {
  it('pending лише посуває providerAt і не чіпає бронь', async () => {
    const at = new Date('2026-08-30T10:00:00Z');

    expect(await applyPayEvent('mono', { providerRef: 'inv-1', status: 'pending', at }))
      .toBe('applied');

    expect(updateArg(prisma.payment.update)).toEqual({ providerAt: at });
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(notifyClub).not.toHaveBeenCalled();
  });
});
