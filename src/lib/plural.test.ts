import { describe, it, expect } from 'vitest';
import { BOOKINGS, count, CUSTOMERS, plural } from './plural';

/**
 * «1 броней» — дрібниця, яку помічають усі, і саме вона робить бота
 * схожим на дамп таблиці замість повідомлення від свого клубу.
 */

describe('plural', () => {
  it('одна форма для 1, 21, 31', () => {
    for (const n of [1, 21, 31, 101]) expect(plural(n, BOOKINGS)).toBe('бронь');
  });

  it('друга форма для 2–4', () => {
    for (const n of [2, 3, 4, 22, 33]) expect(plural(n, BOOKINGS)).toBe('броні');
  });

  it('третя форма для 5–20 і нуля', () => {
    for (const n of [0, 5, 9, 10, 17, 20]) expect(plural(n, BOOKINGS)).toBe('броней');
  });

  it('11–14 — виняток, а не «одинадцять бронь»', () => {
    for (const n of [11, 12, 13, 14, 111, 112]) expect(plural(n, BOOKINGS)).toBe('броней');
  });

  it('відʼємні рахуються за модулем', () => {
    expect(plural(-1, BOOKINGS)).toBe('бронь');
  });
});

describe('count', () => {
  it('склеює число з формою', () => {
    expect(count(1, BOOKINGS)).toBe('1 бронь');
    expect(count(3, BOOKINGS)).toBe('3 броні');
    expect(count(8, BOOKINGS)).toBe('8 броней');
  });

  it('клієнти теж відмінюються', () => {
    expect(count(1, CUSTOMERS)).toBe('1 новий клієнт');
    expect(count(2, CUSTOMERS)).toBe('2 нові клієнти');
    expect(count(5, CUSTOMERS)).toBe('5 нових клієнтів');
  });
});
