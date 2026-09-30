import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Безшовний перехід з профілю в бот: /start і /book підключеного гравця
 * відкривають його клуб без списку клубів; згода на акції й відписка
 * змінюють тільки ВЛАСНУ картку чату.
 *
 * Сюди входить справжній ланцюг handleUpdate → playerHome → clubBot, а мок
 * бази — маленька «таблиця» клубів і карток, щоб тест падав, коли хтось
 * знову пустить гравця у список усіх клубів.
 */

type Card = {
  id: string; name: string; clubId: string; telegramChatId: string | null;
  tgLastActiveAt: Date | null; createdAt: Date; tgMarketingAt?: Date | null;
};

const PLAN3 = { tier: 3, featTrainers: true, featGroups: true, featAnalytics: true };
const PLAN2 = { tier: 2, featTrainers: true, featGroups: true, featAnalytics: false };

const clubs = [
  { id: 'club-a', slug: 'squash', name: 'Squash Arena', address: 'вул. Київська, 1', phone: '+380671112233', timezone: 'Europe/Kyiv', botSettings: {}, plan: PLAN3 },
  { id: 'club-b', slug: 'padel', name: 'Padel Club', address: null, phone: null, timezone: 'Europe/Kyiv', botSettings: {}, plan: PLAN3 },
  { id: 'club-c', slug: 'basic', name: 'Basic Club', address: null, phone: null, timezone: 'Europe/Kyiv', botSettings: {}, plan: PLAN2 },
];
let cards: Card[] = [];
let staff: Record<string, unknown> | null = null;

const clubOf = (id: string) => clubs.find((c) => c.id === id)!;

const prisma = {
  user: { findUnique: vi.fn(async () => staff) },
  tgDialog: { findUnique: vi.fn(async () => null) },
  club: {
    findFirst: vi.fn(async ({ where }: any) => clubs.find((c) => (where.slug ? c.slug === where.slug : c.id === where.id)) ?? null),
    findMany: vi.fn(async () => clubs.map(({ slug, name }) => ({ slug, name }))),
  },
  customer: {
    findMany: vi.fn(async ({ where }: any) => cards
      .filter((c) => c.telegramChatId === where.telegramChatId)
      .map((c) => ({ ...c, club: clubOf(c.clubId) }))),
    findFirst: vi.fn(async ({ where }: any) => cards.find((c) => c.clubId === where.clubId && c.telegramChatId === where.telegramChatId) ?? null),
    findUnique: vi.fn(async ({ where }: any) => cards.find((c) => c.id === where.id) ?? null),
    update: vi.fn(async ({ where, data }: any) => Object.assign(cards.find((c) => c.id === where.id)!, data)),
  },
  promo: { findMany: vi.fn(async () => []) },
  trainer: { findMany: vi.fn(async () => []) },
  booking: { findMany: vi.fn(async () => []) },
  bookingSeat: { findMany: vi.fn(async () => []) },
};

const tg = {
  sendMessage: vi.fn(),
  editMessageText: vi.fn(),
  answerCallback: vi.fn(),
};

vi.mock('./db', () => ({ prisma }));
vi.mock('./telegram', () => ({
  ...tg,
  deleteMessage: vi.fn(),
  setMyCommands: vi.fn(),
  botReady: () => true,
}));
vi.mock('./botAnalytics', () => ({ botAnalytics: vi.fn() }));
vi.mock('./botAuth', () => ({ loginByPassword: vi.fn(), logout: vi.fn(), menuFor: () => 'menu' }));
vi.mock('./botPassword', () => ({ changePassword: vi.fn(), parseNewPassword: vi.fn(), requestReset: vi.fn() }));
vi.mock('./digest', () => ({ dayDigest: vi.fn(), digestText: vi.fn(), WEEKDAY_FULL: [], weekReport: vi.fn(), weekText: vi.fn() }));
vi.mock('./sections', () => ({ revenueBreakdown: vi.fn(), revenueText: vi.fn(), staffReport: vi.fn(), staffText: vi.fn() }));

