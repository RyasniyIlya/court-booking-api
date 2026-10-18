import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Налаштування бота клубу в кабінеті: читання, збереження, превʼю.
 *
 * Головне тут — межі: хто може (тільки власник), на якому тарифі можна
 * зберегти, і що в збережене не потрапляє чужий клуб.
 */

const prisma = {
  club: { findUnique: vi.fn() },
  $executeRaw: vi.fn(),
  promo: { findMany: vi.fn() },
  trainer: { findMany: vi.fn() },
  customer: { count: vi.fn() },
};
const countWinbackEligible = vi.fn();
const loadClubContent = vi.fn();
let botIsReady = true;

vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('../../lib/telegram', () => ({ botReady: () => botIsReady }));
vi.mock('../../lib/winback', () => ({ countWinbackEligible }));
vi.mock('../../lib/playerHome', () => ({ loadClubContent }));
vi.mock('./shared', async () => {
  const actual = await vi.importActual<typeof import('./shared')>('./shared');
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.auth = {
        userId: 'u-1',
        clubId: 'club-1',
        role: String(req.headers['x-role'] ?? 'OWNER'),
        trainerId: null,
      };
      next();
    },
  };
});

const { botSettingsRouter } = await import('./botSettings');
const { defaultBotSettings } = await import('../../lib/clubBot');

const app = express().use(express.json()).use('/api/admin', botSettingsRouter);

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '99999999-9999-4999-8999-999999999999';
const T1 = '33333333-3333-4333-8333-333333333333';

const PLAN3 = { tier: 3, featTrainers: true, featGroups: true, featAnalytics: true };
const PLAN1 = { tier: 1, featTrainers: false, featGroups: false, featAnalytics: false };
const clubRow = (over: Record<string, unknown> = {}) => ({
  name: 'Squash', slug: 'squash', address: 'вул. Київська, 1', phone: '+380671112233',
  timezone: 'Europe/Kyiv', botSettings: {}, plan: PLAN3, ...over,
});

const promoRow = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: 'Ранок', kind: 'WEEKLY', weekdays: [1, 2, 3, 4, 5], dateFrom: null, dateTo: null,
  startMinute: 420, endMinute: 720, discountType: 'PERCENT', discountValue: 20, isActive: true, ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  botIsReady = true;
  process.env.TELEGRAM_BOT_USERNAME = 'kort_bot';
  prisma.club.findUnique.mockResolvedValue(clubRow());
  prisma.$executeRaw.mockResolvedValue(1);
  prisma.promo.findMany.mockResolvedValue([]);
  prisma.trainer.findMany.mockResolvedValue([]);
  prisma.customer.count.mockResolvedValue(0);
  countWinbackEligible.mockResolvedValue(0);
});

