import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Прибирання неоплачених місць у групових заняттях.
 *
 * Вебхук зазвичай приходить швидше. Ця задача — страховка на випадок, коли
 * гравець просто закрив вкладку і банк узагалі нічого не надішле: без неї
 * покинута оплата назавжди зʼїдала б стілець у групі.
 */

const prisma = {
  bookingSeat: { findMany: vi.fn(), updateMany: vi.fn() },
  payment: { updateMany: vi.fn() },
};

const cancelUnpaid = vi.fn(async () => {});

vi.mock('./db', () => ({ prisma }));
vi.mock('./payments', () => ({ providerFor: () => ({ name: 'mock', cancelUnpaid }) }));

const { sweepExpiredSeats } = await import('./expire');

const seat = (over: Record<string, unknown> = {}) => ({
  id: 'seat-1',
  payment: { id: 'pay-1', status: 'PENDING', providerRef: 'inv-1' },
  booking: { club: { paymentProvider: 'mock', paymentTokenEnc: null } },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.bookingSeat.findMany.mockResolvedValue([seat()]);
  prisma.bookingSeat.updateMany.mockResolvedValue({ count: 1 });
  prisma.payment.updateMany.mockResolvedValue({ count: 1 });
});

describe('sweepExpiredSeats', () => {
  it('протухле місце звільняється', async () => {
    expect(await sweepExpiredSeats()).toBe(1);
    expect(prisma.bookingSeat.updateMany).toHaveBeenCalledWith({
      where: { id: 'seat-1', status: 'PENDING' },
      data: { status: 'EXPIRED', expiresAt: null },
    });
  });

  /* Умова `status: 'PENDING'` в UPDATE, а не update по id: між вибіркою і
     записом може прилетіти вебхук «оплачено». Без неї ми писали б EXPIRED
     поверх щойно оплаченого місця — гравець заплатив, а стільця немає. */
  it('місце встигло оплатитись — платіж не чіпаємо', async () => {
    prisma.bookingSeat.updateMany.mockResolvedValue({ count: 0 });
    await sweepExpiredSeats();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it('рахунок у банку гаситься, щоб не висів у кабінеті клуба', async () => {
    await sweepExpiredSeats();
    expect(cancelUnpaid).toHaveBeenCalledWith('inv-1');
  });

  it('місце без оплати (платили на місці) прибирається без походу в банк', async () => {
    prisma.bookingSeat.findMany.mockResolvedValue([seat({ payment: null })]);
    await sweepExpiredSeats();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(cancelUnpaid).not.toHaveBeenCalled();
  });

  it('одне проблемне місце не зупиняє прибирання решти', async () => {
    prisma.bookingSeat.findMany.mockResolvedValue([
      seat({ id: 'bad' }), seat({ id: 'good' }),
    ]);
    prisma.bookingSeat.updateMany
      .mockRejectedValueOnce(new Error('база моргнула'))
      .mockResolvedValue({ count: 1 });

    expect(await sweepExpiredSeats()).toBe(2);
    expect(prisma.bookingSeat.updateMany).toHaveBeenCalledTimes(2);
  });

  it('нема чого прибирати — жодного запиту на запис', async () => {
    prisma.bookingSeat.findMany.mockResolvedValue([]);
    expect(await sweepExpiredSeats()).toBe(0);
    expect(prisma.bookingSeat.updateMany).not.toHaveBeenCalled();
  });

  /* Виручку прибирання не чіпає взагалі: неоплачене місце в priceTotal
     ніколи й не входило (див. lib/payments/apply.ts). */
  it('виручка заняття не змінюється', async () => {
    await sweepExpiredSeats();
    expect(prisma.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'EXPIRED', failReason: 'HOLD_TIMEOUT' },
    }));
  });
});