const { handleUpdate } = await import('./botHandlers');

const CHAT = 555;
const at = (iso: string) => new Date(iso);
const card = (over: Partial<Card> = {}): Card => ({
  id: '11111111-1111-4111-8111-111111111111', name: 'Олена', clubId: 'club-a', telegramChatId: String(CHAT),
  tgLastActiveAt: null, createdAt: at('2026-01-01T00:00:00Z'), tgMarketingAt: null, ...over,
});

const say = (text: string, chat = CHAT) => handleUpdate({
  update_id: 1,
  message: { message_id: 1, from: { id: chat }, chat: { id: chat, type: 'private' }, text },
});
const tap = (data: string, chat = CHAT) => handleUpdate({
  update_id: 2,
  callback_query: { id: 'cb-1', data, message: { message_id: 7, chat: { id: chat } }, from: { id: chat } },
});

const sent = () => tg.sendMessage.mock.calls.map((c) => ({ chat: c[0], text: String(c[1]), markup: c[2] }));
const allText = () => sent().map((m) => m.text).join('\n---\n');
const buttons = (markup: any) => (markup?.inline_keyboard ?? []).flat();

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PUBLIC_WEB_URL = 'https://club.example';
  cards = [];
  staff = null;
});

describe('/start і /book підключеного гравця', () => {
  beforeEach(() => { cards = [card()]; });

  it('/start відкриває головну клубу — без списку клубів', async () => {
    await say('/start');

    expect(sent()).toHaveLength(1);
    expect(sent()[0].text).toContain('🎾 <b>Squash Arena</b>');
    expect(sent()[0].text).toContain('Вітаємо, Олена!');
    expect(allText()).not.toContain('Оберіть клуб');
    expect(prisma.club.findMany).not.toHaveBeenCalled();
    expect(buttons(sent()[0].markup).map((b: any) => b.text)).toEqual(['🎾 Забронювати', '📋 Мої записи', '👤 Мій профіль']);
  });

  it('відкриття головної позначає клуб «останнім активним»', async () => {
    await say('/start');
    expect(cards[0].tgLastActiveAt).toBeInstanceOf(Date);
  });

  it('кнопка reply-клавіатури «🎾 Забронювати» веде так само', async () => {
    await say('🎾 Забронювати');
    expect(sent()[0].text).toContain('Squash Arena');
    expect(allText()).not.toContain('Оберіть клуб');
  });

  it('/book — те саме', async () => {
    await say('/book');
    expect(sent()[0].text).toContain('Squash Arena');
    expect(prisma.club.findMany).not.toHaveBeenCalled();
  });

  it('кілька карток: клуб із найсвіжішим tgLastActiveAt, є кнопка «Інший клуб»', async () => {
    cards = [
      card({ id: 'a1a1a1a1-1111-4111-8111-111111111111', clubId: 'club-a', tgLastActiveAt: at('2026-09-01T00:00:00Z') }),
      card({ id: 'b2b2b2b2-2222-4222-8222-222222222222', clubId: 'club-b', tgLastActiveAt: at('2026-09-20T00:00:00Z') }),
    ];
    await say('/start');
    expect(sent()[0].text).toContain('Padel Club');
    expect(buttons(sent()[0].markup).map((b: any) => b.text)).toContain('🔁 Інший клуб');
  });

  it('кілька карток без активності — найновіша картка', async () => {
    cards = [
      card({ id: 'a1a1a1a1-1111-4111-8111-111111111111', clubId: 'club-a', createdAt: at('2026-01-01T00:00:00Z') }),
      card({ id: 'b2b2b2b2-2222-4222-8222-222222222222', clubId: 'club-b', createdAt: at('2026-06-01T00:00:00Z') }),
    ];
    await say('/start');
    expect(sent()[0].text).toContain('Padel Club');
  });

  it('картка клубу без тарифу Telegram не рахується — показуємо звичайний вибір клубу', async () => {
    cards = [card({ clubId: 'club-c' })];
    await say('/start');
    expect(allText()).toContain('Оберіть клуб');
  });
});

