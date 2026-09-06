import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), sendMessage: vi.fn(), report: vi.fn() }));
vi.mock('./db', () => ({ prisma: { user: { findUnique: mocks.findUnique } } }));
vi.mock('./telegram', () => ({ sendMessage: mocks.sendMessage, answerCallback: vi.fn(), deleteMessage: vi.fn(), editMessageText: vi.fn(), setMyCommands: vi.fn() }));
vi.mock('./botAnalytics', () => ({ botAnalytics: mocks.report }));
vi.mock('./botAuth', () => ({ loginByPassword: vi.fn(), logout: vi.fn(), menuFor: () => 'menu' }));
vi.mock('./botPassword', () => ({ changePassword: vi.fn(), parseNewPassword: vi.fn(), requestReset: vi.fn() }));
vi.mock('./digest', () => ({ dayDigest: vi.fn(), digestText: vi.fn(), WEEKDAY_FULL: [], weekReport: vi.fn(), weekText: vi.fn() }));
vi.mock('./sections', () => ({ revenueBreakdown: vi.fn(), revenueText: vi.fn(), staffReport: vi.fn(), staffText: vi.fn() }));
const { handleUpdate } = await import('./botHandlers');
const update = (type = 'private') => ({ update_id: 1, message: { message_id: 1, chat: { id: 123, type }, text: '/analytics yesterday' } });
beforeEach(() => { vi.clearAllMocks(); mocks.report.mockResolvedValue(['page 1', 'page 2']); });
it.each(['TRAINER', 'unknown'])('denies role %s before loading analytics', async role => {
  mocks.findUnique.mockResolvedValue({ role, club: { id: 'club' } });
  await handleUpdate(update());
  expect(mocks.report).not.toHaveBeenCalled();
});
it('denies unauthenticated chats', async () => {
  mocks.findUnique.mockResolvedValue(null);
  await handleUpdate(update());
  expect(mocks.report).not.toHaveBeenCalled();
});
it('denies group chats even for an owner', async () => {
  mocks.findUnique.mockResolvedValue({ role: 'OWNER', club: { id: 'club' } });
  await handleUpdate(update('group'));
  expect(mocks.report).not.toHaveBeenCalled();
});
it.each(['OWNER', 'ADMIN'])('sends all pages for %s using the linked club only', async role => {
  mocks.findUnique.mockResolvedValue({ role, club: { id: 'club' } });
  await handleUpdate(update());
  expect(mocks.report).toHaveBeenCalledWith('club', 'yesterday');
  expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
  expect(mocks.sendMessage.mock.calls[1][1]).toBe('page 2');
});