describe('доступ', () => {
  it.each(['ADMIN', 'TRAINER', 'ACCOUNTANT'])('%s не має доступу ні до чого', async (role) => {
    expect((await request(app).get('/api/admin/bot-settings').set('x-role', role)).status).toBe(403);
    expect((await request(app).put('/api/admin/bot-settings').set('x-role', role).send(defaultBotSettings())).status).toBe(403);
    expect((await request(app).post('/api/admin/bot-settings/preview').set('x-role', role)
      .send({ settings: defaultBotSettings(), kind: 'home' })).status).toBe(403);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('GET /bot-settings', () => {
  it('віддає налаштування, довідники й статистику в узгодженій формі', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow({ botSettings: { displayName: 'Арена', promoIds: [P1] } }));
    prisma.promo.findMany.mockResolvedValue([promoRow(P1), promoRow(P2, { title: 'Старе', isActive: false, discountType: 'PRICE', discountValue: 25000 })]);
    prisma.trainer.findMany.mockResolvedValue([
      {
        id: T1, name: 'Анна', isActive: true,
        hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, openMinute: 600, closeMinute: 1080, isClosed: false })),
        exceptions: [],
      },
      { id: 'tr-2', name: 'Віктор', isActive: false, hours: [], exceptions: [] },
      { id: 'tr-3', name: 'Без графіка', isActive: true, hours: [], exceptions: [] },
    ]);
    prisma.customer.count.mockResolvedValueOnce(12).mockResolvedValueOnce(7);
    countWinbackEligible.mockResolvedValue(3);

    const res = await request(app).get('/api/admin/bot-settings');

    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ displayName: 'Арена', promoIds: [P1], showAddress: true });
    expect(res.body).toMatchObject({
      planAllows: true,
      botReady: true,
      botUsername: 'kort_bot',
      clubLink: 'https://t.me/kort_bot?start=club_squash',
      club: { name: 'Squash', slug: 'squash', address: 'вул. Київська, 1', phone: '+380671112233' },
      promos: [
        { id: P1, title: 'Ранок', summary: '−20% · пн–пт · 07:00–12:00', isActive: true },
        { id: P2, title: 'Старе', summary: '250 грн/год · пн–пт · 07:00–12:00', isActive: false },
      ],
      stats: { linkedPlayers: 12, marketingOk: 7, winbackEligible: 3 },
    });
    expect(res.body.trainers).toEqual([
      { id: T1, name: 'Анна', isActive: true, today: '10:00–18:00' },
      { id: 'tr-2', name: 'Віктор', isActive: false, today: null },
      { id: 'tr-3', name: 'Без графіка', isActive: true, today: null },
    ]);
  });

  it('налаштування клубу обмежені clubId із токена', async () => {
    await request(app).get('/api/admin/bot-settings');
    expect(prisma.club.findUnique.mock.calls[0][0].where).toEqual({ id: 'club-1' });
    expect(prisma.promo.findMany.mock.calls[0][0].where).toEqual({ clubId: 'club-1' });
    expect(prisma.trainer.findMany.mock.calls[0][0].where).toEqual({ clubId: 'club-1' });
    expect(prisma.customer.count.mock.calls.every((c) => c[0].where.clubId === 'club-1')).toBe(true);
  });

  it('клуб без плану: читання працює, planAllows=false, analyticsAllowed=false', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow({ plan: null }));
    const res = await request(app).get('/api/admin/bot-settings');
    expect(res.status).toBe(200);
    expect(res.body.planAllows).toBe(false);
    expect(res.body.analyticsAllowed).toBe(false);
  });

  it('«Броні» (tier 1): Telegram є, аналітики в Telegram немає', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow({ plan: PLAN1 }));
    const res = await request(app).get('/api/admin/bot-settings');
    expect(res.body).toMatchObject({ planAllows: true, analyticsAllowed: false });
    expect(res.body.aiAllowed).toBe(false);
  });

  it('«Аналітика» (tier 3): analyticsAllowed=true', async () => {
    const res = await request(app).get('/api/admin/bot-settings');
    expect(res.body).toMatchObject({ planAllows: true, analyticsAllowed: true });
    expect(res.body.aiAllowed).toBe(true);
  });

  it('бот не підключений: botReady=false, clubLink=null', async () => {
    botIsReady = false;
    const res = await request(app).get('/api/admin/bot-settings');
    expect(res.body).toMatchObject({ botReady: false, botUsername: 'kort_bot' });

    botIsReady = true;
    delete process.env.TELEGRAM_BOT_USERNAME;
    const res2 = await request(app).get('/api/admin/bot-settings');
    expect(res2.body).toMatchObject({ botReady: false, botUsername: null, clubLink: null });
  });

  it('зіпсовані налаштування в базі не ламають відповідь', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow({ botSettings: 'сміття' }));
    const res = await request(app).get('/api/admin/bot-settings');
    expect(res.body.settings).toEqual(defaultBotSettings());
  });

  it('клуб не знайдено — 404', async () => {
    prisma.club.findUnique.mockResolvedValue(null);
    expect((await request(app).get('/api/admin/bot-settings')).status).toBe(404);
  });
});