describe('/start незнайомого чату', () => {
  it('без картки — список клубів, як раніше', async () => {
    await say('/start');
    expect(allText()).toContain('Оберіть клуб');
    expect(prisma.club.findMany).toHaveBeenCalled();
  });

  it('картка іншого чату не відкриває чужий клуб', async () => {
    cards = [card({ telegramChatId: '999' })];
    await say('/start');
    expect(allText()).toContain('Оберіть клуб');
  });
});

describe('персонал, який і сам грає', () => {
  beforeEach(() => {
    staff = { id: 'u1', role: 'OWNER', trainerId: null, club: { id: 'club-a', name: 'Squash Arena', timezone: 'Europe/Kyiv', plan: PLAN3 } };
  });

  it('/book з карткою гравця — головна її клубу', async () => {
    cards = [card({ clubId: 'club-b' })];
    await say('/book');
    expect(sent()[0].text).toContain('Padel Club');
    expect(allText()).not.toContain('Оберіть клуб');
  });

  it('/book без картки — список клубів, як раніше', async () => {
    await say('/book');
    expect(allText()).toContain('Оберіть клуб');
  });
});

describe('/start club_<slug>', () => {
  it('картка цього клубу є — особиста головна, без кнопки входу', async () => {
    cards = [card()];
    await say('/start club_squash');

    expect(sent()).toHaveLength(1);
    expect(sent()[0].text).toContain('Вітаємо, Олена!');
    expect(buttons(sent()[0].markup).map((b: any) => b.callback_data ?? b.text)).not.toContain('plogin:squash');
    expect(buttons(sent()[0].markup).map((b: any) => b.text)).toContain('👤 Мій профіль');
  });

  it('картка іншого клубу — гостьова головна цього клубу з кнопкою входу', async () => {
    cards = [card({ clubId: 'club-b' })];
    await say('/start club_squash');

    expect(sent()[0].text).toContain('Squash Arena');
    expect(sent()[0].text).toContain('Вітаємо, гостю!');
    expect(sent()[0].text).not.toContain('Олена');
    const texts = buttons(sent()[0].markup).map((b: any) => b.text);
    expect(texts).toContain('🎾 Забронювати');
    expect(texts).not.toContain('👤 Мій профіль');
    expect(buttons(sent()[0].markup).some((b: any) => b.callback_data === 'plogin:squash')).toBe(true);
  });

  it('чат без карток — гостьова головна з кнопкою входу', async () => {
    await say('/start club_squash');
    expect(sent()[0].text).toContain('Вітаємо, гостю!');
    expect(buttons(sent()[0].markup).some((b: any) => b.callback_data === 'plogin:squash')).toBe(true);
    expect(allText()).not.toContain('Оберіть клуб');
  });

  it('невідомий клуб — пояснення і список', async () => {
    await say('/start club_nope');
    expect(allText()).toContain('Цей клуб не знайдено');
    expect(allText()).toContain('Оберіть клуб');
  });
});

