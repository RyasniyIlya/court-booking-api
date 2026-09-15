import { beforeEach, describe, it, expect, vi } from 'vitest';
import { paymentDb } from '../../../tests/helpers/paymentDb';
let db = paymentDb('booking');
const notifyClub = vi.fn();
const notifyBooking = vi.fn(async () => {});
vi.mock('../db', () => ({ get prisma() { return db.prisma; }, notifyClub, isSlotTakenError: (e: Error) => e.message.includes('23P01') }));
vi.mock('../notifyBooking', () => ({ notifyBooking }));
const { applyPayEvent } = await import('./apply');
const paid = { providerRef: 'invoice', status: 'paid' as const, amountKop: 25000 };
beforeEach(() => { vi.clearAllMocks(); db = paymentDb('booking'); db.state.booking.status = 'PENDING'; });
describe('locked private payment transitions', () => {
  it('confirms payment and booking together, notifying after the transaction', async () => {
    expect(await applyPayEvent('mono', paid, 'club')).toBe('applied');
    expect(db.state.payment.status).toBe('PAID');
    expect(db.state.booking.status).toBe('CONFIRMED');
    expect(notifyBooking).toHaveBeenCalledWith({ bookingId: 'booking', event: 'paid' });
    expect(db.tx.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
  });
  it('does not revive a cancelled booking after late payment', async () => {
    db.state.booking.status = 'CANCELLED';
    await applyPayEvent('mono', paid);
    expect(db.state.booking.status).toBe('CANCELLED');
    expect(db.state.payment).toMatchObject({ status: 'PAID', failReason: 'BOOKING_CANCELLED' });
    expect(notifyBooking).not.toHaveBeenCalled(); expect(notifyClub).toHaveBeenCalledOnce();
  });
  it('handles concurrent success and failure without erasing payment', async () => {
    await Promise.all([applyPayEvent('mono', paid), applyPayEvent('mono', { ...paid, status: 'failed' })]);
    expect(db.state.payment.status).toBe('PAID'); expect(db.state.booking.status).toBe('CONFIRMED');
  });
  it('applies concurrent paid duplicates once', async () => {
    await Promise.all([applyPayEvent('mono', paid), applyPayEvent('mono', paid)]);
    expect(db.tx.payment.update).toHaveBeenCalledOnce(); expect(notifyBooking).toHaveBeenCalledOnce();
  });
  it('rejects a different tenant and an unknown invoice', async () => {
    expect(await applyPayEvent('mono', paid, 'other')).toBe('unknown-invoice');
    db.state.payment = null; expect(await applyPayEvent('mono', paid)).toBe('unknown-invoice');
    expect(db.tx.booking.update).not.toHaveBeenCalled();
  });
  it('ignores stale events', async () => {
    db.state.payment.providerAt = new Date('2026-09-15');
    expect(await applyPayEvent('mono', { ...paid, at: new Date('2026-09-14') })).toBe('stale');
    expect(db.tx.payment.update).not.toHaveBeenCalled();
  });
  it('rejects underpayment without confirming the slot', async () => {
    expect(await applyPayEvent('mono', { ...paid, amountKop: 1 })).toBe('amount-mismatch');
    expect(db.state.booking.status).toBe('PENDING');
  });
  it.each(['failed', 'expired'] as const)('%s releases only a pending slot', async status => {
    await applyPayEvent('mono', { ...paid, status });
    expect(db.state.booking.status).toBe('EXPIRED');
  });
  it('a failed event cannot overwrite a cancelled booking', async () => {
    db.state.booking.status = 'CANCELLED'; await applyPayEvent('mono', { ...paid, status: 'failed' });
    expect(db.state.booking.status).toBe('CANCELLED');
  });
  it('a paid event after a refund is ignored', async () => {
    db.state.payment.status = 'REFUNDED';
    expect(await applyPayEvent('mono', paid)).toBe('already-final');
  });
  it('refund cancels the booking and is idempotent', async () => {
    db.state.payment.status = 'PAID';
    await applyPayEvent('mono', { ...paid, status: 'refunded' });
    expect(db.state.booking.status).toBe('CANCELLED');
    expect(await applyPayEvent('mono', { ...paid, status: 'refunded' })).toBe('already-final');
  });
  it('records money when court or trainer constraint prevents confirmation', async () => {
    db.state.booking.status = 'EXPIRED';
    db.tx.booking.update.mockRejectedValueOnce(new Error('23P01'));
    await applyPayEvent('mono', paid);
    expect(db.state.payment).toMatchObject({ status: 'PAID', failReason: 'SLOT_LOST' });
    expect(db.state.booking.status).toBe('EXPIRED');
    expect(db.tx.$executeRawUnsafe).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT payment_confirmation');
    expect(notifyClub).toHaveBeenCalledOnce();
  });
  it('propagates infrastructure failures for provider retry', async () => {
    db.tx.booking.update.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(applyPayEvent('mono', paid)).rejects.toThrow('database unavailable');
    expect(notifyBooking).not.toHaveBeenCalled();
  });
  it('pending event changes only provider timestamp', async () => {
    await applyPayEvent('mono', { ...paid, status: 'pending' });
    expect(db.state.payment.status).toBe('PENDING');
    expect(db.tx.booking.update).not.toHaveBeenCalled();
  });
});
