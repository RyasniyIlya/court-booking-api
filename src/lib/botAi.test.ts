import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Вільний текст у приватному чаті → ІІ (етап 5).
 *
 * Йде справжній ланцюг handleUpdate → botAi → aiTelegram/chatContext; мокається
 * лише те, що ходить назовні: база (маленькі «таблиці»), Telegram, модель і
 * лічильник добового ліміту (його SQL перевіряє quota.test.ts на PGlite).
 */

type Row = Record<string, any>;

const PLAN_AI = { tier: 3, featTrainers: true, featGroups: true, featAnalytics: true };
const PLAN_NO_AI = { tier: 2, featTrainers: true, featGroups: true, featAnalytics: false };
const CLUB_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const CLUB_B = '22222222-bbbb-4bbb-8bbb-222222222222';
const CARD_A = 'c0000000-0000-4000-8000-00000000000a';
const CARD_B = 'c0000000-0000-4000-8000-00000000000b';
const CHAT = 777;

const state = vi.hoisted(() => ({
  staff: null as Row | null,
  cards: [] as Row[],
  clubs: {} as Record<string, Row>,
  turns: [] as Row[],
  policy: { bookings: 'ASK' } as Row,
  quotaCalls: [] as Array<{ scope: string; clubId: string; limit: number; timezone?: string }>,
  quotaDeny: new Set<string>(),
  configured: true,
}));

const prisma = {
  user: {
    findUnique: vi.fn(async () => state.staff),
    findUniqueOrThrow: vi.fn(async () => ({ tgNotifyBookings: true, tgNotifyTournaments: true, tgNotifyGroups: true, tgNotifySessions: true, tgRemindMinutes: 60 })),
  },
  tgDialog: { findUnique: vi.fn(async () => null) },
  club: {
    findUnique: vi.fn(async ({ where }: any) => state.clubs[where.id] ?? null),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
  },
  customer: {
    findMany: vi.fn(async ({ where }: any) => state.cards
      .filter((c) => c.telegramChatId === where.telegramChatId)
      .map((c) => ({ ...c, club: state.clubs[c.clubId] }))),
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => null),
    update: vi.fn(async () => ({})),
  },
  aiChatTurn: {
    createMany: vi.fn(async ({ data }: any) => { state.turns.push(...data.map((d: Row) => ({ ...d }))); return { count: data.length }; }),
    findMany: vi.fn(async ({ where, orderBy, take }: any) => {
      const rows = state.turns
        .filter((t) => t.chatId === where.chatId && t.clubId === where.clubId && t.mode === where.mode && t.createdAt > where.createdAt.gt)
        .sort((a, b) => (orderBy.createdAt === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt));
      return rows.slice(0, take).map((r) => ({ role: r.role, content: r.content }));
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      const before = state.turns.length;
      state.turns = state.turns.filter((t) => !(t.chatId === where.chatId));
      return { count: before - state.turns.length };
    }),
  },
  promo: { findMany: vi.fn(async () => []) },
  trainer: { findMany: vi.fn(async () => []) },
  booking: { findMany: vi.fn(async () => []) },
  bookingSeat: { findMany: vi.fn(async () => []) },
};

const tg = {
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  sendChatAction: vi.fn(async () => true),
  editMessageText: vi.fn(),
  answerCallback: vi.fn(),
};
const ai = vi.hoisted(() => ({ owner: vi.fn(), client: vi.fn(), alert: vi.fn() }));

