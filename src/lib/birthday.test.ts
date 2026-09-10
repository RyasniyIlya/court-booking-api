import { expect, it } from 'vitest';
import { birthDateText, daysUntilBirthday } from './birthday';

it.each(['2024-02-30', '2024-13-01', '1899-12-31', '01.01.2000'])('rejects invalid birth date %s', value => {
  expect(birthDateText.safeParse(value).success).toBe(false);
});
it('finds today and the next birthday across a year boundary', () => {
  expect(daysUntilBirthday(new Date('2000-09-08'), new Date('2026-09-08T15:00:00Z'))).toBe(0);
  expect(daysUntilBirthday(new Date('2000-01-02'), new Date('2026-12-31T15:00:00Z'))).toBe(2);
});
it('celebrates leap-day birthdays on February 28 in a common year', () => {
  expect(daysUntilBirthday(new Date('2000-02-29'), new Date('2027-02-28T12:00:00Z'))).toBe(0);
});
