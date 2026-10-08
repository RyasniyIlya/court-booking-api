import { beforeEach, expect, it, vi } from 'vitest';

/**
 * Екран «Сповіщення» у боті: команда, натискання, запис у базу.
 *
 * Розмітку перевіряє botSettings.test.ts — тут те, чого чисті функції не
 * бачать: що екран взагалі відкривається потрібним ролям, що натискання
 * доходить до бази рівно одним полем і що чужу кнопку не приймають.
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  update: vi.fn(),
  sendMessage: vi.fn(),
  editMessageText: vi.fn(),
  answerCallback: vi.fn(),
}));

vi.mock('./db', () => ({
  prisma: {
    user: {
      findUnique: mocks.findUnique,
      findUniqueOrThrow: mocks.findUniqueOrThrow,
      update: mocks.update,
    },
    booking: { findMany: vi.fn() },
    /* Покрокова реєстрація гравця: активного діалогу в цих чатах немає. */
    tgDialog: { findUnique: async () => null },
  },
}));
vi.mock('./telegram', () => ({
  sendMessage: mocks.sendMessage,
  editMessageText: mocks.editMessageText,
  answerCallback: mocks.answerCallback,
  deleteMessage: vi.fn(),
  setMyCommands: vi.fn(),
}));
vi.mock('./botAnalytics', () => ({ botAnalytics: vi.fn() }));
vi.mock('./botAuth', () => ({ loginByPassword: vi.fn(), logout: vi.fn(), menuFor: () => 'menu' }));
vi.mock('./botPassword', () => ({ changePassword: vi.fn(), parseNewPassword: vi.fn(), requestReset: vi.fn() }));
vi.mock('./digest', () => ({ dayDigest: vi.fn(), digestText: vi.fn(), WEEKDAY_FULL: [], weekReport: vi.fn(), weekText: vi.fn() }));
vi.mock('./sections', () => ({ revenueBreakdown: vi.fn(), revenueText: vi.fn(), staffReport: vi.fn(), staffText: vi.fn() }));

const { handleUpdate } = await import('./botHandlers');

const settings = {
  tgNotifyBookings: true,
  tgNotifyTournaments: true,
  tgNotifyGroups: true,
  tgNotifySessions: true,
  tgRemindMinutes: 15,
};

const me = (over: Record<string, unknown> = {}) => ({
  id: 'user-1',
  role: 'OWNER',
  trainerId: null,
  club: { id: 'club', name: 'Клуб', timezone: 'Europe/Kyiv', plan: { tier: 3 } },
  ...over,
});

const command = (text = '/settings') => ({
  update_id: 1,
  message: { message_id: 1, from: { id: 123 }, chat: { id: 123, type: 'private' }, text },
});

const tap = (data: string) => ({
  update_id: 2,
  callback_query: {
    id: 'cb-1',
    data,
    message: { message_id: 7, chat: { id: 123 } },
    from: { id: 123 },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(me());
  mocks.findUniqueOrThrow.mockResolvedValue(settings);
  mocks.update.mockResolvedValue(settings);
});

it.each(['OWNER', 'ADMIN', 'TRAINER'])('екран відкривається ролі %s', async (role) => {
  mocks.findUnique.mockResolvedValue(me({ role }));

  await handleUpdate(command());

  expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  expect(mocks.sendMessage.mock.calls[0][1]).toContain('Сповіщення');
  expect(mocks.sendMessage.mock.calls[0][2]).toHaveProperty('inline_keyboard');
});

/* Кнопка постійної клавіатури приходить звичайним текстом — без таблиці
   відповідності вона мовчки перестала б працювати. */
it('кнопка «⚙️ Сповіщення» відкриває той самий екран', async () => {
  await handleUpdate(command('⚙️ Сповіщення'));

  expect(mocks.sendMessage.mock.calls[0][1]).toContain('Сповіщення');
});

it('натискання перемикає рівно одне поле на протилежне', async () => {
  mocks.findUniqueOrThrow.mockResolvedValue({ ...settings, tgNotifyGroups: true });

  await handleUpdate(tap('ntf:tgNotifyGroups'));

  expect(mocks.update).toHaveBeenCalledTimes(1);
  const arg = mocks.update.mock.calls[0][0];
  expect(arg.where).toEqual({ id: 'user-1' });
  expect(arg.data).toEqual({ tgNotifyGroups: false });
});

it('інтервал записується числом', async () => {
  await handleUpdate(tap('lead:30'));

  expect(mocks.update.mock.calls[0][0].data).toEqual({ tgRemindMinutes: 30 });
});

/* Екран перемальовується на місці: десять натискань не мають лишити
   десять однакових екранів у стрічці. */
it('екран оновлюється на місці, а не новим повідомленням', async () => {
  await handleUpdate(tap('lead:60'));

  expect(mocks.editMessageText).toHaveBeenCalledTimes(1);
  expect(mocks.editMessageText.mock.calls[0][1]).toBe(7);
  expect(mocks.sendMessage).not.toHaveBeenCalled();
  expect(mocks.answerCallback).toHaveBeenCalled();
});

/* Кнопка зі старого повідомлення, надісланого до зміни ролі. */
it('чужий перемикач не пише в базу', async () => {
  mocks.findUnique.mockResolvedValue(me({ role: 'TRAINER' }));

  await handleUpdate(tap('ntf:tgNotifyTournaments'));

  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.answerCallback).toHaveBeenCalledWith('cb-1', expect.stringContaining('не доступний'));
});

/* Підроблений callback_data не має перетворитись на запит до бази з
   довільним полем. */
it('вигадане поле не доходить до бази', async () => {
  await handleUpdate(tap('ntf:passwordHash'));

  expect(mocks.update).not.toHaveBeenCalled();
});

it('незнайомий чат екрана не бачить', async () => {
  mocks.findUnique.mockResolvedValue(null);

  await handleUpdate(command());

  expect(mocks.sendMessage.mock.calls[0][1]).not.toContain('Сповіщення');
  expect(mocks.update).not.toHaveBeenCalled();
});

/* Та сама перевірка тарифу, що й на решті команд: після зниження пакета
   бот мовчить, а не пропонує налаштувати те, чого вже немає. */
it('без тарифу екран не відкривається', async () => {
  mocks.findUnique.mockResolvedValue(me({
    club: { id: 'club', name: 'Клуб', timezone: 'Europe/Kyiv', plan: null },
  }));

  await handleUpdate(command());

  expect(mocks.sendMessage.mock.calls[0][1]).toContain('після підключення тарифу');
  expect(mocks.update).not.toHaveBeenCalled();
});
