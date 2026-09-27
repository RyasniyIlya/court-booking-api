import { describe, expect, it } from 'vitest';
import {
  cashbookSheets,
  findDebts,
  groupDebtors,
  limitUsage,
  onlineRows,
  passRows,
  summarize,
  taxEstimate,
  type CashRow,
} from './cashbook';

const TZ = 'Europe/Kyiv';
const from = new Date('2026-05-01T00:00:00+03:00');
const to = new Date('2026-05-31T23:59:59.999+03:00');

const row = (p: Partial<CashRow>): CashRow => ({
  id: Math.random().toString(36),
  at: new Date('2026-05-10T12:00:00+03:00'),
  kind: 'PAYMENT',
  method: 'CASH',
  account: 'Каса',
  amount: 10000,
  source: 'BOOKING',
  customer: null,
  description: '',
  actor: null,
  ...p,
});

describe('summarize', () => {
  it('рахує гроші без бонусів, повернення віднімає', () => {
    const s = summarize([
      row({ amount: 50000 }),
      row({ method: 'CARD', account: 'Термінал', amount: 30000 }),
      row({ kind: 'REFUND', amount: 10000 }),
      row({ method: 'BONUS', amount: 20000 }),
    ], TZ, from, to);

    expect(s.received).toBe(80000);
    expect(s.refunded).toBe(10000);
    expect(s.net).toBe(70000);
    expect(s.bonusNet).toBe(20000);
    expect(s.byMethod.find((m) => m.method === 'CASH')).toMatchObject({ received: 50000, refunded: 10000, net: 40000 });
  });

  it('день береться в таймзоні клубу і порожні дні лишаються', () => {
    /* 23:30 за Києвом 1 травня — це ще 1 травня, хоч у UTC 20:30. */
    const s = summarize([row({ at: new Date('2026-05-01T23:30:00+03:00') })], TZ, from, to);
    expect(s.byDay).toHaveLength(31);
    expect(s.byDay[0]).toEqual({ date: '2026-05-01', net: 10000 });
    expect(s.byDay[1].net).toBe(0);
  });
});

describe('onlineRows', () => {
  const base = {
    amount: 40000, provider: 'mono', seatId: null, booking: null, seat: null,
  };

  it('повернена оплата дає надходження й повернення у свої дні', () => {
    const rows = onlineRows([{
      ...base, id: 'p1', status: 'REFUNDED',
      paidAt: new Date('2026-05-05T10:00:00Z'), refundedAt: new Date('2026-05-07T10:00:00Z'),
    }], from, to, TZ);
    expect(rows.map((r) => r.kind)).toEqual(['PAYMENT', 'REFUND']);
  });

  it('квітнева оплата, повернена в травні, у травні — лише повернення', () => {
    const rows = onlineRows([{
      ...base, id: 'p1', status: 'REFUNDED',
      paidAt: new Date('2026-04-28T10:00:00Z'), refundedAt: new Date('2026-05-02T10:00:00Z'),
    }], from, to, TZ);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('REFUND');
  });

  it('очікувана оплата грошей не дає', () => {
    expect(onlineRows([{ ...base, id: 'p1', status: 'PENDING', paidAt: null, refundedAt: null }], from, to, TZ)).toEqual([]);
  });
});

describe('passRows', () => {
  it('безкоштовний абонемент не є надходженням', () => {
    const rows = passRows([
      { id: 'a', createdAt: from, price: 0, type: 'PACKAGE', totalSessions: 8, customer: null },
      { id: 'b', createdAt: from, price: 240000, type: 'PACKAGE', totalSessions: 8, customer: { name: 'Оля' } },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: 'UNSPECIFIED', source: 'PASS', amount: 240000, description: '8 занять' });
  });
});

describe('податок і ліміт', () => {
  it('5% + 1% від чистого надходження, мінус не дає відʼємного податку', () => {
    expect(taxEstimate(1_000_000)).toEqual({ base: 1_000_000, singleTax: 50_000, military: 10_000, total: 60_000 });
    expect(taxEstimate(-500).total).toBe(0);
  });

  it('ліміт невідомого року не вигадується', () => {
    expect(limitUsage(100, 2031)).toBeNull();
    expect(limitUsage(100_910_490, 2026)?.pct).toBe(10);
  });
});

describe('боржники', () => {
  const item = {
    kind: 'BOOKING' as const, bookingId: 'b', startTime: from, customerName: 'Іван',
    customerPhone: '+380671234567', title: 'Корт 1',
  };

  it('недоплата — борг, повна оплата й переплата — ні', () => {
    const debts = findDebts([
      { ...item, id: '1', customerId: 'c1', price: 60000, ledger: [{ kind: 'PAYMENT', amount: 20000 }], onlinePaid: 0 },
      { ...item, id: '2', customerId: 'c2', price: 60000, ledger: [], onlinePaid: 60000 },
      { ...item, id: '3', customerId: 'c3', price: 60000, ledger: [{ kind: 'PAYMENT', amount: 70000 }], onlinePaid: 0 },
      { ...item, id: '4', customerId: 'c4', price: 60000, ledger: [
        { kind: 'PAYMENT', amount: 60000 }, { kind: 'REFUND', amount: 60000 },
      ], onlinePaid: 0 },
    ]);
    expect(debts.map((d) => [d.id, d.due])).toEqual([['4', 60000], ['1', 40000]]);
  });

  it('борги однієї людини згортаються в один рядок', () => {
    const grouped = groupDebtors(findDebts([
      { ...item, id: '1', customerId: 'c1', price: 30000, ledger: [], onlinePaid: 0 },
      { ...item, id: '2', customerId: 'c1', price: 20000, ledger: [], onlinePaid: 0 },
    ]));
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ due: 50000, name: 'Іван' });
    expect(grouped[0].items).toHaveLength(2);
  });
});

describe('cashbookSheets', () => {
  it('суми в гривнях зі знаком, бонус позначено як не дохід', () => {
    const rows = [row({ amount: 12345 }), row({ kind: 'REFUND', amount: 5000 }), row({ method: 'BONUS', amount: 100 })];
    const sheets = cashbookSheets(rows, summarize(rows, TZ, from, to), {
      clubName: 'Клуб', timezone: TZ, from, to, now: to,
    });
    expect(sheets.map((s) => s.name)).toEqual(['Реєстр', 'По днях', 'По касах']);
    const reg = sheets[0].rows;
    expect(reg.map((r) => r[4])).toEqual(expect.arrayContaining([123.45, -50, 1]));
    expect(reg.find((r) => r[2] === 'Бонуси')?.[5]).toBe('ні');
    expect(sheets[1].rows.at(-1)).toEqual(['Разом', 73.45]);
  });
});
