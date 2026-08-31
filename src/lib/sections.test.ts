import { describe, it, expect } from 'vitest';
import { revenueText, staffText, type RevenueBreakdown, type StaffReport } from './sections';

/**
 * Два розділи поверх тих самих броней. Найважливіше тут — щоб їхні числа
 * не розходились із зведеннями: власник, який бачить за той самий тиждень
 * дві різні виручки, перестає вірити обом.
 */

const TZ = 'Europe/Kyiv';

describe('staffText', () => {
  const report: StaffReport = {
    rows: [
      { name: 'Марія', sessions: 8, revenue: 840_000 },
      { name: 'Іван', sessions: 12, revenue: 490_000 },
    ],
    sessions: 20,
    revenue: 1_330_000,
  };

  it('показує суму і кількість занять', () => {
    const out = staffText('Корт', report, 7, TZ);
    expect(out.replace(/\s/g, '')).toContain('13300грн');
    expect(out).toContain('20 занять');
  });

  it('графік упорядкований за грошима', () => {
    const chart = staffText('Корт', report, 7, TZ).split('<pre>')[1];
    expect(chart.indexOf('Марія')).toBeLessThan(chart.indexOf('Іван'));
  });

  it('найзавантаженіший названий окремо — це не завжди перший у графіку', () => {
    /* Іван провів більше занять, але дешевших. Прочитати це з першого
       стовпчика неможливо, тому рядок пишеться словами. */
    expect(staffText('Корт', report, 7, TZ)).toContain('Найбільше занять: Іван');
  });

  it('один тренер не отримує рядка про «найбільше» — порівнювати нема з ким', () => {
    const solo: StaffReport = { rows: [report.rows[0]], sessions: 8, revenue: 840_000 };
    expect(staffText('Корт', solo, 7, TZ)).not.toContain('Найбільше');
  });

  it('порожній період — речення, а не порожній графік', () => {
    const out = staffText('Корт', { rows: [], sessions: 0, revenue: 0 }, 7, TZ);
    expect(out).toContain('не було');
    expect(out).not.toContain('<pre>');
  });
});

describe('revenueText', () => {
  const r: RevenueBreakdown = {
    total: 1_000_000,
    bookings: 40,
    byCourt: [
      { name: 'Корт 1', revenue: 600_000 },
      { name: 'Корт 2', revenue: 400_000 },
    ],
    trainerPart: 250_000,
    group: { bookings: 4, revenue: 200_000 },
  };

  it('частки складаються в ціле', () => {
    /* Оренда рахується відніманням саме заради цього: два відсотки, що
       дають 97%, виглядають як помилка навіть коли числа праві. */
    const out = revenueText('Корт', r, 7, TZ);
    expect(out).toContain('75%');
    expect(out).toContain('25%');
  });

  it('групові показані тільки коли вони принесли гроші', () => {
    expect(revenueText('Корт', r, 7, TZ)).toContain('групові');

    const noGroup = { ...r, group: { bookings: 0, revenue: 0 } };
    expect(revenueText('Корт', noGroup, 7, TZ)).not.toContain('групові');
  });

  it('заняття без жодного запису не дає рядка «0 грн (0%)»', () => {
    /* Порожня група в розділі про гроші — шум: вона є, але грошей за нею
       немає, а нуль з відсотком читається як поломка. */
    const empty = { ...r, group: { bookings: 1, revenue: 0 } };
    expect(revenueText('Корт', empty, 7, TZ)).not.toContain('групові');
  });

  it('групові названі часткою, а не третім шматком поруч із орендою', () => {
    /* Оренда й тренери складаються в 100%, групові перетинаються з
       обома — «з них» це єдине, що не дає скласти всі три в купу. */
    expect(revenueText('Корт', r, 7, TZ)).toContain('З них групові');
  });

  it('без тренерів рядок про них зникає, а оренда лишається всім', () => {
    const noTrainers = { ...r, trainerPart: 0 };
    const out = revenueText('Корт', noTrainers, 7, TZ);
    expect(out).not.toContain('Робота тренерів');
    expect(out).toContain('100%');
  });

  it('нуль не ділиться на нуль', () => {
    const empty: RevenueBreakdown = {
      total: 0, bookings: 0, byCourt: [], trainerPart: 0, group: { bookings: 0, revenue: 0 },
    };
    const out = revenueText('Корт', empty, 7, TZ);
    expect(out).not.toContain('NaN');
    expect(out).toContain('не було');
  });

  it('період названий у шапці', () => {
    expect(revenueText('Корт', r, 28, TZ)).toContain('останні 4 тижні');
  });
});
