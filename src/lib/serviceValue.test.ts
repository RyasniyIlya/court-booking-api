import { describe, expect, it, vi } from 'vitest';
import { courtValueOf, loadPassSessionValues, passSessionValue } from './serviceValue';

describe('courtValueOf', () => {
  it('еталон: Наталка — корт 50 000 + тренер 30 000 → виручка корту 50 000', () => {
    expect(courtValueOf({ priceTotal: 80_000, trainerPrice: 30_000, rentalTotal: 0 })).toBe(50_000);
  });

  it('еталон: Богдан — корт 40 000 + прокат 10 000 → 40 000', () => {
    expect(courtValueOf({ priceTotal: 50_000, rentalTotal: 10_000, trainerPrice: 0 })).toBe(40_000);
  });

  it('тренер + прокат + знижка 10%: знижка діє на корт і тренера, не на прокат', () => {
    // (50 000 + 30 000) * 0.9 = 72 000, + прокат 10 000 = 82 000
    const b = { priceTotal: 82_000, trainerPrice: 30_000, rentalTotal: 10_000, discountPercent: 10 };
    // тренер після знижки 27 000 → корт 45 000
    expect(courtValueOf(b)).toBe(45_000);
  });

  it('заняття з абонемента: pass.price / totalSessions, а не ціна корту', () => {
    const v = passSessionValue({ type: 'PACKAGE', price: 320_000, totalSessions: 8 });
    expect(v).toBe(40_000);
    expect(courtValueOf({ priceTotal: 50_000 }, v)).toBe(40_000);
  });

  it('UNLIMITED або totalSessions=0 — не абонементна вартість', () => {
    expect(passSessionValue({ type: 'UNLIMITED', price: 100_000, totalSessions: null })).toBeNull();
    expect(passSessionValue({ type: 'PACKAGE', price: 100_000, totalSessions: 0 })).toBeNull();
  });

  it('округлює копійки: 100 000 / 3', () => {
    expect(passSessionValue({ type: 'PACKAGE', price: 100_000, totalSessions: 3 })).toBe(33_333);
  });

  it('груповий контейнер лишається як є', () => {
    expect(courtValueOf({ priceTotal: 24_000, capacity: 8, trainerPrice: 24_000 })).toBe(24_000);
  });

  it('відсутні поля (історичні рядки) — безпечно priceTotal', () => {
    expect(courtValueOf({ priceTotal: 50_000 })).toBe(50_000);
    expect(courtValueOf({ priceTotal: 50_000, rentalTotal: null, trainerPrice: null })).toBe(50_000);
  });

  it('суперечливі дані не дають мінуса', () => {
    expect(courtValueOf({ priceTotal: 10_000, trainerPrice: 30_000 })).toBe(0);
  });
});

describe('loadPassSessionValues', () => {
  it('мапить bookingId → вартість заняття, пропускає UNLIMITED і ручні списання', async () => {
    const findMany = vi.fn(async () => [
      { bookingId: 'b1', pass: { type: 'PACKAGE', price: 320_000, totalSessions: 8 } },
      { bookingId: 'b2', pass: { type: 'UNLIMITED', price: 500_000, totalSessions: null } },
      { bookingId: null, pass: { type: 'PACKAGE', price: 320_000, totalSessions: 8 } },
    ]);
    const map = await loadPassSessionValues({ passUsage: { findMany } } as never, ['b1', 'b2', 'b1']);
    expect(map.get('b1')).toBe(40_000);
    expect(map.has('b2')).toBe(false);
    expect(map.size).toBe(1);
  });

  it('без id не ходить у базу', async () => {
    const findMany = vi.fn();
    await loadPassSessionValues({ passUsage: { findMany } } as never, []);
    expect(findMany).not.toHaveBeenCalled();
  });
});
