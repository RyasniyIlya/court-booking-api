/** Рівно за шість годин перенос ще дозволений. */
export const RESCHEDULE_WINDOW_MS = 6 * 60 * 60_000;
export function canReschedule(start: Date, now = new Date()) {
  return start.getTime() - now.getTime() >= RESCHEDULE_WINDOW_MS;
}
