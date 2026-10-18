import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  club: { findMany: vi.fn(), findUnique: vi.fn() },
  customer: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), count: vi.fn() },
  booking: { groupBy: vi.fn(), findMany: vi.fn() },
  bookingSeat: { findMany: vi.fn() },
  promo: { findFirst: vi.fn() },
};
const sendReminderMessage = vi.fn();

vi.mock('./db', () => ({ prisma }));
vi.mock('./telegram', () => ({ sendReminderMessage, botReady: () => true }));
vi.mock('./playerRemind', () => ({ playerSchedulerEnabled: () => true }));

const { winbackEligibility, inSendWindow, runWinbackTick, countWinbackEligible, MAX_PER_TICK } = await import('./winback');

const DAY = 86_400_000;
const NOW = new Date('2026-09-30T10:00:00Z'); // 13:00 у Києві (літній час +3)
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const settings = { afterDays: 30, everyDays: 7, maxMessages: 3 } as const;
const base = {
  now: NOW, hasChat: true, marketingOk: true, blocked: false,
  lastVisit: ago(40), hasUpcoming: false, winbackCount: 0, winbackLastAt: null as Date | null, settings,
};

describe('winbackEligibility', () => {
  it('людина, що не грала 40 днів і нікому не писали, отримує лист', () => {
    expect(winbackEligibility(base)).toEqual({ ok: true, count: 0, days: 40 });
  });

  it.each([
    ['без чату', { hasChat: false }, 'no_chat'],
    ['без згоди', { marketingOk: false }, 'no_consent'],
    ['заблокована', { blocked: true }, 'blocked'],
    ['ніколи не грала', { lastVisit: null }, 'never_played'],
    ['є майбутня бронь', { hasUpcoming: true }, 'upcoming'],
    ['грала нещодавно', { lastVisit: ago(10) }, 'recent'],
  ] as const)('%s — не надсилаємо', (_n, over, reason) => {
    expect(winbackEligibility({ ...base, ...over })).toEqual({ ok: false, reason });
  });

  it('поріг afterDays включно: рівно 30 днів уже можна, 29 — ще ні', () => {
    expect(winbackEligibility({ ...base, lastVisit: ago(30) }).ok).toBe(true);
    expect(winbackEligibility({ ...base, lastVisit: ago(29) })).toEqual({ ok: false, reason: 'recent' });
  });

  it('інтервал: раніше everyDays — рано, рівно everyDays — можна', () => {
    const sent = (daysAgo: number) => ({ ...base, winbackCount: 1, winbackLastAt: ago(daysAgo) });
    expect(winbackEligibility(sent(3))).toEqual({ ok: false, reason: 'too_soon' });
    expect(winbackEligibility(sent(6))).toEqual({ ok: false, reason: 'too_soon' });
    expect(winbackEligibility(sent(7))).toEqual({ ok: true, count: 1, days: 40 });
  });

  it('ліміт листів: після maxMessages — більше нічого', () => {
    expect(winbackEligibility({ ...base, winbackCount: 3, winbackLastAt: ago(20) })).toEqual({ ok: false, reason: 'max_reached' });
    expect(winbackEligibility({ ...base, winbackCount: 2, winbackLastAt: ago(20) }).ok).toBe(true);
  });

  it('лічильник скидається, якщо після останнього листа був новий візит', () => {
    /* Візит 40 днів тому, а лист (що вже вичерпав ліміт) — 60 днів тому:
       людина поверталась, і нова «історія» починається з нуля. */
    const r = winbackEligibility({ ...base, lastVisit: ago(40), winbackCount: 3, winbackLastAt: ago(60) });
    expect(r).toEqual({ ok: true, count: 0, days: 40 });
  });

  it('скинутий лічильник не чекає інтервалу від старого листа', () => {
    const r = winbackEligibility({ ...base, lastVisit: ago(35), winbackCount: 1, winbackLastAt: ago(36) });
    expect(r.ok && r.count).toBe(0);
  });

  it('лист після візиту лічильник не скидає', () => {
    const r = winbackEligibility({ ...base, lastVisit: ago(60), winbackCount: 3, winbackLastAt: ago(10) });
    expect(r).toEqual({ ok: false, reason: 'max_reached' });
  });
});

describe('inSendWindow (11:00–19:59 за часом клубу)', () => {
  const at = (iso: string) => new Date(iso);
  it.each([
    ['2026-09-30T07:59:00Z', false], // 10:59 Київ
    ['2026-09-30T08:00:00Z', true], // 11:00
    ['2026-09-30T16:59:00Z', true], // 19:59
    ['2026-09-30T17:00:00Z', false], // 20:00
    ['2026-09-30T02:00:00Z', false], // 05:00
  ])('%s → %s', (iso, expected) => {
    expect(inSendWindow(at(iso), 'Europe/Kyiv')).toBe(expected);
  });

  it('рахує в таймзоні клубу, а не сервера', () => {
    // 10:00 UTC = 06:00 у Нью-Йорку (EDT)
    expect(inSendWindow(at('2026-09-30T10:00:00Z'), 'America/New_York')).toBe(false);
    expect(inSendWindow(at('2026-09-30T10:00:00Z'), 'Europe/Kyiv')).toBe(true);
  });
});

