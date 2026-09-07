import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ready: vi.fn(),
  token: vi.fn(),
  setWebhook: vi.fn(),
  setMyCommands: vi.fn(),
}));

vi.mock('./telegram', () => ({
  botReady: mocks.ready,
  botToken: mocks.token,
  setWebhook: mocks.setWebhook,
  setMyCommands: mocks.setMyCommands,
}));

const { startBot, telegramWebhookSecret, telegramWebhookUrl } = await import('./botRunner');

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...originalEnv };
  delete process.env.TELEGRAM_WEBHOOK_URL;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  delete process.env.PUBLIC_API_URL;
  mocks.ready.mockReturnValue(true);
  mocks.token.mockReturnValue('123:telegram-token');
  mocks.setWebhook.mockResolvedValue(true);
  mocks.setMyCommands.mockResolvedValue(true);
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('telegram webhook mode', () => {
  it('does not contact Telegram in local mode', async () => {
    process.env.PUBLIC_API_URL = 'http://localhost:3000';
    await startBot();
    expect(mocks.setWebhook).not.toHaveBeenCalled();
    expect(mocks.setMyCommands).not.toHaveBeenCalled();
  });

  it('derives the webhook from the Render service host', () => {
    process.env.PUBLIC_API_URL = 'court-booking-api.onrender.com';
    expect(telegramWebhookUrl()).toBe(
      'https://court-booking-api.onrender.com/api/telegram/webhook',
    );
  });

  it('derives a stable webhook secret without exposing the bot token', () => {
    const secret = telegramWebhookSecret();
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(secret).not.toContain('telegram-token');
    expect(telegramWebhookSecret()).toBe(secret);
  });

  it('registers one webhook and does not start polling', async () => {
    process.env.PUBLIC_API_URL = 'court-booking-api.onrender.com';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secret';

    await startBot();

    expect(mocks.setWebhook).toHaveBeenCalledTimes(1);
    expect(mocks.setWebhook).toHaveBeenCalledWith(
      'https://court-booking-api.onrender.com/api/telegram/webhook',
      'secret',
    );
    expect(mocks.setMyCommands).toHaveBeenCalledTimes(1);
  });

  it('keeps the API alive when Telegram rejects setup', async () => {
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secret';
    mocks.setWebhook.mockRejectedValue(new Error('network'));

    await expect(startBot()).resolves.toBeUndefined();
  });
});