vi.mock('./db', () => ({ prisma }));
vi.mock('./telegram', () => ({
  ...tg,
  deleteMessage: vi.fn(),
  setMyCommands: vi.fn(),
  botReady: () => true,
}));
vi.mock('./botAnalytics', () => ({ botAnalytics: vi.fn() }));
vi.mock('./botAuth', () => ({ loginByPassword: vi.fn(), logout: vi.fn(), menuFor: () => 'MENU', }));
vi.mock('./botPassword', () => ({ changePassword: vi.fn(), parseNewPassword: vi.fn(), requestReset: vi.fn() }));
vi.mock('./digest', () => ({ dayDigest: vi.fn(), digestText: vi.fn(), WEEKDAY_FULL: [], weekReport: vi.fn(), weekText: vi.fn() }));
vi.mock('./sections', () => ({ revenueBreakdown: vi.fn(), revenueText: vi.fn(), staffReport: vi.fn(), staffText: vi.fn() }));
vi.mock('./ai/ownerAssistant', () => ({ ownerAssistant: ai.owner, BRIEF_REQUEST: 'brief' }));
vi.mock('./ai/clientAssistant', () => ({ clientAssistant: ai.client }));
vi.mock('./ai/playerContext', () => ({ loadPlayerProfile: vi.fn(async () => null) }));
vi.mock('./ai/executors', () => ({}));
vi.mock('./ai/gemini', async (orig) => ({ ...(await orig<typeof import('./ai/gemini')>()), aiConfigured: () => state.configured }));
vi.mock('./ai/policyStore', () => ({ loadPolicy: vi.fn(async () => state.policy) }));
vi.mock('./ai/quota', async (orig) => ({
  ...(await orig<typeof import('./ai/quota')>()),
  takeQuota: vi.fn(async (scope: string, clubId: string, limit: number, opts: { timezone?: string } = {}) => {
    state.quotaCalls.push({ scope, clubId, limit, timezone: opts.timezone });
    return !state.quotaDeny.has(scope);
  }),
}));
vi.mock('./aiTelegram', async (orig) => ({ ...(await orig<typeof import('./aiTelegram')>()), queueActionAlert: ai.alert }));

const { handleUpdate } = await import('./botHandlers');
const { settleAiTasks, resetAiGuard, UNKNOWN_HINT, FLOOD_MS } = await import('./botAi');
const { loadContext, resetContext } = await import('./ai/chatContext');
const { takeQuota } = await import('./ai/quota');

const club = (id: string, over: Row = {}) => ({
  id, slug: id === CLUB_A ? 'squash' : 'padel', name: id === CLUB_A ? 'Squash Arena' : 'Padel Club',
  timezone: 'Europe/Kyiv', address: 'вул. Київська, 1', phone: null, botSettings: { aiChat: { staff: true, players: true } },
  plan: PLAN_AI, ...over,
});
const staffUser = (role: string, clubOver: Row = {}) => ({
  id: 'u-1', role, trainerId: null, tgNotifyBookings: true,
  club: { id: CLUB_A, name: 'Squash Arena', timezone: 'Europe/Kyiv', plan: PLAN_AI, ...clubOver },
});
const card = (id: string, clubId: string, over: Row = {}) => ({
  id, name: 'Олена', clubId, telegramChatId: String(CHAT), tgLastActiveAt: null, createdAt: new Date('2026-01-01'), ...over,
});

const say = (text: string, chat = CHAT, type = 'private') => handleUpdate({
  update_id: 1,
  message: { message_id: 1, from: { id: chat }, chat: { id: chat, type }, text },
});
/** Повідомлення + дочекатись фонової відповіді моделі */
const sayAndWait = async (text: string, chat = CHAT, type = 'private') => { await say(text, chat, type); await settleAiTasks(); };

const sent = () => tg.sendMessage.mock.calls.map((c) => ({ chat: c[0], text: String(c[1]), markup: c[2] as any }));
const allText = () => sent().map((m) => m.text).join('\n---\n');
const buttons = (markup: any) => (markup?.inline_keyboard ?? []).flat();

