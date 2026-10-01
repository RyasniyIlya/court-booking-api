import { describe, expect, it } from 'vitest';
import { dayRange, ledgerCsv, ledgerFileName, ledgerSummary, pageAfter, shiftPeriodTotals } from './cashdesk';

describe('dayRange', () => {
  it('межі доби — за таймзоною клубу, «to» включно', () => {
    const r = dayRange('2026-09-14', '2026-09-15', 'Europe/Kyiv')!;
    expect(r.start.toISOString()).toBe('2026-09-13T21:00:00.000Z');
    expect(r.endExclusive.toISOString()).toBe('2026-09-15T21:00:00.000Z');
    expect(r.days).toEqual(['2026-09-14', '2026-09-15']);
  });

  it('перехід на зимовий час: доба на 25 годин, але межа — рівно початок наступної', () => {
    /* 25 жовтня 2026 Київ переходить з UTC+3 на UTC+2. */
    const r = dayRange('2026-10-25', '2026-10-25', 'Europe/Kyiv')!;
    expect(r.start.toISOString()).toBe('2026-10-24T21:00:00.000Z');
    expect(r.endExclusive.toISOString()).toBe('2026-10-25T22:00:00.000Z');
  });

  it('інша таймзона дає інші межі', () => {
    expect(dayRange('2026-09-14', '2026-09-14', 'UTC')!.start.toISOString()).toBe('2026-09-14T00:00:00.000Z');
  });

  it('зіпсовані, перевернуті й задовгі діапазони — null', () => {
    expect(dayRange('2026-02-31', '2026-03-01', 'UTC')).toBeNull();
    expect(dayRange('2026-09-10', '2026-09-01', 'UTC')).toBeNull();
    expect(dayRange('abc', '2026-09-01', 'UTC')).toBeNull();
    expect(dayRange('2025-01-01', '2026-01-02', 'UTC')).toBeNull();
  });

  it('рівно 366 днів дозволено, 367 — ні', () => {
    expect(dayRange('2026-01-01', '2026-12-31', 'UTC')!.days).toHaveLength(365);
    expect(dayRange('2024-01-01', '2024-12-31', 'UTC')!.days).toHaveLength(366);
    expect(dayRange('2024-01-01', '2025-01-01', 'UTC')).toBeNull();
  });
});

const close = (id: string, patch: object = {}) => ({
  id, expectedCash: 100, countedCash: 100, expectedCard: 50, countedCard: 50,
  transferNet: 10, bonusNet: 5, entriesCount: 3, ...patch,
});

describe('shiftPeriodTotals', () => {
  it('пустий період — нулі', () => {
    expect(shiftPeriodTotals([])).toMatchObject({ shifts: 0, diffCash: 0, withDiff: 0 });
  });

  it('рахує суму розбіжностей і змін із розбіжністю', () => {
    const t = shiftPeriodTotals([
      close('a'), close('b', { countedCash: 70 }), close('c', { countedCard: 60 }), close('d', { countedCash: 130, countedCard: 40 }),
    ]);
    expect(t).toMatchObject({
      shifts: 4, expectedCash: 400, countedCash: 400, diffCash: 0, expectedCard: 200, countedCard: 200, diffCard: 0,
      transferNet: 40, bonusNet: 20, entries: 12, withDiff: 3,
    });
    expect(shiftPeriodTotals([close('a', { countedCash: 70 })]).diffCash).toBe(-30);
  });
});

describe('pageAfter', () => {
  const list = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));

  it('перша сторінка й курсор наступної', () => {
    expect(pageAfter(list, undefined, 2)).toEqual({ items: [{ id: 'a' }, { id: 'b' }], nextCursor: 'b' });
    expect(pageAfter(list, 'b', 2)).toEqual({ items: [{ id: 'c' }, { id: 'd' }], nextCursor: 'd' });
  });

  it('остання сторінка без курсора; невідомий курсор — null', () => {
    expect(pageAfter(list, 'd', 2)).toEqual({ items: [{ id: 'e' }], nextCursor: null });
    expect(pageAfter(list, 'd', 1)).toEqual({ items: [{ id: 'e' }], nextCursor: null });
    expect(pageAfter(list, 'zzz', 2)).toBeNull();
  });
});

describe('ledgerSummary', () => {
  const e = (kind: string, method: string, amount: number, iso: string, actorEmail = 'a@x.ua') => ({
    kind, method, amount, account: method === 'CASH' ? 'Каса' : 'Термінал', actorEmail, actorRole: 'ADMIN', createdAt: new Date(iso),
  });

  it('повернення віднімається, бонуси не входять у «net» дня й співробітника', () => {
    const s = ledgerSummary([
      e('PAYMENT', 'CASH', 1000, '2026-09-14T10:00:00Z'),
      e('REFUND', 'CASH', 300, '2026-09-14T11:00:00Z'),
      e('PAYMENT', 'BONUS', 500, '2026-09-14T12:00:00Z', 'b@x.ua'),
    ], 'UTC', ['2026-09-14', '2026-09-15']);

    expect(s.totals).toEqual({ cash: 700, card: 0, transfer: 0, bonus: 500 });
    expect(s.byDay).toEqual([
      { date: '2026-09-14', cash: 700, card: 0, transfer: 0, bonus: 500, net: 700 },
      { date: '2026-09-15', cash: 0, card: 0, transfer: 0, bonus: 0, net: 0 },
    ]);
    expect(s.byMethod.find((m) => m.method === 'CASH')).toEqual({ method: 'CASH', in: 1000, out: 300, net: 700, count: 2 });
    expect(s.byActor[0]).toMatchObject({ actorEmail: 'a@x.ua', count: 2, net: 700 });
    expect(s.byActor[1]).toMatchObject({ actorEmail: 'b@x.ua', count: 1, net: 0 });
  });
});

describe('ledgerCsv', () => {
  const base = {
    kind: 'PAYMENT', method: 'CASH', amount: 125050, account: 'Каса', note: '=HYPERLINK("x")', actorEmail: 'o@x.ua', actorRole: 'OWNER',
    createdAt: new Date('2026-09-14T15:30:00Z'), booking: null, seat: null, customer: null,
  };

  it('BOM першим символом, заголовок, формульна нотатка екранована', () => {
    const csv = ledgerCsv([base], 'Europe/Kyiv');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const [head, line] = csv.slice(1).split('\r\n');
    expect(head.split(';')).toHaveLength(11);
    expect(line).toBe('14.09.2026;18:30;Оплата;Готівка;Каса;"1250,50";;;"\'=HYPERLINK(""x"")";o@x.ua;Власник');
  });

  it('порожній журнал — лише заголовок', () => {
    expect(ledgerCsv([], 'UTC').slice(1).split('\r\n')).toHaveLength(1);
  });
});

describe('ledgerFileName', () => {
  it('клуб і період', () => {
    expect(ledgerFileName('Падел Хаб', '2026-09-01', '2026-09-30')).toBe('каса-Падел-Хаб-2026-09-01-2026-09-30.csv');
  });
});
