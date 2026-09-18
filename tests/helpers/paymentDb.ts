import { vi } from 'vitest';
export function paymentDb(kind: 'booking' | 'seat') {
  const state: any = {
    payment: { id: 'pay', clubId: 'club', status: 'PENDING', amount: 25000, providerAt: null,
      bookingId: kind === 'booking' ? 'booking' : null, seatId: kind === 'seat' ? 'seat' : null },
    booking: { id: 'booking', status: 'CONFIRMED', capacity: kind === 'seat' ? 8 : null, priceTotal: 0 },
    seat: { id: 'seat', bookingId: 'booking', status: 'PENDING', price: 25000 }, taken: 0,
    rentals: [] as any[],
  };
  const tx = {
    $queryRaw: vi.fn(async () => []), $executeRawUnsafe: vi.fn(async () => 0),
    payment: {
      findUnique: vi.fn(async () => state.payment && structuredClone({ ...state.payment,
        seat: kind === 'seat' ? state.seat : null, booking: kind === 'booking' ? state.booking : null,
        club: { telegramChatId: '123' } })),
      update: vi.fn(async ({ data }) => Object.assign(state.payment, data)),
    },
    booking: {
      findUnique: vi.fn(async () => structuredClone(state.booking)),
      update: vi.fn(async ({ data }) => {
        if (data.status) state.booking.status = data.status;
        if (typeof data.rentalTotal === 'number') state.booking.rentalTotal = data.rentalTotal;
        if (data.priceTotal?.increment) state.booking.priceTotal += data.priceTotal.increment;
        if (data.priceTotal?.decrement) state.booking.priceTotal -= data.priceTotal.decrement;
        return state.booking;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.status !== state.booking.status) return { count: 0 };
        Object.assign(state.booking, data); return { count: 1 };
      }),
    },
    bookingRental: {
      // By bookingId — the booking's own lines; otherwise an occupancy query (nobody else holds anything).
      findMany: vi.fn(async ({ where }) => where.bookingId ? structuredClone(state.rentals) : []),
      deleteMany: vi.fn(async ({ where }) => { state.rentals = state.rentals.filter((r: any) => !where.id.in.includes(r.id)); }),
      update: vi.fn(async ({ where, data }) => Object.assign(state.rentals.find((r: any) => r.id === where.id), data)),
    },
    bookingSeat: {
      findUnique: vi.fn(async () => structuredClone(state.seat)),
      count: vi.fn(async () => state.taken),
      update: vi.fn(async ({ data }) => Object.assign(state.seat, data)),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.status !== state.seat.status) return { count: 0 };
        Object.assign(state.seat, data); return { count: 1 };
      }),
    },
  };
  let tail = Promise.resolve();
  // Serial execution models the database row lock; assertions also check FOR UPDATE.
  const prisma = { ...tx, $transaction: vi.fn((run: any) => {
    const next = tail.then(() => run(tx));
    tail = next.catch(() => {});
    return next;
  }) };
  return { state, tx, prisma };
}