const pendingAction = (id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') => ({ id, kind: 'booking.create', summary: 'Бронь «Корт 1»', status: 'PENDING', error: null });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  process.env.PUBLIC_WEB_URL = 'https://club.example';
  state.staff = null;
  state.cards = [];
  state.clubs = { [CLUB_A]: club(CLUB_A), [CLUB_B]: club(CLUB_B) };
  state.turns = [];
  state.policy = { bookings: 'ASK', roleAccess: {} };
  state.quotaCalls = [];
  state.quotaDeny.clear();
  state.configured = true;
  resetAiGuard();
  ai.owner.mockResolvedValue({ reply: 'Вчора було 12 броней.', steps: 1, tokens: 10, actions: [] });
  ai.client.mockResolvedValue({ reply: 'У клубі 3 корти.', steps: 1, tokens: 10, actions: [] });
});

afterEach(async () => { await settleAiTasks(); });

describe('маршрутизація: пріоритет за існуючими обробниками', () => {
  beforeEach(() => { state.staff = staffUser('OWNER'); });

  it('команда не йде до ІІ', async () => {
    await sayAndWait('/settings');
    expect(ai.owner).not.toHaveBeenCalled();
    expect(takeQuota).not.toHaveBeenCalled();
  });

  it('невідома команда — як і раніше «Не знаю такої команди», без ІІ', async () => {
    await sayAndWait('/foobar');
    expect(allText()).toContain('Не знаю такої команди');
    expect(ai.owner).not.toHaveBeenCalled();
  });

  it('підпис кнопки клавіатури перетворюється на команду й не йде до ІІ', async () => {
    await sayAndWait('⚙️ Сповіщення');
    expect(ai.owner).not.toHaveBeenCalled();
    expect(takeQuota).not.toHaveBeenCalled();
  });

  it('покроковий вхід гравця має пріоритет: текст, який він забрав, до ІІ не доходить', async () => {
    state.staff = null;
    prisma.tgDialog.findUnique.mockResolvedValueOnce({ chatId: String(CHAT), step: 'x', data: {}, expiresAt: new Date(Date.now() + 60_000) } as any);
    await sayAndWait('+380671234567');
    expect(ai.owner).not.toHaveBeenCalled();
    expect(ai.client).not.toHaveBeenCalled();
  });

  it('у групі — нічого: ні відповіді, ні ІІ', async () => {
    await sayAndWait('привіт, що по бронях?', -100500, 'supergroup');
    expect(tg.sendMessage).not.toHaveBeenCalled();
    expect(ai.owner).not.toHaveBeenCalled();
  });

  it('вільний текст чужого чату — підказка про вхід, без ІІ і без ліміту', async () => {
    state.staff = null;
    await sayAndWait('привіт');
    expect(allText()).toBe(UNKNOWN_HINT);
    expect(ai.owner).not.toHaveBeenCalled();
    expect(ai.client).not.toHaveBeenCalled();
    expect(takeQuota).not.toHaveBeenCalled();
  });

  it('невідома КОМАНДА чужого чату — довідка, як і раніше', async () => {
    state.staff = null;
    await sayAndWait('/whatever');
    expect(allText()).toContain('Бот вашого клубу');
  });
});

