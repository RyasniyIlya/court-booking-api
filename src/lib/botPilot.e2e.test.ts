import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';

/**
 * Пілотні e2e-перевірки бота БЕЗ справжнього Telegram.
 *
 * Мокається лише два краї: база (prisma) і мережа (fetch до api.telegram.org).
 * Усе між ними — справжнє: обробники команд, планувальники, шар безпеки
 * TELEGRAM_SEND_MODE, екранування HTML. Це відрізняє файл від решти тестів,
 * які підміняють сам ./telegram і тому не бачать, що реально піде в мережу.
 */

type Sent = { method: string; chat: string; text: string };

const net = vi.hoisted(() => ({
  sent: [] as { method: string; chat: string; text: string }[],
  failNetwork: new Set<string>(),
  fail401: new Set<string>(),
}));

const prisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  customer: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  club: { findMany: vi.fn(), findFirst: vi.fn() },
  booking: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
  bookingSeat: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  waitlistEntry: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  block: { findMany: vi.fn() },
  tgDialog: { findUnique: vi.fn(async () => null) },
  $transaction: vi.fn(),
}));

const digest = vi.hoisted(() => ({
  dayDigest: vi.fn(async () => ({})), digestText: vi.fn(() => 'digest-text'),
  weekReport: vi.fn(async () => ({})), weekText: vi.fn(() => 'week-text'),
}));
const sections = vi.hoisted(() => ({
  revenueBreakdown: vi.fn(async () => ({})), revenueText: vi.fn(() => 'revenue-text'),
  staffReport: vi.fn(async () => ({})), staffText: vi.fn(() => 'staff-text'),
}));

