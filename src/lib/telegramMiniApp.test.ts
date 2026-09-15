import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TELEGRAM_INIT_DATA_MAX_AGE_SECONDS, TelegramMiniAppDataError, verifyTelegramMiniAppData } from './telegramMiniApp';

const token = '123456789:telegram-test-token';
const now = new Date('2026-09-15T12:00:00.000Z');
function signed(overrides: Record<string, string> = {}) {
  const values = {
    auth_date: String(Math.floor(now.getTime() / 1000)),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify({ id: 777000123, first_name: 'Test' }),
    ...overrides,
  };
  const check = Object.entries(values).map(([key, value]) => `${key}=${value}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...values, hash }).toString();
}

describe('Telegram Mini App initData', () => {
  it('accepts a fresh signed Telegram user', () => {
    expect(verifyTelegramMiniAppData(signed(), token, now)).toMatchObject({ userId: '777000123', queryId: 'AAHdF6IQAAAAAN0XohDhrOrc' });
  });
  it('rejects tampering after signing', () => {
    expect(() => verifyTelegramMiniAppData(signed().replace('777000123', '777000124'), token, now))
      .toThrow(TelegramMiniAppDataError);
  });
  it('rejects stale and far-future launches', () => {
    const old = String(Math.floor(now.getTime() / 1000) - TELEGRAM_INIT_DATA_MAX_AGE_SECONDS - 1);
    expect(() => verifyTelegramMiniAppData(signed({ auth_date: old }), token, now)).toThrow('EXPIRED');
    const future = String(Math.floor(now.getTime() / 1000) + 31);
    expect(() => verifyTelegramMiniAppData(signed({ auth_date: future }), token, now)).toThrow('EXPIRED');
  });
  it('rejects duplicate fields, bots and missing server token', () => {
    expect(() => verifyTelegramMiniAppData(`${signed()}&user={}`, token, now)).toThrow('INVALID');
    expect(() => verifyTelegramMiniAppData(signed({ user: JSON.stringify({ id: 1, is_bot: true }) }), token, now)).toThrow('INVALID');
    expect(() => verifyTelegramMiniAppData(signed(), '', now)).toThrow('UNAVAILABLE');
  });
});
