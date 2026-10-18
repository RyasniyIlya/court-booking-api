import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userFind: vi.fn(),
  clubFind: vi.fn(),
  send: vi.fn(),
  answer: vi.fn(),
  editMarkup: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
}));

vi.mock('./db', () => ({ prisma: { user: { findUnique: mocks.userFind }, club: { findUnique: mocks.clubFind } } }));
vi.mock('./telegram', () => ({ sendMessage: mocks.send, answerCallback: mocks.answer, editMessageReplyMarkup: mocks.editMarkup }));
vi.mock('./ai/actions', async () => {
  class AiActionError extends Error {
    constructor(readonly code: string) { super(code); }
  }
  return { AiActionError, approveAction: mocks.approve, rejectAction: mocks.reject };
});

const {
  actionsBlock, briefToTelegramHtml, flushAlertsNow, handleAiCallback, queueActionAlert, resetAlerts, splitTelegram,
} = await import('./aiTelegram');
const { AiActionError } = await import('./ai/actions');

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const plan = (tier: number) => ({ tier, featTrainers: true, featGroups: true, featAnalytics: true });
const me = (over: Record<string, unknown> = {}) => ({ id: 'u1', role: 'OWNER', club: { id: 'c1', plan: plan(3) }, ...over });
const press = (data: string, rows?: { text: string; callback_data?: string }[][]) => ({
  id: 'cb1',
  data,
  from: { id: 1001 },
  message: { message_id: 7, chat: { id: 1001 }, reply_markup: rows ? { inline_keyboard: rows } : undefined },
});
const kb = [
  [{ text: '✅ Підтвердити 1', callback_data: `ai:ok:${ID}` }, { text: '❌ Відхилити 1', callback_data: `ai:no:${ID}` }],
  [{ text: '✅ Підтвердити 2', callback_data: `ai:ok:${ID2}` }, { text: '❌ Відхилити 2', callback_data: `ai:no:${ID2}` }],
];

beforeEach(() => {
  vi.clearAllMocks();
  resetAlerts();
  mocks.userFind.mockResolvedValue(me());
  mocks.send.mockResolvedValue({ message_id: 1 });
  mocks.approve.mockResolvedValue({ status: 'EXECUTED', error: null });
  mocks.reject.mockResolvedValue({ status: 'REJECTED' });
});
afterEach(() => vi.useRealTimers());

/* ── Кнопки: хто може вирішувати ─────────────────────────────────────────── */

it('чужі кнопки (не ai:) не чіпаємо', async () => {
  expect(await handleAiCallback(press('day:0'))).toBe(false);
  expect(mocks.answer).not.toHaveBeenCalled();
});

it('власник підтверджує: дія виконується, ряд кнопок стає «Виконано», інші ряди живі', async () => {
  expect(await handleAiCallback(press(`ai:ok:${ID}`, kb))).toBe(true);
  expect(mocks.approve).toHaveBeenCalledWith(ID, { id: 'u1', clubId: 'c1' });
  const markup = mocks.editMarkup.mock.calls[0][2];
  expect(markup.inline_keyboard[0]).toEqual([{ text: '✅ Виконано', callback_data: 'ai:done' }]);
  expect(markup.inline_keyboard[1]).toEqual(kb[1]);
});

it('відхилення і збій виконання показують свій підсумок', async () => {
  await handleAiCallback(press(`ai:no:${ID}`, kb));
  expect(mocks.reject).toHaveBeenCalledWith(ID, { id: 'u1', clubId: 'c1' });
  expect(mocks.editMarkup.mock.calls[0][2].inline_keyboard[0][0].text).toBe('❌ Відхилено');

  mocks.approve.mockResolvedValue({ status: 'FAILED', error: 'Слот зайнятий' });
  await handleAiCallback(press(`ai:ok:${ID2}`, kb));
  expect(mocks.editMarkup.mock.calls[1][2].inline_keyboard[1][0].text).toBe('⚠️ Не виконано: Слот зайнятий');
});

it('не власник (адміністратор) — відмова, нічого не виконується й не редагується', async () => {
  mocks.userFind.mockResolvedValue(me({ role: 'ADMIN' }));
  await handleAiCallback(press(`ai:ok:${ID}`, kb));
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(mocks.reject).not.toHaveBeenCalled();
  expect(mocks.editMarkup).not.toHaveBeenCalled();
  expect(mocks.answer.mock.calls[0][1]).toContain('лише власник');
});

it('чат не привʼязаний до акаунта — пропозиція увійти', async () => {
  mocks.userFind.mockResolvedValue(null);
  await handleAiCallback(press(`ai:ok:${ID}`, kb));
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(mocks.answer.mock.calls[0][1]).toContain('/login');
});

it('клуб без ІІ в тарифі — відмова', async () => {
  mocks.userFind.mockResolvedValue(me({ club: { id: 'c1', plan: plan(2) } }));
  await handleAiCallback(press(`ai:ok:${ID}`, kb));
  expect(mocks.approve).not.toHaveBeenCalled();
});

it('дія чужого клубу чи невідомий id — «не знайдено», кнопки не чіпаємо', async () => {
  mocks.approve.mockRejectedValue(new AiActionError('AI_ACTION_NOT_FOUND'));
  await handleAiCallback(press(`ai:ok:${ID}`, kb));
  expect(mocks.answer.mock.calls[0][1]).toBe('Дію не знайдено');
  expect(mocks.editMarkup).not.toHaveBeenCalled();
});