vi.mock('./db', () => ({ prisma }));
vi.mock('./digest', () => ({ ...digest, WEEKDAY_FULL: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'] }));
vi.mock('./sections', () => sections);
vi.mock('./botAnalytics', () => ({ botAnalytics: vi.fn(async () => ['analytics']) }));

const { handleUpdate } = await import('./botHandlers');
const { runPlayerReminderTick } = await import('./playerRemind');
const { runWaitlistTick } = await import('./waitlist');
const { inviteToMatch } = await import('./openMatchInvite');
const { runDigestTick, stopDigestScheduler } = await import('./digestScheduler');
const { getSendStats, resetSendStats } = await import('./telegramSafety');

const PLAN3 = { tier: 3, featTrainers: true, featGroups: true, featAnalytics: true };
const PLAN2 = { tier: 2, featTrainers: true, featGroups: true, featAnalytics: true };

const transport = () => net.sent;
const sendsTo = (chat: string) => net.sent.filter((s) => s.chat === chat && s.method === 'sendMessage');
const messages = () => net.sent.filter((s) => s.method === 'sendMessage');

const ENV_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_SEND_MODE', 'TELEGRAM_ALLOWLIST_CHAT_IDS'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  delete process.env.TELEGRAM_SEND_MODE;
  delete process.env.TELEGRAM_ALLOWLIST_CHAT_IDS;
  net.sent.length = 0;
  net.failNetwork.clear();
  net.fail401.clear();
  resetSendStats();
  stopDigestScheduler();

  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(init.body);
    const chat = String(body.chat_id ?? body.scope?.chat_id ?? '');
    if (net.failNetwork.has(chat)) throw new Error('ECONNRESET');
    if (net.fail401.has(chat)) {
      return { status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) };
    }
    net.sent.push({ method, chat, text: String(body.text ?? '') } satisfies Sent);
    return { status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ── Команди бота ───────────────────────────────────────────────────────── */

const say = (chat: number, text: string) => handleUpdate({
  update_id: 1,
  message: { message_id: 1, from: { id: chat }, chat: { id: chat, type: 'private' }, text },
});

const staff = (role: string, clubName = 'Клуб') => ({
  id: 'u1', role, trainerId: null, tgNotifyBookings: true,
  club: { id: 'c1', name: clubName, timezone: 'Europe/Kyiv', plan: PLAN3 },
});

describe('команди через справжній обробник', () => {
  it.each(['/today', '/week', '/revenue'])('ADMIN отримує відмову на %s і жодного звіту', async (cmd) => {
    prisma.user.findUnique.mockResolvedValue(staff('ADMIN'));
    await say(700, cmd);

    const [reply] = sendsTo('700');
    expect(reply.text).toContain('доступна власнику');
    expect(digest.dayDigest).not.toHaveBeenCalled();
    expect(digest.weekReport).not.toHaveBeenCalled();
    expect(sections.revenueBreakdown).not.toHaveBeenCalled();
  });

  it('OWNER на /today отримує звіт', async () => {
    prisma.user.findUnique.mockResolvedValue(staff('OWNER'));
    await say(701, '/today');
    expect(digest.dayDigest).toHaveBeenCalled();
    expect(sendsTo('701').some((s) => s.text.includes('digest-text'))).toBe(true);
  });

  it('/start для привʼязаного персоналу екранує назву клубу', async () => {
    prisma.user.findUnique.mockResolvedValue(staff('OWNER', '<i>Корти</i> & Co'));
    await say(702, '/start');
    const text = sendsTo('702')[0].text;
    expect(text).toContain('&lt;i&gt;Корти&lt;/i&gt; &amp; Co');
    expect(text).not.toContain('<i>Корти');
  });

  it('/start для незнайомого чату показує вибір клубів', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.customer.findMany.mockResolvedValue([]);
    prisma.club.findMany.mockResolvedValue([{ id: 'c1', slug: 'club', name: 'Клуб' }]);
    await say(703, '/start');
    expect(sendsTo('703').length).toBeGreaterThan(0);
  });

  it('привʼязка кодом із кабінету підключає чат', async () => {
    const linkUser = {
      id: 'u1', role: 'OWNER', passwordHash: 'h',
      tgLinkUntil: new Date(Date.now() + 600_000), club: { name: 'Клуб', plan: PLAN3 },
    };
    let linked = false;
    prisma.user.findUnique.mockImplementation(async (q: { where: { tgLinkCode?: string; tgChatId?: string } }) => {
      if (q.where.tgLinkCode) return linkUser;
      return linked ? staff('OWNER') : null;
    });
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
      user: { updateMany: vi.fn(async () => ({ count: 1 })), update: vi.fn(async () => { linked = true; }) },
    }));
    await say(704, 'ABC123');
    expect(sendsTo('704').some((s) => s.text.includes('Підключено до клубу'))).toBe(true);
  });

  it('/stop відвʼязує гравця й підтверджує', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.customer.findMany.mockResolvedValue([{ id: 'cu1' }]);
    prisma.waitlistEntry.updateMany.mockResolvedValue({ count: 0 });
    prisma.customer.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockResolvedValue([]);
    await say(705, '/stop');
    expect(prisma.customer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ telegramChatId: null, tgMarketingAt: null }) }),
    );
    expect(sendsTo('705')[0].text).toContain('більше нічого не надсилатиму');
  });
});

/* ── Нагадування гравцям: вікно 180 хвилин ──────────────────────────────── */