describe('PUT /bot-settings', () => {
  const body = (over: Record<string, unknown> = {}) => ({ ...defaultBotSettings(), ...over });

  it('зберігає нормалізовані налаштування й віддає їх', async () => {
    const res = await request(app).put('/api/admin/bot-settings').send(body({
      displayName: '  Арена  ', welcome: 'Привіт, {name}!', showPhone: false,
    }));

    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ displayName: 'Арена', welcome: 'Привіт, {name}!', showPhone: false });
    /* Запис — одним UPDATE (jsonb-злиття з поточною briefSentOn): [шаблон, json, clubId] */
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [, json, clubId] = prisma.$executeRaw.mock.calls[0];
    expect(JSON.parse(json)).toEqual(res.body.settings);
    expect(clubId).toBe('club-1');
  });

  it('порожня назва стає null (назва клубу)', async () => {
    const res = await request(app).put('/api/admin/bot-settings').send(body({ displayName: '   ' }));
    expect(res.status).toBe(200);
    expect(res.body.settings.displayName).toBeNull();
  });

  it('клуб без плану — 403 PLAN_REQUIRED, нічого не пишемо', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow({ plan: null }));
    const res = await request(app).put('/api/admin/bot-settings').send(body());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'PLAN_REQUIRED', feature: 'telegram' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('«Броні»: зберегти налаштування можна, а увімкнути повернення клієнтів — ні', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow({ plan: PLAN1 }));

    const ok = await request(app).put('/api/admin/bot-settings').send(body({ showPhone: false }));
    expect(ok.status).toBe(200);

    prisma.$executeRaw.mockClear();
    const res = await request(app).put('/api/admin/bot-settings').send(body({
      winback: { ...defaultBotSettings().winback, enabled: true },
    }));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'PLAN_REQUIRED', feature: 'analytics' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('«Аналітика»: повернення клієнтів вмикається', async () => {
    const res = await request(app).put('/api/admin/bot-settings').send(body({
      winback: { ...defaultBotSettings().winback, enabled: true },
    }));
    expect(res.status).toBe(200);
    expect(res.body.settings.winback.enabled).toBe(true);
  });

  it('клуб без плану — теж 403', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow({ plan: null }));
    expect((await request(app).put('/api/admin/bot-settings').send(body())).status).toBe(403);
  });

  it('чужі акції й тренери відкидаються, свої лишаються в порядку вибору', async () => {
    prisma.promo.findMany.mockResolvedValue([{ id: P1 }, { id: P2 }]);
    prisma.trainer.findMany.mockResolvedValue([{ id: T1 }]);

    const res = await request(app).put('/api/admin/bot-settings').send(body({
      promoIds: [P2, FOREIGN, P1],
      trainerIds: [FOREIGN, T1],
    }));

    expect(res.status).toBe(200);
    expect(res.body.settings.promoIds).toEqual([P2, P1]);
    expect(res.body.settings.trainerIds).toEqual([T1]);
    expect(prisma.promo.findMany.mock.calls[0][0].where).toMatchObject({ clubId: 'club-1' });
    expect(prisma.trainer.findMany.mock.calls[0][0].where).toMatchObject({ clubId: 'club-1' });
  });

  it('усі вибрані акції чужі — порожній вибір, а не «усі»', async () => {
    prisma.promo.findMany.mockResolvedValue([]);
    const res = await request(app).put('/api/admin/bot-settings').send(body({ promoIds: [FOREIGN] }));
    expect(res.body.settings.promoIds).toEqual([]);
  });

  it('promoIds: null («усі активні») лишається null без запиту по акціях', async () => {
    const res = await request(app).put('/api/admin/bot-settings').send(body());
    expect(res.body.settings.promoIds).toBeNull();
    expect(res.body.settings.trainerIds).toBeNull();
    expect(prisma.promo.findMany).not.toHaveBeenCalled();
  });

  it('акція для листа повернення: чужа скидається в null, своя лишається', async () => {
    const winback = { ...defaultBotSettings().winback, enabled: true };

    prisma.promo.findMany.mockResolvedValue([]);
    const foreign = await request(app).put('/api/admin/bot-settings').send(body({ winback: { ...winback, promoId: FOREIGN } }));
    expect(foreign.body.settings.winback.promoId).toBeNull();
    expect(foreign.body.settings.winback.enabled).toBe(true);

    prisma.promo.findMany.mockResolvedValue([{ id: P1 }]);
    const own = await request(app).put('/api/admin/bot-settings').send(body({ winback: { ...winback, promoId: P1 } }));
    expect(own.body.settings.winback.promoId).toBe(P1);
  });

  it.each([
    ['зайве поле', { extra: true }],
    ['afterDays поза списком', { winback: { ...defaultBotSettings().winback, afterDays: 10 } }],
    ['текст довший за 600', { welcome: 'а'.repeat(601) }],
    ['назва довша за 48', { displayName: 'а'.repeat(49) }],
    ['promoIds не uuid', { promoIds: ['x'] }],
  ])('невалідне тіло (%s) — 400', async (_n, over) => {
    const res = await request(app).put('/api/admin/bot-settings').send(body(over));
    expect(res.status).toBe(400);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('неповне тіло — 400', async () => {
    expect((await request(app).put('/api/admin/bot-settings').send({ displayName: 'x' })).status).toBe(400);
  });
});

