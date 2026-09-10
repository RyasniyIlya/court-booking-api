export const REGISTRATION_CUTOFF_MINUTES = 15;

/** Запис відкритий лише раніше ніж за 15 хвилин до початку події. */
export function isRegistrationOpen(startTime: Date, nowMs = Date.now()): boolean {
  return nowMs < startTime.getTime() - REGISTRATION_CUTOFF_MINUTES * 60_000;
}

export function registrationClosesAt(startTime: Date): Date {
  return new Date(startTime.getTime() - REGISTRATION_CUTOFF_MINUTES * 60_000);
}
