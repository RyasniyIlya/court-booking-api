import { describe, expect, it } from 'vitest';
import { isRegistrationOpen, registrationClosesAt } from './registrationCutoff';

const start = new Date('2026-09-09T16:00:00.000Z');

describe('registration cutoff', () => {
  it('allows registration earlier than 15 minutes before start', () => {
    expect(isRegistrationOpen(start, Date.parse('2026-09-09T15:44:59.999Z'))).toBe(true);
  });

  it('closes registration exactly 15 minutes before start', () => {
    expect(isRegistrationOpen(start, Date.parse('2026-09-09T15:45:00.000Z'))).toBe(false);
  });

  it('stays closed after the event starts', () => {
    expect(isRegistrationOpen(start, Date.parse('2026-09-09T16:05:00.000Z'))).toBe(false);
  });

  it('returns the exact closing instant', () => {
    expect(registrationClosesAt(start).toISOString()).toBe('2026-09-09T15:45:00.000Z');
  });
});
