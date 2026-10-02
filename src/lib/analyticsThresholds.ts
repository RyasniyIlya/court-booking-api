import { z } from 'zod';

/**
 * Цілі й пороги екрана аналітики (заповнення, скасування, утримання), %.
 * Зберігаються на клубі (Club.analyticsThresholds); null = дефолти веб-клієнта.
 * strict: зайвий ключ — помилка, а не мовчки збережене сміття.
 */
export const analyticsThresholdsSchema = z
  .object({
    occupancy: z.number().int().min(0).max(100),
    cancellation: z.number().int().min(0).max(100),
    retention: z.number().int().min(0).max(100),
  })
  .strict();

/** Нормалізує значення з бази: щось не те — null, і веб бере дефолти. */
export function readAnalyticsThresholds(value: unknown) {
  const parsed = analyticsThresholdsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
