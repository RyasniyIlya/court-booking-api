import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Вхід гравця в бота. Головне правило: чат привʼязується до картки тільки
 * номером, який підтвердив Telegram, і цей номер має збігтися з карткою.
 * Жоден набраний руками номер і жодна дата народження сюди не ведуть.
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

vi.mock('./db', () => ({ prisma }));
vi.mock('./telegram', () => ({ sendMessage, answerCallback: vi.fn(), editMessageText: vi.fn(), botReady: () => true }));
vi.mock('./plans', () => ({ planFeatures: (plan: unknown) => ({ telegram: plan === 'max' }) }));
vi.mock('./botBooking', () => ({
  openBookingKeyboard: () => ({ inline_keyboard: [[{ text: 'Обрати час', url: 'https://x' }]] }),
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

describe('/profile — вхід за номером Telegram', () => {
  beforeEach(async () => {
    await login.startPlayerLogin(CHAT, 'squash');
  });

  it('просить номер кнопкою request_contact', () => {
    expect(dialogs.get(CHAT)?.step).toBe('phone');
    expect(JSON.stringify(sendMessage.mock.calls[0][2])).toContain('"request_contact":true');
  });

  it('набраний руками номер не приймає — навіть якщо профіль із ним є', async () => {
    prisma.customer.findUnique.mockResolvedValue(card);
    expect(await login.handlePlayerLoginMessage(msg({ text: '0671112233' }))).toBe(true);
    expect(linkedTo()).toEqual([]);
    expect(prisma.customer.findUnique).not.toHaveBeenCalled();
    expect(dialogs.get(CHAT)?.step).toBe('phone');
  });

  it('чужий пересланий контакт не пускає', async () => {
    prisma.customer.findUnique.mockResolvedValue(card);
    await login.handlePlayerLoginMessage(msg({ contact: { phone_number: '380671112233', user_id: 999 } }));
    expect(linkedTo()).toEqual([]);
    expect(texts()).toContain('чужий контакт');
  });

  it('свій контакт і профіль із цим номером — вхід', async () => {
    prisma.customer.findUnique.mockResolvedValue(card);
    await login.handlePlayerLoginMessage(ownContact());
    expect(linkedTo()).toEqual(['cust-1']);
    expect(dialogs.has(CHAT)).toBe(false);
  });

  it('профілю з таким номером немає — на сайт, нічого не створює', async () => {
    await login.handlePlayerLoginMessage(ownContact());
    expect(linkedTo()).toEqual([]);
    expect(prisma.customer.create).not.toHaveBeenCalled();
    expect(texts()).toContain('ще немає');
    expect(JSON.stringify(sendMessage.mock.calls.at(-1)?.[2])).toContain('https://club.example/c/squash');
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