describe('персонал → ІІ-менеджер', () => {
  it('власник: відповідь екранується, права й роль передаються, ліміт — спільний із кабінетом', async () => {
    state.staff = staffUser('OWNER');
    ai.owner.mockResolvedValue({ reply: 'Виручка <b>зросла</b> & так', steps: 2, tokens: 5, actions: [] });
    await sayAndWait('як справи?');

    expect(ai.owner).toHaveBeenCalledTimes(1);
    const args = ai.owner.mock.calls[0][0];
    expect(args.role).toBe('OWNER');
    expect(args.perms.access).toBe(true);
    expect(args.manager.requester).toEqual({ id: 'u-1', role: 'OWNER' });
    expect(args.manager.maxProposals).toBe(5);
    expect(args.messages).toEqual([{ role: 'user', content: 'як справи?' }]);

    expect(state.quotaCalls).toEqual([{ scope: 'owner', clubId: CLUB_A, limit: 100, timezone: 'Europe/Kyiv' }]);
    expect(allText()).toContain('Виручка &lt;b&gt;зросла&lt;/b&gt; &amp; так');
    expect(allText()).not.toContain('<b>зросла');
    expect(tg.sendChatAction).toHaveBeenCalledWith(String(CHAT));
  });

  it.each([
    ['тариф без ІІ', () => { state.staff = staffUser('OWNER', { plan: PLAN_NO_AI }); }],
    ['немає ключа Gemini', () => { state.configured = false; }],
    ['вмикач персоналу вимкнено', () => { state.clubs[CLUB_A] = club(CLUB_A, { botSettings: { aiChat: { staff: false, players: false } } }); }],
    ['роль без доступу за політикою', () => { state.staff = staffUser('TRAINER'); }],
  ])('%s → фіксована відповідь, модель і ліміт не чіпаються', async (_name, arrange) => {
    state.staff = staffUser('OWNER');
    arrange();
    await sayAndWait('скільки броней?');
    expect(ai.owner).not.toHaveBeenCalled();
    expect(takeQuota).not.toHaveBeenCalled();
    expect(allText()).toContain('MENU');
  });

  it('вичерпаний добовий ліміт → повідомлення, модель не викликається', async () => {
    state.staff = staffUser('OWNER');
    state.quotaDeny.add('owner');
    await sayAndWait('скільки броней?');
    expect(ai.owner).not.toHaveBeenCalled();
    expect(allText()).toContain('Добовий ліміт');
  });

  it('збій моделі → коротке повідомлення без сирої помилки; чат відпущено', async () => {
    state.staff = staffUser('OWNER');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    ai.owner.mockRejectedValueOnce(new Error('secret upstream: api-key=XYZ'));
    await sayAndWait('питання');
    expect(allText()).toContain('Не вдалося отримати відповідь');
    expect(allText()).not.toContain('XYZ');
    expect(err.mock.calls.flat().join(' ')).not.toContain('XYZ');
    err.mockRestore();
  });

  it('PENDING для власника — кнопки «Підтвердити / Відхилити» ai:ok / ai:no', async () => {
    state.staff = staffUser('OWNER');
    ai.owner.mockResolvedValue({ reply: 'Пропоную бронь.', steps: 1, tokens: 1, actions: [pendingAction()] });
    await sayAndWait('забронюй корт 1');
    const withKb = sent().find((m) => buttons(m.markup).length);
    expect(withKb).toBeTruthy();
    expect(buttons(withKb!.markup).map((b: any) => b.callback_data)).toEqual([
      'ai:ok:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ai:no:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ]);
    expect(ai.alert).not.toHaveBeenCalled();
  });

  it('PENDING від адміністратора — без кнопок, «передано власнику» і сповіщення власнику', async () => {
    state.staff = staffUser('ADMIN');
    state.policy = { bookings: 'ASK', roleAccess: { ADMIN: { enabled: true } } };
    ai.owner.mockResolvedValue({ reply: 'Пропоную бронь.', steps: 1, tokens: 1, actions: [pendingAction()] });
    await sayAndWait('забронюй корт 1');

    expect(ai.owner).toHaveBeenCalledTimes(1);
    expect(ai.owner.mock.calls[0][0].role).toBe('ADMIN');
    expect(sent().some((m) => buttons(m.markup).some((b: any) => String(b.callback_data).startsWith('ai:')))).toBe(false);
    expect(allText()).toContain('передано власнику');
    expect(ai.alert).toHaveBeenCalledWith(CLUB_A, 'ADMIN', [expect.objectContaining({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })]);
  });
});

describe('гравець → помічник клубу', () => {
  beforeEach(() => { state.cards = [card(CARD_A, CLUB_A)]; });

  it('вмикач гравців вимкнено (типово) → фіксована відповідь, без моделі', async () => {
    state.clubs[CLUB_A] = club(CLUB_A, { botSettings: {} });
    await sayAndWait('які ціни?');
    expect(ai.client).not.toHaveBeenCalled();
    expect(takeQuota).not.toHaveBeenCalled();
    expect(allText()).toContain('/book');
  });

  it.each([
    ['тариф без ІІ', () => { state.clubs[CLUB_A] = club(CLUB_A, { plan: PLAN_NO_AI }); }],
    ['немає ключа', () => { state.configured = false; }],
  ])('%s → модель не викликається', async (_n, arrange) => {
    arrange();
    await sayAndWait('які ціни?');
    expect(ai.client).not.toHaveBeenCalled();
    expect(takeQuota).not.toHaveBeenCalled();
  });

  it('вмикач ввімкнено → clientAssistant, а не менеджер; два ліміти: гравця й клубу', async () => {
    await sayAndWait('які ціни?');
    expect(ai.owner).not.toHaveBeenCalled();
    expect(ai.client).toHaveBeenCalledTimes(1);
    const args = ai.client.mock.calls[0][0];
    expect(args).toMatchObject({ slug: 'squash', clubName: 'Squash Arena', channel: 'telegram' });
    expect(args.messages).toEqual([{ role: 'user', content: 'які ціни?' }]);
    expect(state.quotaCalls.map((c) => [c.scope, c.limit])).toEqual([[`bot:player:${CARD_A}`, 20], ['client', 300]]);
    expect(allText()).toContain('У клубі 3 корти.');
  });

  it('AI_BOT_PLAYER_DAILY змінює ліміт гравця', async () => {
    process.env.AI_BOT_PLAYER_DAILY = '5';
    await sayAndWait('привіт');
    delete process.env.AI_BOT_PLAYER_DAILY;
    expect(state.quotaCalls[0]).toMatchObject({ scope: `bot:player:${CARD_A}`, limit: 5 });
  });

  it('ліміт гравця вичерпано → модель не викликається, ліміт клубу не чіпається', async () => {
    state.quotaDeny.add(`bot:player:${CARD_A}`);
    await sayAndWait('ще питання');
    expect(ai.client).not.toHaveBeenCalled();
    expect(state.quotaCalls.map((c) => c.scope)).toEqual([`bot:player:${CARD_A}`]);
    expect(allText()).toContain('ліміт');
  });

  it('кілька клубів: береться той, де гравець був останнім', async () => {
    state.cards = [
      card(CARD_A, CLUB_A, { tgLastActiveAt: new Date('2026-10-01') }),
      card(CARD_B, CLUB_B, { tgLastActiveAt: new Date('2026-10-10') }),
    ];
    await sayAndWait('які ціни?');
    expect(ai.client.mock.calls[0][0]).toMatchObject({ slug: 'padel', clubName: 'Padel Club' });
    expect(state.quotaCalls[0].scope).toBe(`bot:player:${CARD_B}`);
  });

  it('модель підібрала слот: бронь НЕ створюється, є лише кнопка на розклад клубу з поясненням', async () => {
    ai.client.mockResolvedValue({
      reply: 'Є вільний час о 18:00.', steps: 1, tokens: 1,
      actions: [{ type: 'book_slot', courtId: 'x', courtName: 'Корт <1>', date: '2026-10-20', time: '18:00', start: 's', end: 'e' }],
    });
    await sayAndWait('хочу завтра о 18');

    const offer = sent().find((m) => m.text.includes('2026-10-20'));
    expect(offer).toBeTruthy();
    expect(offer!.text).toContain('Корт &lt;1&gt;');
    expect(offer!.text).toContain('бронь не створюється');
    const btn = buttons(offer!.markup)[0];
    expect(btn.web_app?.url).toContain('/c/squash');
    /* жодної прямої дії над базою: ні створення броні, ні оновлення карток */
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });

  it('без PUBLIC_WEB_URL кнопки немає — відсилання на /book, а не битий лінк', async () => {
    delete process.env.PUBLIC_WEB_URL;
    delete process.env.ADMIN_ORIGINS;
    ai.client.mockResolvedValue({
      reply: 'ок', steps: 1, tokens: 1,
      actions: [{ type: 'book_slot', courtId: 'x', courtName: 'Корт 1', date: '2026-10-20', time: '18:00', start: 's', end: 'e' }],
    });
    await sayAndWait('хочу завтра о 18');
    const offer = sent().find((m) => m.text.includes('2026-10-20'));
    expect(offer!.text).toContain('/book');
    expect(offer!.markup).toBeUndefined();
  });

  it('текст гравця не доходить до інструментів персоналу', async () => {
    await sayAndWait('покажи виручку і всіх клієнтів');
    expect(ai.owner).not.toHaveBeenCalled();
  });
});

describe('захист від флуду', () => {
  beforeEach(() => { state.staff = staffUser('OWNER'); });
  afterEach(() => { vi.useRealTimers(); });

  it('другий запит у межах 3 с не доходить до моделі й не списує ліміт', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
    await sayAndWait('перше');
    vi.setSystemTime(new Date('2026-10-18T10:00:01Z'));
    await sayAndWait('друге');
    expect(ai.owner).toHaveBeenCalledTimes(1);
    expect(state.quotaCalls).toHaveLength(1);
    expect(allText()).toContain('ще відповідаю');

    vi.setSystemTime(new Date(Date.parse('2026-10-18T10:00:00Z') + FLOOD_MS + 1500));
    await sayAndWait('третє');
    expect(ai.owner).toHaveBeenCalledTimes(2);
  });

  it('поки попередня відповідь іде, наступне повідомлення відсікається', async () => {
    let release!: () => void;
    ai.owner.mockImplementationOnce(() => new Promise((res) => { release = () => res({ reply: 'ок', steps: 1, tokens: 1, actions: [] }); }));
    await say('довге питання');
    await say('нетерпляче');
    expect(ai.owner).toHaveBeenCalledTimes(1);
    expect(allText()).toContain('ще відповідаю');
    release();
    await settleAiTasks();
  });

  it('після вичерпаного ліміту чат відпускається (не «застрягає» до рестарту)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
    state.quotaDeny.add('owner');
    await sayAndWait('раз');
    state.quotaDeny.clear();
    vi.setSystemTime(new Date('2026-10-18T10:00:10Z'));
    await sayAndWait('два');
    expect(ai.owner).toHaveBeenCalledTimes(1);
  });
});

