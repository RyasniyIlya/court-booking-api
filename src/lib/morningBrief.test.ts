import { beforeEach, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  send: vi.fn(),
  assistant: vi.fn(),
  configured: vi.fn(() => true),
  /** Імітація БД-позначки: clubId → остання дата. Спільна для «обох інстансів». */
  marks: new Map<string, string>(),
}));

vi.mock('./db', () => ({
  prisma: {
    user: { findMany: mocks.findMany },
    /* Той самий умовний UPDATE, що й у SQL: бере день, лише якщо позначка менша. */
    $executeRaw: vi.fn(async (_s: TemplateStringsArray, day: string, clubId: string) => {
      if ((mocks.marks.get(clubId) ?? '') < day) { mocks.marks.set(clubId, day); return 1; }
      return 0;
    }),
  },
}));
vi.mock('./telegram', () => ({ sendMessage: mocks.send }));
vi.mock('./ai/gemini', async (orig) => ({ ...(await orig<typeof import('./ai/gemini')>()), aiConfigured: mocks.configured }));
vi.mock('./ai/ownerAssistant', () => ({ BRIEF_REQUEST: 'brief', ownerAssistant: mocks.assistant }));
vi.mock('./ai/policyStore', () => ({ loadPolicy: vi.fn(async () => ({ bookings: 'ASK', roleAccess: {} })) }));
vi.mock('./ai/executors', () => ({}));

const { runMorningBriefTick } = await import('./morningBrief');
const { resetQuota, takeQuota } = await import('./ai/quota');
const { AiError } = await import('./ai/gemini');

const plan = (tier: number) => ({ tier, featTrainers: true, featGroups: true, featAnalytics: true });
const owner = (over: Record<string, unknown> = {}, settings: unknown = { morningBrief: { enabled: true, hour: 8 } }) => ({
  id: 'u1',
  tgChatId: '1001',
  club: { id: 'c1', name: 'Клуб', timezone: 'Europe/Kyiv', address: null, botSettings: settings, plan: plan(3), ...over },
});
const at = (iso: string, zone = 'Europe/Kyiv') => DateTime.fromISO(iso, { zone });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.marks.clear();
  resetQuota();
  mocks.configured.mockReturnValue(true);
  mocks.findMany.mockResolvedValue([owner()]);
  mocks.send.mockResolvedValue({ message_id: 1 });
  mocks.assistant.mockResolvedValue({ reply: '## Вчора\n**Добре** <ok>', steps: 1, tokens: 1, actions: [] });
});

it('шле о налаштованій годині за часом клубу, а не сервера', async () => {
  /* 05:05 UTC у жовтні (до переходу на зимовий час) = 08:05 Києва */
  expect(await runMorningBriefTick(at('2026-10-24T05:05:00', 'UTC'))).toBe(1);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.send.mock.calls[0][0]).toBe('1001');
  expect(mocks.send.mock.calls[0][1]).toBe('<b>Вчора</b>\n<b>Добре</b> &lt;ok&gt;');
});

it('до години — тиша; через 2 години після — теж', async () => {
  expect(await runMorningBriefTick(at('2026-10-24T07:45:00'))).toBe(0);
  expect(await runMorningBriefTick(at('2026-10-24T10:00:00'))).toBe(0);
  expect(mocks.assistant).not.toHaveBeenCalled();
});

it('перехід на зимовий час 2026-10-25: одна сводка на добу, година — місцева', async () => {
  /* 24-го: UTC+3, 08:05 Києва = 05:05Z. 25-го: UTC+2, 08:05 = 06:05Z, а 05:05Z вже 07:05 */
  const first = await runMorningBriefTick(at('2026-10-24T05:05:00', 'UTC'));
  expect(await runMorningBriefTick(at('2026-10-25T05:05:00', 'UTC'))).toBe(0);
  const second = await runMorningBriefTick(at('2026-10-25T06:05:00', 'UTC'));
  expect(await runMorningBriefTick(at('2026-10-25T07:05:00', 'UTC'))).toBe(0); // 09:05 — той самий день
  expect([first, second]).toEqual([1, 1]);
  expect(mocks.assistant).toHaveBeenCalledTimes(2);
});

it('два тіки / два інстанси в одну добу — одна відправка', async () => {
  const now = at('2026-10-24T08:00:00');
  const [a, b] = await Promise.all([runMorningBriefTick(now), runMorningBriefTick(now.plus({ minutes: 15 }))]);
  expect(a + b).toBe(1);
  expect(await runMorningBriefTick(now.plus({ minutes: 30 }))).toBe(0);
  expect(mocks.assistant).toHaveBeenCalledTimes(1);
});

it.each([
  ['вимкнено в налаштуваннях', owner({}, { morningBrief: { enabled: false, hour: 8 } })],
  ['налаштувань немає (типово вимкнено)', owner({}, {})],
  ['тариф без ІІ', owner({ plan: plan(2) })],
  ['без тарифу', owner({ plan: null })],
])('нічого не шле: %s', async (_n, row) => {
  mocks.findMany.mockResolvedValue([row]);
  expect(await runMorningBriefTick(at('2026-10-24T08:05:00'))).toBe(0);
  expect(mocks.assistant).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});