describe('нагадування гравцю за 3 години', () => {
  const NOW = new Date('2026-10-15T12:00:00Z');
  const at = (min: number) => new Date(NOW.getTime() + min * 60_000);

  type B = { id: string; start: Date; created: Date; chat: string; court?: string; reminded?: boolean };
  const seed = (rows: B[]) => {
    prisma.booking.findMany.mockImplementation(async ({ where }: { where: any }) =>
      rows
        .filter((r) => !r.reminded
          && r.start > where.startTime.gt && r.start <= where.startTime.lte
          && r.created <= where.createdAt.lte)
        .map((r) => ({ id: r.id, club: { plan: PLAN3 } })));
    prisma.bookingSeat.findMany.mockResolvedValue([]);
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });
    prisma.booking.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      const r = rows.find((x) => x.id === where.id)!;
      return {
        id: r.id, status: 'CONFIRMED', capacity: null, title: null,
        startTime: r.start, endTime: new Date(r.start.getTime() + 3_600_000),
        playerConfirmedAt: null,
        court: { name: r.court ?? 'Корт 1' }, trainer: null,
        customer: { telegramChatId: r.chat },
        club: { slug: 'club', name: 'Клуб', phone: null, timezone: 'Europe/Kyiv', cancelCutoffMinutes: 120 },
      };
    });
  };
  const old = new Date('2026-10-14T10:00:00Z');

  it('шле лише тим, до кого ≤180 хв, і не шле за межею та свіжим бронням', async () => {
    seed([
      { id: 'in-179', start: at(179), created: old, chat: '1001' },
      { id: 'in-10', start: at(10), created: old, chat: '1002' },
      { id: 'out-181', start: at(181), created: old, chat: '1003' },
      { id: 'past', start: at(-5), created: old, chat: '1004' },
      { id: 'fresh', start: at(120), created: at(-10), chat: '1005' },
    ]);

    expect(await runPlayerReminderTick(NOW)).toBe(2);
    expect(messages().map((m) => m.chat).sort()).toEqual(['1001', '1002']);
  });

  it('екранує HTML у назві корту', async () => {
    seed([{ id: 'x', start: at(60), created: old, chat: '1010', court: '<script>alert(1)</script> & Корт' }]);
    await runPlayerReminderTick(NOW);
    const text = messages()[0].text;
    expect(text).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Корт');
    expect(text).not.toContain('<script>');
  });

  it('збій мережі в одного гравця не зупиняє решту й мітку не ставить', async () => {
    seed([
      { id: 'a', start: at(60), created: old, chat: '1020' },
      { id: 'b', start: at(61), created: old, chat: '1021' },
    ]);
    net.failNetwork.add('1020');

    expect(await runPlayerReminderTick(NOW)).toBe(1);
    expect(messages().map((m) => m.chat)).toEqual(['1021']);
    /* для невдалої відправки playerRemindedAt не ставимо (лише знімаємо оренду) */
    const marked = prisma.booking.updateMany.mock.calls
      .filter(([a]) => a.data?.playerRemindedAt).map(([a]) => a.where.id);
    expect(marked).toEqual(['b']);
  });
});

/* ── Черга очікування: лише найвищий тариф ──────────────────────────────── */

describe('лист очікування', () => {
  const NOW = new Date('2026-10-15T10:00:00Z');
  const entry = (id: string, courtId: string, chat: string, plan: unknown, court = 'Корт') => ({
    id, clubId: `club-${id}`, courtId, customerId: `cu-${id}`,
    startTime: new Date('2026-10-15T16:00:00Z'), endTime: new Date('2026-10-15T17:00:00Z'),
    status: 'WAITING', offerUntil: null, createdAt: new Date('2026-10-14T10:00:00Z'),
    court: { name: court, isActive: true },
    customer: { telegramChatId: chat, isBlocked: false },
    club: { id: `club-${id}`, slug: 's', name: 'Клуб <b>', timezone: 'Europe/Kyiv', leadTimeMinutes: 60, plan },
  });

  beforeEach(() => {
    prisma.waitlistEntry.updateMany.mockResolvedValue({ count: 1 });
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.block.findMany.mockResolvedValue([]);
  });

  it('сповіщає клуби на будь-якому тарифі, крім клубу без плану', async () => {
    prisma.waitlistEntry.findMany.mockResolvedValue([
      entry('t3', 'k1', '2001', PLAN3, '<u>Корт</u>'),
      entry('t2', 'k2', '2002', PLAN2),
      entry('none', 'k3', '2003', null),
    ]);

    expect(await runWaitlistTick(NOW)).toBe(2);
    expect(messages().map((m) => m.chat)).toEqual(['2001', '2002']);
    expect(messages()[0].text).toContain('&lt;u&gt;Корт&lt;/u&gt;');
    expect(messages()[0].text).toContain('Клуб &lt;b&gt;');
  });
});

/* ── Запрошення у відкриті ігри ─────────────────────────────────────────── */

