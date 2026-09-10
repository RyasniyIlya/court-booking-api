import { z } from 'zod';

export const calendarDateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((raw) => {
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw;
}, 'invalid date');
export const birthDateText = calendarDateText.refine((raw) =>
  raw >= '1900-01-01' && raw <= new Date().toISOString().slice(0, 10), 'invalid birth date');

export const birthDateValue = (raw: string) => new Date(`${raw}T00:00:00.000Z`);
export const dateOnly = (value: Date | null | undefined) => value?.toISOString().slice(0, 10) ?? null;

/** 0 = сьогодні, 1 = завтра; 29 лютого у невисокосний рік показуємо 28-го. */
export function daysUntilBirthday(birthDate: Date | null, now = new Date()): number | null {
  if (!birthDate) return null;
  const month = birthDate.getUTCMonth();
  const day = birthDate.getUTCDate();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const inYear = (year: number) => {
    if (month === 1 && day === 29 && new Date(Date.UTC(year, 1, 29)).getUTCMonth() !== 1) {
      return new Date(Date.UTC(year, 1, 28));
    }
    return new Date(Date.UTC(year, month, day));
  };
  let next = inYear(today.getUTCFullYear());
  if (next < today) next = inYear(today.getUTCFullYear() + 1);
  return Math.round((next.getTime() - today.getTime()) / 86_400_000);
}
