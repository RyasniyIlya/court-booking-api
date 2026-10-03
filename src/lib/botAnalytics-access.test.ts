import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), sendMessage: vi.fn(), report: vi.fn(), answerCallback: vi.fn(), bookings: vi.fn(), day: vi.fn() }));
vi.mock('./db', () => ({ prisma: { user: { findUnique: mocks.findUnique }, booking: { findMany: mocks.bookings }, tgDialog: { findUnique: async () => null } } }));
vi.mock('./telegram', () => ({ sendMessage: mocks.sendMessage, answerCallback: mocks.answerCallback, deleteMessage: vi.fn(), editMessageText: vi.fn(), setMyCommands: vi.fn() }));
vi.mock('./botAnalytics', () => ({ botAnalytics: mocks.report }));
vi.mock('./botAuth', () => ({ loginByPassword: vi.fn(), logout: vi.fn(), menuFor: () => 'menu' }));
vi.mock('./botPassword', () => ({ changePassword: vi.fn(), parseNewPassword: vi.fn(), requestReset: vi.fn() }));
vi.mock('./digest', () => ({ dayDigest: mocks.day, digestText: vi.fn(), WEEKDAY_FULL: [], weekReport: vi.fn(), weekText: vi.fn() }));
vi.mock('./sections', () => ({ revenueBreakdown: vi.fn(), revenueText: vi.fn(), staffReport: vi.fn(), staffText: vi.fn() }));
const { handleUpdate } = await import('./botHandlers');
const update = (type = 'private') => ({ update_id: 1, message: { message_id: 1, from: { id: 123 }, chat: { id: 123, type }, text: '/analytics yesterday' } });
beforeEach(() => { vi.clearAllMocks(); mocks.report.mockResolvedValue(['page 1', 'page 2']); });
it.each(['TRAINER', 'ADMIN', 'unknown'])('denies role %s before loading analytics', async role => {
  mocks.findUnique.mockResolvedValue({ role, club: { id: 'club', plan: { tier: 3 } } });
  await handleUpdate(update());
  expect(mocks.report).not.toHaveBeenCalled();
});
it('denies unauthenticated chats', async () => {
  mocks.findUnique.mockResolvedValue(null);
  await handleUpdate(update());
  expect(mocks.report).not.toHaveBeenCalled();
});
it('denies group chats even for an owner', async () => {
  mocks.findUnique.mockResolvedValue({ role: 'OWNER', club: { id: 'club', plan: { tier: 3 } } });
  await handleUpdate(update('group'));
  expect(mocks.report).not.toHaveBeenCalled();
});
it.each(['OWNER'])('sends all pages for %s using the linked club only', async role => {
  mocks.findUnique.mockResolvedValue({ role, club: { id: 'club', plan: { tier: 3 } } });
  await handleUpdate(update());
  expect(mocks.report).toHaveBeenCalledWith('club', 'yesterday');
  expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
  expect(mocks.sendMessage.mock.calls[1][1]).toBe('page 2');
});

it.each([null, {tier:1}, {tier:2}])('blocks existing Telegram connections after downgrade to %s', async plan => {
 mocks.findUnique.mockResolvedValue({role:'OWNER',club:{id:'club',plan}});
 await handleUpdate(update());
 expect(mocks.report).not.toHaveBeenCalled();
 expect(mocks.sendMessage.mock.calls[0][1]).toContain('максимальному');
});
it.each([null, {tier:1}, {tier:2}])('blocks old report buttons for %s', async plan => {
 mocks.findUnique.mockResolvedValue({role:'OWNER',club:{id:'club',plan}});
 await handleUpdate({update_id:1,callback_query:{id:'q',from:{id:123},data:'day:0',message:{message_id:1,chat:{id:123,type:'private'}}}});
 expect(mocks.day).not.toHaveBeenCalled();
 expect(mocks.answerCallback).toHaveBeenCalledWith('q',expect.stringContaining('максимальному'));
});
it.each([1,2,3])('trainer schedule requires maximum tier: %s', async tier => {
 mocks.findUnique.mockResolvedValue({role:'TRAINER',trainerId:'trainer-1',club:{id:'club',name:'Club',timezone:'Europe/Kyiv',plan:{tier}}});
 mocks.bookings.mockResolvedValue([]);
 await handleUpdate({...update(),message:{...update().message,text:'/today'}});
 if(tier===3) expect(mocks.bookings).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({trainerId:'trainer-1'})}));
 else expect(mocks.bookings).not.toHaveBeenCalled();
});