describe('POST /bot-settings/preview', () => {
  const content = {
    club: { id: 'club-1', slug: 'squash', name: 'Squash', address: 'вул. Київська, 1', phone: '+380671112233' },
    promos: [{ id: P1, title: 'Ранок', summary: '−20% · пн–пт' }],
    trainers: [{ id: T1, name: 'Анна', from: '10:00', to: '18:00' }],
  };

  beforeEach(() => {
    loadClubContent.mockResolvedValue(content);
    process.env.PUBLIC_WEB_URL = 'https://club.example';
  });

  it('home: той самий текст, що в боті, з ще не збереженими налаштуваннями', async () => {
    const res = await request(app).post('/api/admin/bot-settings/preview').send({
      settings: { ...defaultBotSettings(), displayName: 'Арена', showTrainers: false },
      kind: 'home',
    });

    expect(res.status).toBe(200);
    expect(res.body.text).toContain('🎾 <b>Арена</b>');
    expect(res.body.text).toContain('Вітаємо, Олена!');
    expect(res.body.text).toContain('• Ранок — −20% · пн–пт');
    expect(res.body.text).not.toContain('на зміні');
    expect(res.body.keyboard).toEqual([
      [{ text: '🎾 Забронювати', kind: 'webapp' }],
      [{ text: '📋 Мої записи', kind: 'callback' }, { text: '👤 Мій профіль', kind: 'webapp' }],
    ]);
    expect(loadClubContent).toHaveBeenCalledWith('club-1', { anyState: true });
  });

  it('winback: days = «писати, якщо не грав», акція з налаштувань, кнопка відписки', async () => {
    const res = await request(app).post('/api/admin/bot-settings/preview').send({
      settings: { ...defaultBotSettings(), winback: { ...defaultBotSettings().winback, enabled: true, afterDays: 45, promoId: P1 } },
      kind: 'winback',
    });

    expect(res.status).toBe(200);
    expect(res.body.text).toContain('Олена, давно вас не бачили — вже 45 днів!');
    expect(res.body.text).toContain('🔥 Ранок — −20% · пн–пт');
    expect(res.body.keyboard).toEqual([
      [{ text: '🎾 Обрати час', kind: 'webapp' }],
      [{ text: '🔕 Не надсилати таке', kind: 'callback' }],
    ]);
  });

  it('html у тексті власника екранований і в превʼю', async () => {
    const res = await request(app).post('/api/admin/bot-settings/preview').send({
      settings: { ...defaultBotSettings(), welcome: '<b>Привіт' }, kind: 'home',
    });
    expect(res.body.text).toContain('&lt;b&gt;Привіт');
  });

  it('превʼю доступне й на тарифі без Telegram (нічого не зберігає)', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow({ plan: { ...PLAN3, tier: 1 } }));
    const res = await request(app).post('/api/admin/bot-settings/preview').send({ settings: defaultBotSettings(), kind: 'home' });
    expect(res.status).toBe(200);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it.each([
    ['невідомий kind', { settings: defaultBotSettings(), kind: 'x' }],
    ['без settings', { kind: 'home' }],
    ['невалідні settings', { settings: { ...defaultBotSettings(), welcome: 5 }, kind: 'home' }],
  ])('%s — 400', async (_n, payload) => {
    expect((await request(app).post('/api/admin/bot-settings/preview').send(payload)).status).toBe(400);
  });

  it('клуб не знайдено — 404', async () => {
    loadClubContent.mockResolvedValue(null);
    expect((await request(app).post('/api/admin/bot-settings/preview').send({ settings: defaultBotSettings(), kind: 'home' })).status).toBe(404);
  });
});

