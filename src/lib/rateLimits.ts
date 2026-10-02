import type { Request, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';

/**
 * Фабрика IP-лімітів для публічних шляхів. Під тестами (vitest ставить
 * NODE_ENV=test) ліміт вимкнений: supertest б'є в ті самі маршрути з одного
 * адреса, і 429 ламав би не пов'язані тести. `enforceInTests` лишає ліміт
 * увімкненим для його власного юніт-тесту.
 */
// RequestHandler<any>: інакше Express втрачає типи :params у маршруті, де стоїть ліміт.
export function makeLimiter(opts: { windowMs: number; limit: number; skip?: (req: Request) => boolean; enforceInTests?: boolean }): RequestHandler<any> {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'TOO_MANY_REQUESTS' },
    skip: (req) =>
      (!opts.enforceInTests && process.env.NODE_ENV === 'test') || Boolean(opts.skip?.(req)),
  });
}

/**
 * Записуючі дії гравця без входу: 30 запитів / 10 хв з IP. Без цього
 * POST /bookings — безлімітний оракул дати народження картки
 * (BIRTH_DATE_MISMATCH) і дає скрипту змогу зайняти всі слоти клубу.
 */
export const publicWriteLimiter = makeLimiter({ windowMs: 10 * 60_000, limit: 30 });

/** Загальна стеля на весь публічний API: 300 запитів / хв з IP. */
export const publicGeneralLimiter = makeLimiter({ windowMs: 60_000, limit: 300 });

/** Платіжні сторінки: 120 / хв. Вебхуки банку не душимо — банк повторює, а ми втрачаємо оплату. */
export const payGeneralLimiter = makeLimiter({
  windowMs: 60_000,
  limit: 120,
  skip: (req) => req.path.startsWith('/webhook/'),
});