/* ── Тік ────────────────────────────────────────────────────────────────── */

const PLAN = { tier: 3, featTrainers: true, featGroups: true, featAnalytics: true };
const winbackOn = (over: Record<string, unknown> = {}) => ({
  winback: { enabled: true, afterDays: 30, everyDays: 7, maxMessages: 3, ...over },
});
const club = (over: Record<string, unknown> = {}) => ({
  id: 'club-1', name: 'Squash', slug: 'squash', timezone: 'Europe/Kyiv', plan: PLAN, botSettings: winbackOn(), ...over,
});
const person = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `Гравець ${id}`, telegramChatId: `chat-${id}`, winbackCount: 0, winbackLastAt: null, ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  prisma.club.findMany.mockResolvedValue([club()]);
  prisma.customer.findMany.mockResolvedValue([person('a')]);
  prisma.customer.updateMany.mockResolvedValue({ count: 1 });
  prisma.customer.count.mockResolvedValue(0);
  prisma.customer.update.mockResolvedValue({});
  prisma.booking.groupBy.mockResolvedValue([{ customerId: 'a', _max: { endTime: ago(40) } }]);
  prisma.bookingSeat.findMany.mockResolvedValue([]);
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.promo.findFirst.mockResolvedValue(null);
  sendReminderMessage.mockResolvedValue('sent');
});