describe('PUT /bot-settings: ІІ (етап 3)', () => {
  const { morningBrief: _m, actionAlerts: _a, ...legacy } = defaultBotSettings();

  it('сводка вмикається на «Аналітика» і зберігається разом із годиною та сповіщеннями', async () => {
    const res = await request(app).put('/api/admin/bot-settings').send({ ...legacy, morningBrief: { enabled: true, hour: 9 }, actionAlerts: false });
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ morningBrief: { enabled: true, hour: 9 }, actionAlerts: false });
  });

  it('тариф без ІІ: увімкнути сводку не можна (403 ai), решту зберегти можна', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow({ plan: PLAN1 }));
    const no = await request(app).put('/api/admin/bot-settings').send({ ...legacy, morningBrief: { enabled: true, hour: 8 } });
    expect(no.status).toBe(403);
    expect(no.body).toMatchObject({ error: 'PLAN_REQUIRED', feature: 'ai' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect((await request(app).put('/api/admin/bot-settings').send({ ...legacy, morningBrief: { enabled: false, hour: 8 } })).status).toBe(200);
  });

  it('старий кабінет без нових полів не скидає збережені ІІ-налаштування', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow({ botSettings: { morningBrief: { enabled: true, hour: 10 }, actionAlerts: false } }));
    const res = await request(app).put('/api/admin/bot-settings').send(legacy);
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ morningBrief: { enabled: true, hour: 10 }, actionAlerts: false });
  });

  it('збереження форми не стирає позначку «сводку за день надіслано» і не бере її зі застарілого читання', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow({ botSettings: { briefSentOn: '2026-10-17' } }));
    await request(app).put('/api/admin/bot-settings').send(legacy);
    const [strings, json] = prisma.$executeRaw.mock.calls[0];
    const sql = strings.join('?');
    /* позначка береться з поточного рядка в самому UPDATE; прочитана раніше копія в запис не йде */
    expect(sql).toContain("jsonb_build_object('briefSentOn', \"botSettings\"->'briefSentOn')");
    expect(json).not.toContain('briefSentOn');
  });
});

describe('PUT /bot-settings: ІІ-чат у боті (етап 5)', () => {
  const { aiChat: _ai, ...legacy } = defaultBotSettings();

  it('зберігається й повертається', async () => {
    const res = await request(app).put('/api/admin/bot-settings').send({ ...legacy, aiChat: { staff: false, players: true } });
    expect(res.status).toBe(200);
    expect(res.body.settings.aiChat).toEqual({ staff: false, players: true });
  });

  it('тариф без ІІ: увімкнути гравців не можна (403 ai), вимкнути й зберегти решту — можна', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow({ plan: PLAN1 }));
    const no = await request(app).put('/api/admin/bot-settings').send({ ...legacy, aiChat: { staff: true, players: true } });
    expect(no.status).toBe(403);
    expect(no.body).toMatchObject({ error: 'PLAN_REQUIRED', feature: 'ai' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    /* staff: true — типове значення, яке вже «стоїть»: не нове вмикання */
    const ok = await request(app).put('/api/admin/bot-settings').send({ ...legacy, aiChat: { staff: true, players: false } });
    expect(ok.status).toBe(200);
  });

  it('старий кабінет без aiChat не скидає збережене', async () => {
    prisma.club.findUnique.mockResolvedValue(clubRow({ botSettings: { aiChat: { staff: false, players: true } } }));
    const res = await request(app).put('/api/admin/bot-settings').send(legacy);
    expect(res.status).toBe(200);
    expect(res.body.settings.aiChat).toEqual({ staff: false, players: true });
  });

  it('briefSentOn і далі переноситься з поточного рядка (SQL не змінився)', async () => {
    await request(app).put('/api/admin/bot-settings').send({ ...legacy, aiChat: { staff: true, players: true } });
    const [strings] = prisma.$executeRaw.mock.calls[0];
    expect(strings.join('?')).toContain("jsonb_build_object('briefSentOn'");
  });
});
