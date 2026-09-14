import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { needsNote, shiftByAccount, shiftStart, shiftText, shiftTotals } from './shift';

const e = (kind: string, method: string, amount: number, account = 'Каса') => ({ kind, method, amount, account });

describe('shiftTotals', () => {
  it('рахує оплати мінус повернення окремо по способах', () => {
    const t = shiftTotals([
      e('PAYMENT', 'CASH', 50000),
      e('PAYMENT', 'CASH', 30000),
      e('REFUND', 'CASH', 10000),
      e('PAYMENT', 'CARD', 70000, 'Термінал'),
      e('PAYMENT', 'BONUS', 5000, 'Бонусний баланс'),
    ]);
    expect(t).toEqual({ cash: 70000, card: 70000, transfer: 0, bonus: 5000 });
  });

  it('невідомий спосіб не ламає суму', () => {
    expect(shiftTotals([e('PAYMENT', 'BITCOIN', 1)])).toEqual({ cash: 0, card: 0, transfer: 0, bonus: 0 });
  });
});

describe('shiftByAccount', () => {
  it('групує по касі й способу', () => {
    const rows = shiftByAccount([
      e('PAYMENT', 'CASH', 100, 'Каса 1'),
      e('PAYMENT', 'CASH', 200, 'Каса 1'),
      e('PAYMENT', 'CASH', 50, 'Каса 2'),
    ]);
    expect(rows).toEqual([
      { account: 'Каса 1', method: 'CASH', net: 300, count: 2 },
      { account: 'Каса 2', method: 'CASH', net: 50, count: 1 },
    ]);
  });
});

describe('shiftStart', () => {
  it('після першого закриття рахує від нього', () => {
    const last = new Date('2026-09-13T21:30:00Z');
    expect(shiftStart(last, 'Europe/Kyiv')).toBe(last);
  });

  it('до першого закриття — від початку дня в зоні клубу, а не сервера', () => {
    const now = DateTime.fromISO('2026-09-14T01:30:00Z'); // 04:30 у Києві
    expect(shiftStart(null, 'Europe/Kyiv', now).toISOString()).toBe('2026-09-13T21:00:00.000Z');
  });
});

describe('needsNote', () => {
  it('без розбіжності коментар не потрібен', () => {
    expect(needsNote(0, 0, '')).toBe(false);
  });
  it('розбіжність без пояснення не приймаємо', () => {
    expect(needsNote(-5000, 0, '')).toBe(true);
    expect(needsNote(0, 100, 'ок')).toBe(true);
    expect(needsNote(0, 100, 'здача з 500')).toBe(false);
  });
});

describe('shiftText', () => {
  const base = {
    openedAt: new Date('2026-09-14T06:00:00Z'),
    closedAt: new Date('2026-09-14T19:00:00Z'),
    expectedCash: 120000, countedCash: 120000,
    expectedCard: 80000, countedCard: 80000,
    transferNet: 0, bonusNet: 0, entriesCount: 9,
    note: '', actorName: 'Оля', actorEmail: 'olya@club.ua',
  };

  it('каса зійшлась — галочки й без рядка розбіжності', () => {
    const text = shiftText('Падел Хаб', base, 'Europe/Kyiv');
    expect(text).toContain('✅');
    expect(text).toContain('Оля');
    expect(text).not.toContain('Розбіжність');
  });

  it('недостача видна одразу і з поясненням', () => {
    const text = shiftText('Падел Хаб', { ...base, countedCash: 115000, note: 'Здача <500>' }, 'Europe/Kyiv');
    expect(text).toContain('⚠️');
    expect(text).toContain('Розбіжність');
    expect(text).toContain('−50');
    expect(text).toContain('Здача &lt;500&gt;');
  });
});
