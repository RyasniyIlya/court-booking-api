import { describe, it, expect } from 'vitest';

import { clubBilling, extendPaidUntil, GRACE_DAYS } from './billing';

const NOW = new Date('2026-09-02T10:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('clubBilling', () => {
  it('без оплати і без пробного — усе працює', () => {
    const b = clubBilling({}, NOW);
    expect(b.state).toBe('ok');
    expect(b.online).toBe(true);
    expect(b.until).toBe(null);
    expect(b.daysLeft).toBe(null);
  });

  it('оплачено надовго — ok', () => {
    const b = clubBilling({ paidUntil: day('2026-12-31') }, NOW);
    expect(b.state).toBe('ok');
    expect(b.trial).toBe(false);
    expect(b.until).toEqual(day('2026-12-31'));
  });

  it('до кінця менше двох тижнів — due, запис ще працює', () => {
    const b = clubBilling({ paidUntil: day('2026-09-10') }, NOW);
    expect(b.state).toBe('due');
    expect(b.online).toBe(true);
    expect(b.daysLeft).toBe(8);
  });

  it('прострочено в межах пільги — grace, запис працює', () => {
    const b = clubBilling({ paidUntil: day('2026-08-30') }, NOW);
    expect(b.state).toBe('grace');
    expect(b.online).toBe(true);
    expect(b.graceLeft).toBe(GRACE_DAYS - 3);
  });

  it('пільга скінчилась — онлайн-запис вимкнено', () => {
    const b = clubBilling({ paidUntil: day('2026-08-01') }, NOW);
    expect(b.state).toBe('blocked');
    expect(b.online).toBe(false);
    expect(b.graceLeft).toBe(0);
  });

  it('вимкнений вручну — blocked, що б там не було оплачено', () => {
    const b = clubBilling({ paidUntil: day('2027-01-01'), isActive: false }, NOW);
    expect(b.state).toBe('blocked');
    expect(b.online).toBe(false);
  });

  /* Саме через це все й переписувалось: до цієї зміни trialEndsAt не читав
     ніхто, і кнопка «+14 днів пробного» нічого не вмикала. */
  describe('пробний період', () => {
    it('діючий пробний тримає доступ і підписується як пробний', () => {
      const b = clubBilling({ trialEndsAt: day('2026-09-16') }, NOW);
      expect(b.trial).toBe(true);
      expect(b.until).toEqual(day('2026-09-16'));
      expect(b.daysLeft).toBe(14);
      expect(b.online).toBe(true);
    });

    it('пробний закінчився давно — запис вимикається', () => {
      const b = clubBilling({ trialEndsAt: day('2026-08-01') }, NOW);
      expect(b.state).toBe('blocked');
      expect(b.online).toBe(false);
    });

    it('пробний щойно скінчився — тиждень пільги, як і в оплати', () => {
      const b = clubBilling({ trialEndsAt: day('2026-08-30') }, NOW);
      expect(b.state).toBe('grace');
      expect(b.online).toBe(true);
    });

    it('пробний продовжує оплату, якщо він далі', () => {
      const b = clubBilling(
        { paidUntil: day('2026-09-05'), trialEndsAt: day('2026-10-05') },
        NOW,
      );
      expect(b.trial).toBe(true);
      expect(b.until).toEqual(day('2026-10-05'));
      expect(b.state).toBe('ok');
    });

    it('давній пробний не перебиває свіжу оплату', () => {
      const b = clubBilling(
        { paidUntil: day('2027-01-01'), trialEndsAt: day('2026-01-01') },
        NOW,
      );
      expect(b.trial).toBe(false);
      expect(b.until).toEqual(day('2027-01-01'));
      expect(b.state).toBe('ok');
    });
  });
});

/* Порівнюємо календарний день, а не мілісекунди: extendPaidUntil рахує в
   локальній зоні й зберігає час на стінному годиннику, тому через перехід на
   зимовий час UTC-мітка зсувається на годину. Для дати «оплачено до» це
   байдуже — clubBilling бере startOf('day') у тій самій зоні, — а от
   toEqual на Date розвалився б саме на кварталі вересень→грудень. */
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('extendPaidUntil', () => {
  it('місяць', () => {
    expect(ymd(extendPaidUntil(day('2026-09-02'), 'MONTH'))).toBe('2026-10-02');
  });

  it('квартал — три місяці', () => {
    expect(ymd(extendPaidUntil(day('2026-09-02'), 'QUARTER'))).toBe('2026-12-02');
  });

  it('рік', () => {
    expect(ymd(extendPaidUntil(day('2026-09-02'), 'YEAR'))).toBe('2027-09-02');
  });

  /* 31 січня + місяць — не 31 лютого. Luxon кладе на останній день місяця,
     і саме це нам треба: інакше продовження падало б з невалідною датою. */
  it('кінець місяця не з’їжджає в неіснуючу дату', () => {
    expect(ymd(extendPaidUntil(day('2026-01-31'), 'MONTH'))).toBe('2026-02-28');
  });
});