describe('runWinbackTick', () => {
  it('надсилає лист і записує лічильник та час', async () => {
    expect(await runWinbackTick(NOW)).toBe(1);

    expect(sendReminderMessage).toHaveBeenCalledTimes(1);
    const [chat, text, markup] = sendReminderMessage.mock.calls[0];
    expect(chat).toBe('chat-a');
    expect(text).toContain('вже 40 днів');
    expect(JSON.stringify(markup)).toContain('wb:off:a');
    expect(prisma.customer.updateMany).toHaveBeenCalledWith({
      where: { id: 'a', tgMarketingAt: { not: null }, winbackLastAt: null, winbackCount: 0 },
      data: { winbackCount: 1, winbackLastAt: NOW },
    });
  });

  it('вибірка кандидатів — лише зі згодою, чатом і без блокування', async () => {
    await runWinbackTick(NOW);
    expect(prisma.customer.findMany.mock.calls[0][0].where).toMatchObject({
      clubId: 'club-1', telegramChatId: { not: null }, tgMarketingAt: { not: null }, isBlocked: false,
    });
  });

  it('поза денним вікном, при вимкненому поверненні й без тарифу «Аналітика» — мовчить', async () => {
    expect(await runWinbackTick(new Date('2026-09-30T02:00:00Z'))).toBe(0);

    prisma.club.findMany.mockResolvedValue([club({ botSettings: winbackOn({ enabled: false }) })]);
    expect(await runWinbackTick(NOW)).toBe(0);

    /* «Броні» й «Команда» (Telegram є, аналітики немає) та клуб без плану */
    prisma.club.findMany.mockResolvedValue([
      club({ plan: { ...PLAN, tier: 1, featTrainers: false, featGroups: false, featAnalytics: false } }),
      club({ plan: { ...PLAN, tier: 2, featAnalytics: false } }),
      club({ plan: null }),
    ]);
    expect(await runWinbackTick(NOW)).toBe(0);

    expect(sendReminderMessage).not.toHaveBeenCalled();
    expect(prisma.customer.findMany).not.toHaveBeenCalled();
  });

  it('хто ніколи не грав — не чіпаємо', async () => {
    prisma.booking.groupBy.mockResolvedValue([]);
    expect(await runWinbackTick(NOW)).toBe(0);
    expect(sendReminderMessage).not.toHaveBeenCalled();
  });

  it('останній візит береться як найпізніший з броні й місця групи', async () => {
    prisma.booking.groupBy.mockResolvedValue([{ customerId: 'a', _max: { endTime: ago(50) } }]);
    prisma.bookingSeat.findMany.mockResolvedValueOnce([{ customerId: 'a', booking: { endTime: ago(10) } }]);
    /* Останнє заняття — групове, 10 днів тому: рано. */
    expect(await runWinbackTick(NOW)).toBe(0);
  });

  it('майбутня бронь чи місце блокує лист', async () => {
    prisma.booking.findMany.mockResolvedValue([{ customerId: 'a' }]);
    expect(await runWinbackTick(NOW)).toBe(0);

    prisma.booking.findMany.mockResolvedValue([]);
    prisma.bookingSeat.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ customerId: 'a' }]);
    expect(await runWinbackTick(NOW)).toBe(0);
  });

  it('інтервал і ліміт зчитуються з налаштувань клубу', async () => {
    prisma.customer.findMany.mockResolvedValue([
      person('a', { winbackCount: 1, winbackLastAt: ago(3) }),
    ]);
    expect(await runWinbackTick(NOW)).toBe(0);

    prisma.customer.findMany.mockResolvedValue([
      person('a', { winbackCount: 1, winbackLastAt: ago(3) }),
    ]);
    prisma.club.findMany.mockResolvedValue([club({ botSettings: winbackOn({ everyDays: 14 }) })]);
    expect(await runWinbackTick(NOW)).toBe(0);

    prisma.customer.findMany.mockResolvedValue([
      person('a', { winbackCount: 1, winbackLastAt: ago(8) }),
    ]);
    prisma.club.findMany.mockResolvedValue([club()]);
    expect(await runWinbackTick(NOW)).toBe(1);
    expect(prisma.customer.updateMany.mock.calls.at(-1)![0].data).toEqual({ winbackCount: 2, winbackLastAt: NOW });
  });

  it('після нового візиту лічильник починається спочатку', async () => {
    prisma.customer.findMany.mockResolvedValue([
      person('a', { winbackCount: 3, winbackLastAt: ago(90) }),
    ]);
    expect(await runWinbackTick(NOW)).toBe(1);
    expect(prisma.customer.updateMany.mock.calls[0][0].data).toEqual({ winbackCount: 1, winbackLastAt: NOW });
  });

  it('не більше 25 листів на клуб за тік', async () => {
    const many = Array.from({ length: 40 }, (_, i) => person(`p${i}`));
    prisma.customer.findMany.mockResolvedValue(many);
    prisma.booking.groupBy.mockResolvedValue(many.map((p) => ({ customerId: p.id, _max: { endTime: ago(40) } })));
    expect(MAX_PER_TICK).toBe(25);
    expect(await runWinbackTick(NOW)).toBe(25);
    expect(sendReminderMessage).toHaveBeenCalledTimes(25);
  });

  it('бота заблоковано (permanent) — згоду знято, лічильник лишається зайнятим', async () => {
    sendReminderMessage.mockResolvedValue('permanent');
    expect(await runWinbackTick(NOW)).toBe(0);
    expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: 'a' }, data: { tgMarketingAt: null } });
  });

  it('тимчасова помилка (retry) — мітка повертається, щоб спробувати наступного тіку', async () => {
    sendReminderMessage.mockResolvedValue('retry');
    expect(await runWinbackTick(NOW)).toBe(0);
    expect(prisma.customer.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'a', winbackLastAt: NOW },
      data: { winbackCount: 0, winbackLastAt: null },
    });
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });

  it('якщо інший процес уже забрав цю людину — не шлемо вдруге', async () => {
    prisma.customer.updateMany.mockResolvedValue({ count: 0 });
    expect(await runWinbackTick(NOW)).toBe(0);
    expect(sendReminderMessage).not.toHaveBeenCalled();
  });

  it('акція з налаштувань додається в лист, але лише активна акція цього клубу', async () => {
    prisma.club.findMany.mockResolvedValue([club({ botSettings: winbackOn({ promoId: 'promo-1' }) })]);
    prisma.promo.findFirst.mockResolvedValue({
      id: 'promo-1', title: 'Ранок', kind: 'WEEKLY', weekdays: [1, 2, 3, 4, 5],
      startMinute: 420, endMinute: 720, discountType: 'PERCENT', discountValue: 20,
    });
    await runWinbackTick(NOW);
    expect(prisma.promo.findFirst).toHaveBeenCalledWith({ where: { id: 'promo-1', clubId: 'club-1', isActive: true } });
    expect(sendReminderMessage.mock.calls[0][1]).toContain('🔥 Ранок — −20% · пн–пт · 07:00–12:00');
  });
});

describe('countWinbackEligible', () => {
  it('рахує тих, хто потрапить під умову зараз (без денного вікна)', async () => {
    prisma.club.findUnique.mockResolvedValue({ botSettings: winbackOn() });
    prisma.customer.findMany.mockResolvedValue([person('a'), person('b'), person('c')]);
    prisma.booking.groupBy.mockResolvedValue([
      { customerId: 'a', _max: { endTime: ago(40) } },
      { customerId: 'b', _max: { endTime: ago(5) } },
      /* c — ніколи не грав */
    ]);
    expect(await countWinbackEligible('club-1', NOW)).toBe(1);
  });

  it('клуб без збережених налаштувань — типові (30 днів)', async () => {
    prisma.club.findUnique.mockResolvedValue({ botSettings: {} });
    expect(await countWinbackEligible('club-1', NOW)).toBe(1);
  });

  it('нікого зі згодою — нуль без запитів про візити', async () => {
    prisma.club.findUnique.mockResolvedValue({ botSettings: {} });
    prisma.customer.findMany.mockResolvedValue([]);
    expect(await countWinbackEligible('club-1', NOW)).toBe(0);
    expect(prisma.booking.groupBy).not.toHaveBeenCalled();
  });
});
