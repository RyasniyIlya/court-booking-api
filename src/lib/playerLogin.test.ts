import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Вхід телефоном і паролем сайту; сумісність одноразових посилань
 * із перевіркою власного Telegram-контакту.
 */

type Row = { chatId: string; flow: string; step: string; data: Record<string, unknown>; expiresAt: Date };
const dialogs = new Map<string, Row>();

const prisma = {
  tgDialog: {
    findUnique: vi.fn(async ({ where }: { where: { chatId: string } }) => dialogs.get(where.chatId) ?? null),
    upsert: vi.fn(async ({ where, create, update }: { where: { chatId: string }; create: Row; update: Partial<Row> }) => {
      const prev = dialogs.get(where.chatId);
      const row = prev ? { ...prev, ...update } as Row : create;
      dialogs.set(where.chatId, row);
      return row;
    }),
    deleteMany: vi.fn(async ({ where }: { where: { chatId: string } }) => {
      dialogs.delete(where.chatId);
      return { count: 1 };
    }),
  },
  club: { findFirst: vi.fn(), findMany: vi.fn() },
  customer: {
    findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(async () => []),
    update: vi.fn(), updateMany: vi.fn(), create: vi.fn(),
  },
  waitlistEntry: { updateMany: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
};
const sendMessage = vi.fn();
const deleteMessage = vi.fn(async () => true);
const verifyCustomerPassword = vi.fn();

vi.mock('./db', () => ({ prisma }));
vi.mock('./telegram', () => ({ sendMessage, deleteMessage, answerCallback: vi.fn(), editMessageText: vi.fn(), botReady: () => true }));
vi.mock('./customerPassword', () => ({ verifyCustomerPassword }));
vi.mock('./plans', () => ({ planFeatures: (plan: unknown) => ({ telegram: plan === 'max' }) }));
vi.mock('./botBooking', () => ({
  openBookingKeyboard: () => ({ inline_keyboard: [[{ text: 'Обрати час', url: 'https://x' }]] }),
  openProfileKeyboard: () => ({ inline_keyboard: [[{ text: 'Відкрити профіль', web_app: { url: 'https://club.example/c/squash?cbProfile=1' } }]] }),
  bookingUrl: () => 'https://club.example/c/squash',
}));

const login = await import('./playerLogin');

const CHAT = '555';
const club = { id: 'club-1', slug: 'squash', name: 'Squash', plan: 'max' };
const card = { id: 'cust-1', name: 'Петро', phone: '+380671112233', clubId: 'club-1' };

const msg = (over: Record<string, unknown> = {}) => ({
  message_id: 1,
  chat: { id: 555, type: 'private' },
  from: { id: 555, first_name: 'Петро' },
  ...over,
});
const ownContact = (phone = '380671112233') => msg({ contact: { phone_number: phone, user_id: 555 } });

/** Чат привʼязали до картки (update з telegramChatId саме цього чату) */
const linkedTo = () => prisma.customer.update.mock.calls
  .map((c) => c[0] as { where: { id: string }; data: { telegramChatId?: string } })
  .filter((c) => c.data.telegramChatId === CHAT)
  .map((c) => c.where.id);
const texts = () => sendMessage.mock.calls.map((c) => String(c[1])).join('\n---\n');

beforeEach(() => {
  vi.clearAllMocks();
  dialogs.clear();
  prisma.club.findFirst.mockResolvedValue(club);
  prisma.customer.findFirst.mockResolvedValue(null);
  prisma.customer.findUnique.mockResolvedValue(null);
});

describe('/profile — телефон і пароль із сайту', () => {
  beforeEach(async () => {
    await login.startPlayerLogin(CHAT, 'squash');
  });

  it('просить телефон та дає кнопку реєстрації на сайті', () => {
    expect(dialogs.get(CHAT)?.step).toBe('account-phone');
    expect(JSON.stringify(sendMessage.mock.calls)).toContain('Створити профіль на сайті');
  });

  it('номер без пароля не привʼязує чат', async () => {
    prisma.customer.findUnique.mockResolvedValue(card);
    expect(await login.handlePlayerLoginMessage(msg({ text: '0671112233' }))).toBe(true);
    expect(linkedTo()).toEqual([]);
    expect(prisma.customer.findUnique).not.toHaveBeenCalled();
    expect(dialogs.get(CHAT)?.step).toBe('account-password');
  });

  it('чужий пересланий контакт не пускає', async () => {
    prisma.customer.findUnique.mockResolvedValue(card);
    await login.handlePlayerLoginMessage(msg({ contact: { phone_number: '380671112233', user_id: 999 } }));
    expect(linkedTo()).toEqual([]);
    expect(dialogs.get(CHAT)?.step).toBe('account-phone');
  });

  it('перевірений пароль підключає наявний профіль і відкриває меню', async () => {
    prisma.customer.findUnique.mockResolvedValue(card);
    verifyCustomerPassword.mockResolvedValue({ ok: true });
    await login.handlePlayerLoginMessage(msg({ text: '0671112233' }));
    await login.handlePlayerLoginMessage(msg({ text: ' password with spaces ' }));
    expect(verifyCustomerPassword).toHaveBeenCalledWith(card.id, ' password with spaces ');
    expect(deleteMessage).toHaveBeenCalledWith(CHAT, 1);
    expect(linkedTo()).toEqual(['cust-1']);
    expect(dialogs.has(CHAT)).toBe(false);
    expect(JSON.stringify(sendMessage.mock.calls)).toContain('📋 Мої записи');
  });

  it('профілю з таким номером немає — на сайт, нічого не створює', async () => {
    await login.handlePlayerLoginMessage(msg({ text: '0671112233' }));
    await login.handlePlayerLoginMessage(msg({ text: 'wrong-password' }));
    expect(linkedTo()).toEqual([]);
    expect(prisma.customer.create).not.toHaveBeenCalled();
    expect(texts()).toContain('Не вдалося увійти');
    expect(verifyCustomerPassword).not.toHaveBeenCalled();
  });

  it.each(['INVALID', 'LOCKED', 'NOT_SET'])('відхилений пароль %s не дає доступу', async (reason) => {
    prisma.customer.findUnique.mockResolvedValue(card);
    verifyCustomerPassword.mockResolvedValue({ ok: false, reason });
    await login.handlePlayerLoginMessage(msg({ text: card.phone }));
    await login.handlePlayerLoginMessage(msg({ text: 'wrong-password' }));
    expect(linkedTo()).toEqual([]);
    expect(dialogs.has(CHAT)).toBe(false);
  });

  it('прострочений діалог видаляє пароль, але не перевіряє його', async () => {
    await login.handlePlayerLoginMessage(msg({ text: card.phone }));
    dialogs.get(CHAT)!.expiresAt = new Date(0);
    await login.handlePlayerLoginMessage(msg({ text: 'secret-password' }));
    expect(deleteMessage).toHaveBeenCalled();
    expect(verifyCustomerPassword).not.toHaveBeenCalled();
    expect(linkedTo()).toEqual([]);
  });

  it('пароль зі слешем не стає командою персоналу', async () => {
    prisma.customer.findUnique.mockResolvedValue(card);
    verifyCustomerPassword.mockResolvedValue({ ok: true });
    await login.handlePlayerLoginMessage(msg({ text: card.phone }));
    await login.handlePlayerLoginMessage(msg({ text: '/login password' }));
    expect(verifyCustomerPassword).toHaveBeenCalledWith(card.id, '/login password');
  });

  it('«Скасувати» закриває діалог', async () => {
    await login.handlePlayerLoginMessage(msg({ text: login.BTN_CANCEL }));
    expect(dialogs.has(CHAT)).toBe(false);
  });

  it('інша команда посеред входу віддається звичайному обробнику', async () => {
    expect(await login.handlePlayerLoginMessage(msg({ text: '/help' }))).toBe(false);
    expect(dialogs.has(CHAT)).toBe(false);
  });
});

describe('«Підключити Telegram» з профілю — код + підтвердження номера', () => {
  const codeRow = (over: Record<string, unknown> = {}) => ({
    id: 'cust-1', clubId: 'club-1', tgLinkUntil: new Date(Date.now() + 60_000),
    club: { slug: 'squash', name: 'Squash' }, ...over,
  });

  it('сам код чат не привʼязує, але гаситься одразу', async () => {
    prisma.customer.findUnique.mockResolvedValueOnce(codeRow());
    await login.startLinkByCode(CHAT, 'code');
    expect(linkedTo()).toEqual([]);
    expect(prisma.customer.update).toHaveBeenCalledWith({
      where: { id: 'cust-1' }, data: { tgLinkCode: null, tgLinkUntil: null },
    });
    expect(dialogs.get(CHAT)?.data).toEqual({ clubId: 'club-1', customerId: 'cust-1' });
  });

  it('номер Telegram збігся з карткою коду — підключено', async () => {
    prisma.customer.findUnique.mockResolvedValueOnce(codeRow());
    await login.startLinkByCode(CHAT, 'code');
    prisma.customer.findUnique.mockResolvedValueOnce(card);
    await login.handlePlayerLoginMessage(ownContact());
    expect(linkedTo()).toEqual(['cust-1']);
  });

  it('номер Telegram інший — не підключає, підказує останні цифри номера профілю', async () => {
    prisma.customer.findUnique.mockResolvedValueOnce(codeRow());
    await login.startLinkByCode(CHAT, 'code');
    prisma.customer.findUnique.mockResolvedValueOnce(card);
    await login.handlePlayerLoginMessage(ownContact('380509998877'));
    expect(linkedTo()).toEqual([]);
    expect(texts()).toContain('не збігається');
    expect(texts()).toContain('•• 33');
    expect(texts()).not.toContain('+380671112233');
    expect(dialogs.has(CHAT)).toBe(false);
  });

  it('протухлий код — ні діалогу, ні привʼязки', async () => {
    prisma.customer.findUnique.mockResolvedValueOnce(codeRow({ tgLinkUntil: new Date(Date.now() - 1000) }));
    await login.startLinkByCode(CHAT, 'code');
    expect(dialogs.has(CHAT)).toBe(false);
    expect(texts()).toContain('протухло');
  });

  it('невідомий код', async () => {
    await login.startLinkByCode(CHAT, 'nope');
    expect(dialogs.has(CHAT)).toBe(false);
    expect(texts()).toContain('недійсне');
  });
});

describe('розбір', () => {
  it('start-параметр входу', () => {
    expect(login.loginSlugFromStartPayload('login_squash-arena')).toBe('squash-arena');
    expect(login.loginSlugFromStartPayload('club_squash')).toBeNull();
  });

  it('підказка номера не розкриває його', () => {
    expect(login.phoneHint('+380671112233')).toBe('•• 33');
  });
});
