import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Ю-5: одне повідомлення з посиланням на Політику, без повторів. */

const prisma = { customer: { findMany: vi.fn(), updateMany: vi.fn() } };
const sendMessage = vi.fn();
vi.mock('./db', () => ({ prisma }));
vi.mock('./telegram', () => ({ sendMessage, sendReminderMessage: sendMessage, editMessageText: vi.fn(), answerCallback: vi.fn(), botReady: () => true }));

const { sendPrivacyNoticeOnce } = await import('./playerBot');

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PUBLIC_WEB_URL = 'https://kort.example/';
});

describe('sendPrivacyNoticeOnce', () => {
  it('перший раз шле рядок з посиланням і фіксує показ', async () => {
    prisma.customer.findMany.mockResolvedValue([{ id: 'c1' }]);
    expect(await sendPrivacyNoticeOnce('111')).toBe(true);
    expect(sendMessage.mock.calls[0][1]).toContain('href="https://kort.example/legal/privacy"');
    expect(prisma.customer.findMany.mock.calls[0][0].where).toEqual({ telegramChatId: '111', privacyNoticeAt: null });
    expect(prisma.customer.updateMany.mock.calls[0][0].data).toEqual({ privacyNoticeAt: expect.any(Date) });
  });

  it('повторно не дублює: усі картки вже мають дату', async () => {
    prisma.customer.findMany.mockResolvedValue([]);
    expect(await sendPrivacyNoticeOnce('111')).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('без адреси сайту мовчить', async () => {
    delete process.env.PUBLIC_WEB_URL;
    delete process.env.ADMIN_ORIGINS;
    expect(await sendPrivacyNoticeOnce('111')).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