describe('запрошення у відкриту гру', () => {
  const people = [
    { id: 'p-consent', name: 'Анна', skillLevel: null, telegramChatId: '3001', marketingConsentAt: new Date('2026-09-01') },
    { id: 'p-nocons', name: 'Борис', skillLevel: null, telegramChatId: '3002', marketingConsentAt: null },
    { id: 'p-nochat', name: 'Віка', skillLevel: null, telegramChatId: null, marketingConsentAt: new Date('2026-09-01') },
  ];
  const match = (plan: unknown) => ({
    id: 'm1', clubId: 'c1', title: null,
    startTime: new Date('2026-10-20T16:00:00Z'), endTime: new Date('2026-10-20T17:00:00Z'),
    capacity: 4, pricePerSeat: 20000, levelMin: null, levelMax: null,
    court: { name: 'Корт <1>' },
    club: { slug: 'club', name: 'Клуб & Co', timezone: 'Europe/Kyiv', plan },
  });

  beforeEach(() => {
    prisma.bookingSeat.count.mockResolvedValue(0);
    prisma.bookingSeat.findMany.mockResolvedValue([]);
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.customer.findMany.mockImplementation(async ({ where }: { where: any }) =>
      people.filter((p) =>
        (!where.telegramChatId || p.telegramChatId !== null)
        && (!where.marketingConsentAt || p.marketingConsentAt !== null)
        && (!where.id || where.id.in.includes(p.id))));
  });

  it('пише лише тим, хто дав marketingConsentAt і має чат', async () => {
    const ranked = await inviteToMatch(match(PLAN3), new Date('2026-10-18T10:00:00Z'));
    expect(ranked.map((r) => r.id)).toEqual(['p-consent']);
    expect(messages().map((m) => m.chat)).toEqual(['3001']);
    expect(messages()[0].text).toContain('Корт &lt;1&gt;');
    expect(messages()[0].text).toContain('Клуб &amp; Co');
  });

  it('на тарифі «Команда» теж шле — Telegram відкритий з найнижчого тарифу', async () => {
    await inviteToMatch(match(PLAN2), new Date('2026-10-18T10:00:00Z'));
    expect(messages().map((m) => m.chat)).toEqual(['3001']);
  });

  it('клубу без плану нічого не шле', async () => {
    await inviteToMatch(match(null), new Date('2026-10-18T10:00:00Z'));
    expect(transport()).toEqual([]);
  });
});

/* ── Дайджест ───────────────────────────────────────────────────────────── */

describe('дайджест', () => {
  const users = [
    { id: 'o1', role: 'OWNER', tgChatId: '4001', club: { id: 'c1', name: 'A', timezone: 'Europe/Kyiv', plan: PLAN3 } },
    { id: 'a1', role: 'ADMIN', tgChatId: '4002', club: { id: 'c1', name: 'A', timezone: 'Europe/Kyiv', plan: PLAN3 } },
    { id: 't1', role: 'TRAINER', tgChatId: '4003', club: { id: 'c1', name: 'A', timezone: 'Europe/Kyiv', plan: PLAN3 } },
    { id: 'o2', role: 'OWNER', tgChatId: '4004', club: { id: 'c2', name: 'B', timezone: 'Europe/Kyiv', plan: PLAN3 } },
  ];
  const evening = () => DateTime.fromISO('2026-09-29T21:05:00', { zone: 'Europe/Kyiv' });

  beforeEach(() => {
    prisma.user.findMany.mockImplementation(async ({ where }: { where: any }) =>
      users.filter((u) => (!where.role || u.role === where.role) && u.tgChatId));
  });

  it('клуб на «Бронях» (без аналітики) зведення не отримує', async () => {
    const base = { tier: 1, featTrainers: false, featGroups: false, featAnalytics: false };
    prisma.user.findMany.mockResolvedValue([
      { id: 'o9', role: 'OWNER', tgChatId: '4009', club: { id: 'c9', name: 'Z', timezone: 'Europe/Kyiv', plan: base } },
    ]);
    expect(await runDigestTick(evening())).toBe(0);
    expect(transport()).toEqual([]);
  });

  it('отримувачі — лише OWNER', async () => {
    expect(await runDigestTick(evening())).toBe(2);
    expect(messages().map((m) => m.chat).sort()).toEqual(['4001', '4004']);
  });

  it('недоступний чат власника (401) не ламає розсилку іншим і рахується як failed', async () => {
    net.fail401.add('4001');
    expect(await runDigestTick(evening())).toBe(1);
    expect(messages().map((m) => m.chat)).toEqual(['4004']);
    expect(getSendStats()).toMatchObject({ sent: 1, failed: 1 });
  });

  it('збій мережі не ламає розсилку', async () => {
    net.failNetwork.add('4001');
    await expect(runDigestTick(evening())).resolves.toBeGreaterThanOrEqual(1);
    expect(messages().map((m) => m.chat)).toContain('4004');
  });
});