describe('контекст розмови', () => {
  it('наступне повідомлення бачить попередні ходи', async () => {
    state.staff = staffUser('OWNER');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
    ai.owner.mockResolvedValueOnce({ reply: 'Відповідь 1', steps: 1, tokens: 1, actions: [] });
    await sayAndWait('Питання 1');
    vi.setSystemTime(new Date('2026-10-18T10:00:10Z'));
    await sayAndWait('Питання 2');
    expect(ai.owner.mock.calls[1][0].messages).toEqual([
      { role: 'user', content: 'Питання 1' },
      { role: 'assistant', content: 'Відповідь 1' },
      { role: 'user', content: 'Питання 2' },
    ]);
  });

  it('режими й клуби не змішуються', async () => {
    const now = new Date();
    const { saveTurn } = await import('./ai/chatContext');
    await saveTurn('1', CLUB_A, 'staff', 'секрет персоналу', 'відповідь персоналу', now);
    await saveTurn('1', CLUB_A, 'player', 'питання гравця', 'відповідь гравцю', now);
    await saveTurn('1', CLUB_B, 'player', 'інший клуб', 'інша відповідь', now);

    expect((await loadContext('1', CLUB_A, 'player')).map((m) => m.content)).toEqual(['питання гравця', 'відповідь гравцю']);
    expect((await loadContext('1', CLUB_A, 'staff')).map((m) => m.content)).toEqual(['секрет персоналу', 'відповідь персоналу']);
    expect((await loadContext('1', CLUB_B, 'player')).map((m) => m.content)).toEqual(['інший клуб', 'інша відповідь']);
    expect(await loadContext('2', CLUB_A, 'staff')).toEqual([]);
  });

  it('старше за добу не повертається; не більше 10 ходів; починається з питання', async () => {
    const { saveTurn } = await import('./ai/chatContext');
    const now = new Date('2026-10-18T12:00:00Z');
    await saveTurn('1', CLUB_A, 'staff', 'давно', 'давно-відповідь', new Date(now.getTime() - 25 * 3600_000));
    for (let i = 0; i < 12; i++) await saveTurn('1', CLUB_A, 'staff', `q${i}`, `a${i}`, new Date(now.getTime() - (12 - i) * 60_000));
    const ctx = await loadContext('1', CLUB_A, 'staff', now);
    expect(ctx).toHaveLength(20);
    expect(ctx[0]).toEqual({ role: 'user', content: 'q2' });
    expect(ctx.at(-1)).toEqual({ role: 'assistant', content: 'a11' });
  });

  it('довгі тексти обрізаються до 2000 символів', async () => {
    const { saveTurn } = await import('./ai/chatContext');
    await saveTurn('1', CLUB_A, 'staff', 'x'.repeat(5000), 'y'.repeat(5000), new Date());
    expect(state.turns.every((t) => t.content.length === 2000)).toBe(true);
  });

  it('/start, /logout і зміна клубу скидають контекст', async () => {
    const { saveTurn } = await import('./ai/chatContext');
    state.staff = staffUser('OWNER');
    await saveTurn(String(CHAT), CLUB_A, 'staff', 'q', 'a', new Date());
    await say('/start');
    expect(state.turns).toHaveLength(0);

    await saveTurn(String(CHAT), CLUB_A, 'staff', 'q', 'a', new Date());
    await say('/logout');
    expect(state.turns).toHaveLength(0);

    await saveTurn(String(CHAT), CLUB_A, 'player', 'q', 'a', new Date());
    await handleUpdate({
      update_id: 3,
      callback_query: { id: 'cb', data: 'homeclub:padel', message: { message_id: 7, chat: { id: CHAT } }, from: { id: CHAT } },
    });
    expect(state.turns).toHaveLength(0);
  });

  it('скидання не падає, якщо база недоступна', async () => {
    prisma.aiChatTurn.deleteMany.mockRejectedValueOnce(new Error('db'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(resetContext('1')).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('довгі й небезпечні відповіді', () => {
  it('відповідь > 4096 розбивається на частини ≤ ліміту; розмітку моделі екрановано', async () => {
    state.staff = staffUser('OWNER');
    const para = `<script>alert(1)</script> & ${'слово '.repeat(60)}`;
    ai.owner.mockResolvedValue({ reply: Array.from({ length: 40 }, () => para).join('\n'), steps: 1, tokens: 1, actions: [] });
    await sayAndWait('дай все');
    const parts = sent().map((m) => m.text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join('')).not.toContain('<script>');
    expect(parts.join('')).toContain('&lt;script&gt;');
  });

  it('занадто довге повідомлення від людини відхиляється без моделі', async () => {
    state.staff = staffUser('OWNER');
    await sayAndWait('x'.repeat(2001));
    expect(ai.owner).not.toHaveBeenCalled();
    expect(takeQuota).not.toHaveBeenCalled();
    expect(allText()).toContain('задовге');
  });
});

describe('кнопки рішення — лише власник', () => {
  const tapAi = (data: string) => handleUpdate({
    update_id: 9,
    callback_query: { id: 'cb-ai', data, message: { message_id: 5, chat: { id: CHAT } }, from: { id: CHAT } },
  });

  it('адміністратор, який натиснув ai:ok із пересланого повідомлення, отримує відмову', async () => {
    state.staff = { ...staffUser('ADMIN'), club: { id: CLUB_A, plan: PLAN_AI } };
    await tapAi('ai:ok:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(tg.answerCallback).toHaveBeenCalledWith('cb-ai', expect.stringContaining('лише власник'));
    expect(prisma.aiChatTurn.createMany).not.toHaveBeenCalled();
  });
});