it('подвійний клік: друге натискання — «Вже вирішено»', async () => {
  mocks.approve.mockRejectedValue(new AiActionError('AI_ACTION_NOT_PENDING'));
  await handleAiCallback(press(`ai:ok:${ID}`, kb));
  expect(mocks.editMarkup.mock.calls[0][2].inline_keyboard[0][0].text).toBe('Вже вирішено');
  mocks.answer.mockClear();
  await handleAiCallback(press('ai:done'));
  expect(mocks.answer).toHaveBeenCalledWith('cb1', 'Вже вирішено');
});

it('прострочена — «Термін вийшов»; сміття в data ігноруємо без звернення до БД', async () => {
  mocks.approve.mockRejectedValue(new AiActionError('AI_ACTION_EXPIRED'));
  await handleAiCallback(press(`ai:ok:${ID}`, kb));
  expect(mocks.editMarkup.mock.calls[0][2].inline_keyboard[0][0].text).toBe('Термін вийшов');

  mocks.userFind.mockClear();
  await handleAiCallback(press('ai:ok:not-a-uuid'));
  expect(mocks.userFind).not.toHaveBeenCalled();
});

/* ── Текст ───────────────────────────────────────────────────────────────── */

it('markdown → безпечний HTML: теги моделі екрануються, лишається тільки <b>', () => {
  expect(briefToTelegramHtml('# Заголовок **x**\n* пункт <script>\n**жирний** & текст')).toBe(
    '<b>Заголовок x</b>\n• пункт &lt;script&gt;\n<b>жирний</b> &amp; текст',
  );
});

it('довгий текст ділиться по рядках, кожна частина ≤ 4096, <b> не рветься, нічого не губиться', () => {
  const html = Array.from({ length: 300 }, (_, i) => `<b>Рядок ${i}</b> ${'а'.repeat(50)}`).join('\n');
  const parts = splitTelegram(html);
  expect(parts.length).toBeGreaterThan(1);
  for (const p of parts) {
    expect(p.length).toBeLessThanOrEqual(4096);
    expect(p.split('<b>').length).toBe(p.split('</b>').length);
  }
  expect(parts.join('\n')).toBe(html);
});

it('рядок без переносів довший за ліміт ріжеться, не ламаючи сутність &amp;', () => {
  const parts = splitTelegram('&amp;'.repeat(2000), 3800);
  for (const p of parts) {
    expect(p.length).toBeLessThanOrEqual(3800);
    expect(p).toMatch(/^(&amp;)+$/);
  }
});

it('блок дій: одна дія — кнопки без номера; кілька — з номерами; не більше трьох', () => {
  const a = (n: number, status = 'PENDING') => ({ id: `${n}`.repeat(8) + '-1111-4111-8111-111111111111', summary: `Дія ${n}`, status, error: null });
  const one = actionsBlock([a(1)]);
  expect(one.keyboard?.inline_keyboard[0].map((b) => b.text)).toEqual(['✅ Підтвердити', '❌ Відхилити']);

  const many = actionsBlock([a(1), a(2), a(3), a(4)]);
  expect(many.keyboard?.inline_keyboard).toHaveLength(3);
  expect(many.keyboard?.inline_keyboard[1][0].text).toBe('✅ Підтвердити 2');
  expect(many.text).toContain('ще 1 у черзі');

  expect(actionsBlock([a(1, 'REJECTED')])).toEqual({ text: '', keyboard: undefined });
});

/* ── Сповіщення про нові пропозиції ──────────────────────────────────────── */

const alertClub = (botSettings: unknown = {}, tier = 3) => ({
  botSettings, plan: plan(tier), users: [{ tgChatId: '1001' }],
});
const pending = (id: string, summary: string) => ({ id, summary, status: 'PENDING', error: null });

it('три дії за хвилину — одне повідомлення з трьома рядками, автором і кнопками', async () => {
  vi.useFakeTimers();
  mocks.clubFind.mockResolvedValue(alertClub());
  queueActionAlert('c1', 'ADMIN', [pending(ID, 'Перша')]);
  queueActionAlert('c1', 'ADMIN', [pending(ID2, 'Друга')]);
  queueActionAlert('c1', 'TRAINER', [pending('33333333-3333-4333-8333-333333333333', 'Третя')]);
  expect(mocks.send).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  const [chat, text, markup] = mocks.send.mock.calls[0];
  expect(chat).toBe('1001');
  expect(text).toContain('адміністратор, тренер');
  expect(text).toContain('Перша');
  expect(text).toContain('Третя');
  expect(markup.inline_keyboard).toHaveLength(3);
});

it('actionAlerts=false, тариф без ІІ, виконані дії — нічого не шлемо', async () => {
  mocks.clubFind.mockResolvedValue(alertClub({ actionAlerts: false }));
  queueActionAlert('c1', 'ADMIN', [pending(ID, 'x')]);
  await flushAlertsNow();

  mocks.clubFind.mockResolvedValue(alertClub({}, 2));
  queueActionAlert('c1', 'ADMIN', [pending(ID, 'x')]);
  await flushAlertsNow();

  queueActionAlert('c1', 'ADMIN', [{ ...pending(ID, 'x'), status: 'EXECUTED' }]);
  await flushAlertsNow();
  expect(mocks.send).not.toHaveBeenCalled();
});

it('нове вікно після спрацювання: наступна дія — окреме повідомлення', async () => {
  vi.useFakeTimers();
  mocks.clubFind.mockResolvedValue(alertClub());
  queueActionAlert('c1', 'OWNER', [pending(ID, 'A')]);
  await vi.advanceTimersByTimeAsync(60_000);
  queueActionAlert('c1', 'OWNER', [pending(ID2, 'B')]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.send).toHaveBeenCalledTimes(2);
});
