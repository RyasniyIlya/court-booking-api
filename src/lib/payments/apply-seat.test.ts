import { beforeEach, describe, it, expect, vi } from 'vitest';
import { paymentDb } from '../../../tests/helpers/paymentDb';
let db = paymentDb('seat');
const notifyClub = vi.fn(), notifyBooking = vi.fn(async () => {});
vi.mock('../db', () => ({ get prisma() { return db.prisma; }, notifyClub, isSlotTakenError: () => false }));
vi.mock('../notifyBooking', () => ({ notifyBooking }));
const { applyPayEvent } = await import('./apply');
const paid = { providerRef: 'invoice', status: 'paid' as const, amountKop: 25000 };
beforeEach(() => { vi.clearAllMocks(); db = paymentDb('seat'); });
describe('locked group seat payments', () => {
  it('books one seat and accounts for its price', async () => {
    await applyPayEvent('mono', paid);
    expect(db.state.seat.status).toBe('BOOKED'); expect(db.state.booking.priceTotal).toBe(25000);
    expect(db.state.payment.status).toBe('PAID');
    expect(db.tx.$queryRaw.mock.calls.map(c => c[0].join('')).every(s => s.includes('FOR UPDATE'))).toBe(true);
  });
  it('concurrent duplicate payments increase revenue once', async () => {
    await Promise.all([applyPayEvent('mono', paid), applyPayEvent('mono', paid)]);
    expect(db.state.booking.priceTotal).toBe(25000);
    expect(notifyBooking).toHaveBeenCalledOnce();
  });
  it('existing booked seat does not increase revenue again', async () => {
    db.state.seat.status = 'BOOKED'; await applyPayEvent('mono', paid);
    expect(db.state.booking.priceTotal).toBe(0); expect(db.state.payment.status).toBe('PAID');
  });
  it('does not accept underpayment', async () => {
    expect(await applyPayEvent('mono', { ...paid, amountKop: 1 })).toBe('amount-mismatch');
    expect(db.state.seat.status).toBe('PENDING');
  });
  it.each(['CANCELLED', 'EXPIRED'])('cancelled/expired group %s does not regain a seat', async status => {
    db.state.booking.status = status; await applyPayEvent('mono', paid);
    expect(db.state.payment.failReason).toBe('GROUP_CANCELLED'); expect(db.state.seat.status).toBe('PENDING');
  });
  it('cancelled seat stays cancelled after payment', async () => {
    db.state.seat.status = 'CANCELLED'; await applyPayEvent('mono', paid);
    expect(db.state.payment.failReason).toBe('SEAT_CANCELLED'); expect(notifyClub).toHaveBeenCalledOnce();
  });
  it('full group does not oversell an expired seat', async () => {
    db.state.seat.status = 'EXPIRED'; db.state.taken = 8; await applyPayEvent('mono', paid);
    expect(db.state.payment.failReason).toBe('GROUP_FULL'); expect(db.state.booking.priceTotal).toBe(0);
  });
  it('expired seat is restored if capacity remains', async () => {
    db.state.seat.status = 'EXPIRED'; db.state.taken = 7; await applyPayEvent('mono', paid);
    expect(db.state.seat.status).toBe('BOOKED');
  });
  it('checks capacity even for pending seats', async () => {
    db.state.taken = 8; await applyPayEvent('mono', paid);
    expect(db.state.payment.failReason).toBe('GROUP_FULL');
  });
  it.each(['failed', 'expired'] as const)('%s releases pending seat only', async status => {
    await applyPayEvent('mono', { ...paid, status }); expect(db.state.seat.status).toBe('EXPIRED');
  });
  it('late failure cannot erase paid seat', async () => {
    await Promise.all([applyPayEvent('mono', paid), applyPayEvent('mono', { ...paid, status: 'failed' })]);
    expect(db.state.seat.status).toBe('BOOKED'); expect(db.state.payment.status).toBe('PAID');
  });
  it('refund decreases revenue once', async () => {
    await applyPayEvent('mono', paid);
    await Promise.all([applyPayEvent('mono', { ...paid, status: 'refunded' }), applyPayEvent('mono', { ...paid, status: 'refunded' })]);
    expect(db.state.booking.priceTotal).toBe(0); expect(db.state.seat.status).toBe('CANCELLED');
  });
  it('refund of previously cancelled seat does not decrease revenue', async () => {
    db.state.seat.status = 'CANCELLED'; db.state.payment.status = 'PAID';
    await applyPayEvent('mono', { ...paid, status: 'refunded' });
    expect(db.tx.booking.update).not.toHaveBeenCalled();
  });
});