/* ── Режими TELEGRAM_SEND_MODE ──────────────────────────────────────────── */

describe('TELEGRAM_SEND_MODE', () => {
  const users = [
    { id: 'o1', role: 'OWNER', tgChatId: '5001', club: { id: 'c1', name: 'A', timezone: 'Europe/Kyiv', plan: PLAN3 } },
    { id: 'o2', role: 'OWNER', tgChatId: '5002', club: { id: 'c2', name: 'B', timezone: 'Europe/Kyiv', plan: PLAN3 } },
  ];
  const evening = () => DateTime.fromISO('2026-09-29T21:05:00', { zone: 'Europe/Kyiv' });
  beforeEach(() => prisma.user.findMany.mockResolvedValue(users));

  it('live (за замовчуванням) шле всім, а порожнє значення = live', async () => {
    process.env.TELEGRAM_SEND_MODE = '';
    await runDigestTick(evening());
    expect(messages().length).toBe(2);
    expect(getSendStats()).toEqual({ sent: 2, skipped: 0, failed: 0 });
  });

  it('allowlist шле лише в дозволені чати, решту пропускає й рахує', async () => {
    process.env.TELEGRAM_SEND_MODE = 'allowlist';
    process.env.TELEGRAM_ALLOWLIST_CHAT_IDS = ' 5002 , 9999 ';
    await runDigestTick(evening());
    expect(messages().map((m) => m.chat)).toEqual(['5002']);
    expect(getSendStats()).toEqual({ sent: 1, skipped: 1, failed: 0 });
  });

  it('allowlist із порожнім списком не шле нікому', async () => {
    process.env.TELEGRAM_SEND_MODE = 'allowlist';
    await runDigestTick(evening());
    expect(transport()).toEqual([]);
    expect(getSendStats().skipped).toBe(2);
  });

  it('dry нічого не шле й не пише текст у лог, лише хеш чату й шаблон', async () => {
    process.env.TELEGRAM_SEND_MODE = 'dry';
    await runDigestTick(evening());
    expect(transport()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(getSendStats()).toEqual({ sent: 0, skipped: 2, failed: 0 });

    const logged = vi.mocked(console.log).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/\[telegram\] dry sendMessage chat=[0-9a-f]{10} template=digest/);
    expect(logged).not.toContain('5001');
    expect(logged).not.toContain('digest-text');
    expect(logged).toMatch(/\[telegram-summary\] digest mode=dry sent=0 skipped=2 failed=0/);
  });

  it('невідоме значення режиму трактується як dry', async () => {
    process.env.TELEGRAM_SEND_MODE = 'allowlst';
    await runDigestTick(evening());
    expect(transport()).toEqual([]);
  });

  it('dry для нагадування гравцю не ставить playerRemindedAt (після live вони отримають своє)', async () => {
    process.env.TELEGRAM_SEND_MODE = 'dry';
    const NOW = new Date('2026-10-15T12:00:00Z');
    prisma.booking.findMany.mockResolvedValue([{ id: 'b', club: { plan: PLAN3 } }]);
    prisma.bookingSeat.findMany.mockResolvedValue([]);
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });
    prisma.booking.findUnique.mockResolvedValue({
      id: 'b', status: 'CONFIRMED', capacity: null, title: null,
      startTime: new Date(NOW.getTime() + 3_600_000), endTime: new Date(NOW.getTime() + 7_200_000),
      playerConfirmedAt: null, court: { name: 'К' }, trainer: null,
      customer: { telegramChatId: '6001' },
      club: { slug: 'c', name: 'Клуб', phone: null, timezone: 'Europe/Kyiv', cancelCutoffMinutes: 120 },
    });
    expect(await runPlayerReminderTick(NOW)).toBe(0);
    expect(transport()).toEqual([]);
    const marked = prisma.booking.updateMany.mock.calls.filter(([a]) => a.data?.playerRemindedAt);
    expect(marked).toEqual([]);
  });
});
