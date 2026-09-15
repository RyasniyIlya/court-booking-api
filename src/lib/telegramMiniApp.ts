import { createHmac, timingSafeEqual } from 'node:crypto';

/** Telegram recommends rejecting stale Mini App data. Five minutes is enough
 * for an ordinary launch while keeping a copied payload short-lived. */
export const TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = 5 * 60;
const FUTURE_SKEW_SECONDS = 30;
const MAX_INIT_DATA_LENGTH = 8192;

export type TelegramMiniAppIdentity = {
  userId: string;
  authDate: Date;
  queryId: string | null;
};

export class TelegramMiniAppDataError extends Error {
  constructor(public readonly code: 'INVALID' | 'EXPIRED' | 'UNAVAILABLE') {
    super(code);
  }
}

/**
 * Validate raw Telegram.WebApp.initData exactly as documented by Telegram.
 * Never accept initDataUnsafe: it is only a parsed display helper and has no
 * integrity guarantee.
 */
export function verifyTelegramMiniAppData(
  raw: string,
  botToken = process.env.TELEGRAM_BOT_TOKEN ?? '',
  now = new Date(),
): TelegramMiniAppIdentity {
  if (!botToken) throw new TelegramMiniAppDataError('UNAVAILABLE');
  if (!raw || raw.length > MAX_INIT_DATA_LENGTH) throw new TelegramMiniAppDataError('INVALID');

  const params = new URLSearchParams(raw);
  const entries = [...params.entries()];
  const keys = entries.map(([key]) => key);
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) {
    throw new TelegramMiniAppDataError('INVALID');
  }
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw new TelegramMiniAppDataError('INVALID');

  const checkString = entries
    .filter(([key]) => key !== 'hash')
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest();
  const received = Buffer.from(hash, 'hex');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new TelegramMiniAppDataError('INVALID');
  }

  const authDateSeconds = Number(params.get('auth_date'));
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(authDateSeconds) || authDateSeconds <= 0) {
    throw new TelegramMiniAppDataError('INVALID');
  }
  if (authDateSeconds > nowSeconds + FUTURE_SKEW_SECONDS
      || nowSeconds - authDateSeconds > TELEGRAM_INIT_DATA_MAX_AGE_SECONDS) {
    throw new TelegramMiniAppDataError('EXPIRED');
  }

  let user: unknown;
  try { user = JSON.parse(params.get('user') ?? ''); } catch { throw new TelegramMiniAppDataError('INVALID'); }
  const telegramId = (user as { id?: unknown; is_bot?: unknown })?.id;
  if (!Number.isSafeInteger(telegramId) || Number(telegramId) <= 0
      || (user as { is_bot?: unknown }).is_bot === true) {
    throw new TelegramMiniAppDataError('INVALID');
  }

  return {
    userId: String(telegramId),
    authDate: new Date(authDateSeconds * 1000),
    queryId: params.get('query_id'),
  };
}