describe('згода на акції: mk:yes / mk:no', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  beforeEach(() => { cards = [card({ id: ID })]; });

  it('mk:yes зі СВОГО чату записує згоду й редагує повідомлення', async () => {
    await tap(`mk:yes:${ID}`);
    expect(cards[0].tgMarketingAt).toBeInstanceOf(Date);
    expect(tg.editMessageText).toHaveBeenCalledTimes(1);
    expect(String(tg.editMessageText.mock.calls[0][2])).toContain('Дякуємо');
    expect(tg.answerCallback).toHaveBeenCalledWith('cb-1', 'Готово');
  });

  it('mk:no знімає згоду', async () => {
    cards[0].tgMarketingAt = new Date();
    await tap(`mk:no:${ID}`);
    expect(cards[0].tgMarketingAt).toBeNull();
    expect(prisma.customer.update).toHaveBeenCalled();
  });

  it('mk:yes з ЧУЖОГО чату нічого не змінює', async () => {
    await tap(`mk:yes:${ID}`, 777);
    expect(cards[0].tgMarketingAt).toBeNull();
    expect(prisma.customer.update).not.toHaveBeenCalled();
    expect(tg.editMessageText).not.toHaveBeenCalled();
    expect(tg.answerCallback).toHaveBeenCalledWith('cb-1', 'Цей запис вам недоступний');
  });

  it('неіснуюча картка відповідає так само, як чужа', async () => {
    await tap('mk:yes:99999999-9999-4999-8999-999999999999');
    expect(tg.answerCallback).toHaveBeenCalledWith('cb-1', 'Цей запис вам недоступний');
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });

  it('кнопка з неправильним id не розбирається як згода', async () => {
    await tap('mk:yes:not-a-uuid');
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });
});

describe('відписка від листа повернення: wb:off', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  beforeEach(() => { cards = [card({ id: ID, tgMarketingAt: new Date() })]; });

  it('зі свого чату знімає згоду', async () => {
    await tap(`wb:off:${ID}`);
    expect(cards[0].tgMarketingAt).toBeNull();
    expect(String(tg.editMessageText.mock.calls[0][2])).toContain('більше не буде');
    expect(tg.answerCallback).toHaveBeenCalledWith('cb-1', 'Вимкнено');
  });

  it('з чужого чату — ні', async () => {
    await tap(`wb:off:${ID}`, 777);
    expect(cards[0].tgMarketingAt).toBeInstanceOf(Date);
    expect(prisma.customer.update).not.toHaveBeenCalled();
    expect(tg.answerCallback).toHaveBeenCalledWith('cb-1', 'Цей запис вам недоступний');
  });

  it('відписка працює й для людини з персоналу (до перевірки ролі)', async () => {
    staff = { id: 'u1', role: 'OWNER', trainerId: null, club: { id: 'club-a', name: 'S', timezone: 'Europe/Kyiv', plan: PLAN3 } };
    await tap(`wb:off:${ID}`);
    expect(cards[0].tgMarketingAt).toBeNull();
  });
});

describe('кнопки головної: home:my, home:clubs, homeclub:<slug>', () => {
  beforeEach(() => {
    cards = [
      card({ id: 'a1a1a1a1-1111-4111-8111-111111111111', clubId: 'club-a' }),
      card({ id: 'b2b2b2b2-2222-4222-8222-222222222222', clubId: 'club-b' }),
    ];
  });

  it('home:my показує записи так, як /my', async () => {
    await tap('home:my');
    expect(allText()).toContain('записів немає');
    expect(tg.answerCallback).toHaveBeenCalled();
  });

  it('home:clubs — лише клуби цього чату', async () => {
    await tap('home:clubs');
    const b = buttons(sent()[0].markup).map((x: any) => x.callback_data);
    expect(b).toEqual(['homeclub:squash', 'homeclub:padel']);
    expect(prisma.club.findMany).not.toHaveBeenCalled();
  });

  it('homeclub:<slug> відкриває головну цього клубу', async () => {
    await tap('homeclub:padel');
    expect(sent()[0].text).toContain('Padel Club');
    expect(sent()[0].text).toContain('Вітаємо, Олена!');
  });

  it('homeclub чужого клубу — відмова', async () => {
    await tap('homeclub:basic');
    expect(sent()).toHaveLength(0);
    expect(tg.answerCallback).toHaveBeenCalledWith('cb-1', 'Цей клуб вам недоступний');
  });

  it('home:clubs без карток — «Клубів немає»', async () => {
    cards = [];
    await tap('home:clubs');
    expect(tg.answerCallback).toHaveBeenCalledWith('cb-1', 'Клубів немає');
  });
});