it('Gemini не налаштований або власник без бота — нічого й нікуди', async () => {
  mocks.configured.mockReturnValue(false);
  expect(await runMorningBriefTick(at('2026-10-24T08:05:00'))).toBe(0);
  expect(mocks.findMany).not.toHaveBeenCalled();

  mocks.configured.mockReturnValue(true);
  mocks.findMany.mockResolvedValue([{ ...owner(), tgChatId: null }]);
  expect(await runMorningBriefTick(at('2026-10-24T08:05:00'))).toBe(0);
  expect(mocks.assistant).not.toHaveBeenCalled();
});

it('година з налаштувань (10:00) береться з клубу', async () => {
  mocks.findMany.mockResolvedValue([owner({}, { morningBrief: { enabled: true, hour: 10 } })]);
  expect(await runMorningBriefTick(at('2026-10-24T08:05:00'))).toBe(0);
  expect(await runMorningBriefTick(at('2026-10-24T10:05:00'))).toBe(1);
});

it('збій моделі: власник бачить коротке пояснення без сирої помилки, день витрачено', async () => {
  mocks.assistant.mockRejectedValue(new AiError('AI_BLOCKED', 'secret detail'));
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  await runMorningBriefTick(at('2026-10-24T08:05:00'));
  expect(mocks.send).toHaveBeenCalledTimes(1);
  const text = mocks.send.mock.calls[0][1] as string;
  expect(text).toContain('не вдалося');
  expect(text).not.toContain('secret');
  expect(err.mock.calls.flat().join(' ')).toContain('AI_BLOCKED');
  /* повтор у той самий день платний виклик не дублює */
  await runMorningBriefTick(at('2026-10-24T08:20:00'));
  expect(mocks.assistant).toHaveBeenCalledTimes(1);
  err.mockRestore();
});

it('пропозиції: PENDING — кнопки ok/no, AUTO — «виконано», FAILED — причина; довга сводка ділиться', async () => {
  const id1 = '11111111-1111-4111-8111-111111111111';
  mocks.assistant.mockResolvedValue({
    reply: Array.from({ length: 200 }, (_, i) => `Рядок ${i} ${'ж'.repeat(40)}`).join('\n'),
    steps: 1,
    tokens: 1,
    actions: [
      { id: id1, kind: 'x', summary: 'Бронь <корт 1>', status: 'PENDING', error: null },
      { id: '22222222-2222-4222-8222-222222222222', kind: 'x', summary: 'Акція', status: 'EXECUTED', error: null },
      { id: '33333333-3333-4333-8333-333333333333', kind: 'x', summary: 'Лист', status: 'FAILED', error: 'Слот зайнятий' },
    ],
  });
  await runMorningBriefTick(at('2026-10-24T08:05:00'));
  const calls = mocks.send.mock.calls;
  expect(calls.length).toBeGreaterThan(2); // сводка >4096 розбита + блок дій
  for (const [, text] of calls) expect((text as string).length).toBeLessThanOrEqual(4096);
  const last = calls[calls.length - 1];
  expect(last[1]).toContain('Бронь &lt;корт 1&gt;');
  expect(last[1]).toContain('виконано автоматично');
  expect(last[1]).toContain('не виконано: Слот зайнятий');
  expect(last[2].inline_keyboard).toHaveLength(1);
  expect(last[2].inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data)).toEqual([`ai:ok:${id1}`, `ai:no:${id1}`]);
  for (const b of last[2].inline_keyboard[0]) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
});

it('добовий ліміт запитів до ІІ вичерпано — сводка не збирається', async () => {
  process.env.AI_OWNER_DAILY_LIMIT = '1';
  takeQuota('owner', 'c1', 1);
  expect(await runMorningBriefTick(at('2026-10-24T08:05:00'))).toBe(0);
  expect(mocks.assistant).not.toHaveBeenCalled();
  delete process.env.AI_OWNER_DAILY_LIMIT;
});

it('вичерпана квота НЕ спалює день: після її відновлення сводка приходить', async () => {
  process.env.AI_OWNER_DAILY_LIMIT = '1';
  takeQuota('owner', 'c1', 1);
  expect(await runMorningBriefTick(at('2026-10-24T08:05:00'))).toBe(0);
  expect(mocks.marks.size).toBe(0);
  delete process.env.AI_OWNER_DAILY_LIMIT;
  expect(await runMorningBriefTick(at('2026-10-24T08:20:00'))).toBe(1);
});

it('сводка просить у моделі не більше трьох пропозицій', async () => {
  await runMorningBriefTick(at('2026-10-24T08:05:00'));
  expect(mocks.assistant.mock.calls[0][0].manager.maxProposals).toBe(3);
});

it('некоректний часовий пояс клубу: пропуск із попередженням, решта клубів працюють', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const good = owner();
  const bad = { ...owner({ id: 'c2', timezone: 'Mars/Olympus' }), id: 'u2', tgChatId: '1002' };
  mocks.findMany.mockResolvedValue([bad, good]);
  expect(await runMorningBriefTick(at('2026-10-24T08:05:00'))).toBe(1);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});
