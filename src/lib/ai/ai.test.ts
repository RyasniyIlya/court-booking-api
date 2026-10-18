import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError, runAssistant, toHistory, type GeminiResponse, type ToolDef } from './gemini';
import { clientAssistant, clientSystemPrompt, type AssistantAction, type FetchPublic } from './clientAssistant';

const say = (text: string): GeminiResponse => ({ candidates: [{ content: { role: 'model', parts: [{ text }] } }] });
const call = (name: string, args: Record<string, unknown> = {}): GeminiResponse => ({
  candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args }, thoughtSignature: 'sig' }] } }],
});

/** generate, який віддає заготовлені відповіді по черзі й запамʼятовує запити. */
const script = (...replies: GeminiResponse[]) => {
  const bodies: any[] = [];
  const fn = vi.fn(async (body: any) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    const next = replies.shift();
    if (!next) throw new Error('script exhausted');
    return next;
  });
  return { fn, bodies };
};

describe('runAssistant', () => {
  it('без викликів інструментів повертає текст першої відповіді', async () => {
    const { fn } = script(say('Привіт!'));
    const out = await runAssistant({ system: 's', history: toHistory([{ role: 'user', content: 'hi' }]), tools: [], generate: fn });
    expect(out.reply).toBe('Привіт!');
  });

  it('виконує інструмент і повертає результат моделі разом із підписом міркувань', async () => {
    const run = vi.fn(async () => ({ price: 10 }));
    const tool: ToolDef = { decl: { name: 'get_price', description: 'd', parameters: { type: 'object', properties: {} } }, run };
    const { fn, bodies } = script(call('get_price', { x: 1 }), say('Десять'));

    const out = await runAssistant({ system: 's', history: toHistory([{ role: 'user', content: 'скільки?' }]), tools: [tool], generate: fn });

    expect(out.reply).toBe('Десять');
    expect(run).toHaveBeenCalledWith({ x: 1 });
    const second = bodies[1].contents;
    expect(second.at(-2).parts[0].thoughtSignature).toBe('sig');
    expect(second.at(-1)).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'get_price', response: { result: { price: 10 } } } }] });
  });

  it('невідомий інструмент і збій інструмента не валять розмову', async () => {
    const boom: ToolDef = { decl: { name: 'boom', description: 'd', parameters: { type: 'object', properties: {} } }, run: async () => { throw new Error('secret db path'); } };
    const { fn, bodies } = script(call('nope'), call('boom'), say('ок'));

    const out = await runAssistant({ system: 's', history: [], tools: [boom], generate: fn });

    expect(out.reply).toBe('ок');
    expect(bodies[1].contents.at(-1).parts[0].functionResponse.response).toEqual({ error: 'unknown tool' });
    /* Текст внутрішньої помилки до моделі (а отже й до гравця) не доходить. */
    expect(JSON.stringify(bodies[2])).not.toContain('secret db path');
  });

  it('надто великий результат інструмента обрізається', async () => {
    const big: ToolDef = { decl: { name: 'big', description: 'd', parameters: { type: 'object', properties: {} } }, run: async () => 'x'.repeat(50_000) };
    const { fn, bodies } = script(call('big'), say('ok'));
    await runAssistant({ system: 's', history: [], tools: [big], generate: fn });
    const resp = bodies[1].contents.at(-1).parts[0].functionResponse.response;
    expect(resp.truncated).toBe(true);
    expect(resp.result.length).toBeLessThanOrEqual(12_000);
  });

  it('блокування або порожня відповідь — AI_BLOCKED, нескінченний цикл — AI_TOO_MANY_STEPS', async () => {
    await expect(runAssistant({ system: 's', history: [], tools: [], generate: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }) }))
      .rejects.toMatchObject({ code: 'AI_BLOCKED' });

    const loop: ToolDef = { decl: { name: 'l', description: 'd', parameters: { type: 'object', properties: {} } }, run: async () => 1 };
    await expect(runAssistant({ system: 's', history: [], tools: [loop], maxSteps: 3, generate: async () => call('l') }))
      .rejects.toBeInstanceOf(AiError);
  });

  it('рахує кроки й підсумовує токени з usageMetadata кожного кроку', async () => {
    const run = vi.fn(async () => ({ price: 10 }));
    const tool: ToolDef = { decl: { name: 'get_price', description: 'd', parameters: { type: 'object', properties: {} } }, run };
    const { fn } = script(
      { ...call('get_price'), usageMetadata: { totalTokenCount: 120 } },
      { ...say('Десять'), usageMetadata: { totalTokenCount: 80 } },
    );

    const out = await runAssistant({ system: 's', history: [], tools: [tool], generate: fn });

    expect(out.steps).toBe(2);
    expect(out.tokens).toBe(200);
  });

  it('відповідь без usageMetadata — 0 токенів, а не помилка', async () => {
    const out = await runAssistant({ system: 's', history: [], tools: [], generate: async () => say('ок') });
    expect(out).toMatchObject({ steps: 1, tokens: 0 });
  });

  it('текст міркувань не потрапляє у відповідь', async () => {
    const res: GeminiResponse = { candidates: [{ content: { role: 'model', parts: [{ text: 'думаю…', thought: true }, { text: 'Відповідь' }] } }] };
    expect((await runAssistant({ system: 's', history: [], tools: [], generate: async () => res })).reply).toBe('Відповідь');
  });
});

describe('clientAssistant', () => {
  const COURT = '11111111-1111-4111-8111-111111111111';
  const day = {
    courts: [{
      courtId: COURT, courtName: 'Корт 1', pricePerHour: 60000,
      slots: [
        { start: '2026-09-27T15:00:00.000Z', end: '2026-09-27T16:00:00.000Z', label: '18:00', available: true },
        { start: '2026-09-27T16:00:00.000Z', end: '2026-09-27T17:00:00.000Z', label: '19:00', available: false },
      ],
    }],
  };
  const paths: string[] = [];
  const fetchPublic: FetchPublic = async (path) => {
    paths.push(path);
    if (path.includes('/availability')) return day;
    if (path.endsWith('/rentals')) return [{ id: 'i', name: 'Ракетка Head', category: 'Ракетки', rentPrice: 15000, rentMode: 'FIXED', free: 4 }];
    throw new Error('unexpected ' + path);
  };

  beforeEach(() => { paths.length = 0; });

  it('прокат: ціни переводяться в гривні й дані беруться з публічного API клубу', async () => {
    const { fn, bodies } = script(call('get_rentals'), say('Ракетка Head — 150 грн'));
    const out = await clientAssistant({
      slug: 'demo club', clubName: 'Demo', timezone: 'Europe/Kyiv',
      messages: [{ role: 'user', content: 'яка ракетка є?' }], fetchPublic, generate: fn,
    });
    expect(out.reply).toContain('150');
    expect(paths).toEqual(['/clubs/demo%20club/rentals']);
    expect(bodies[1].contents.at(-1).parts[0].functionResponse.response.result[0]).toMatchObject({ name: 'Ракетка Head', price_uah: 150, free_now: 4 });
  });

  it('offer_booking віддає дію лише для реально вільного слота', async () => {
    const { fn, bodies } = script(
      call('offer_booking', { court_id: COURT, date: '2026-09-27', time: '19:00' }),
      call('offer_booking', { court_id: COURT, date: '2026-09-27', time: '18:00' }),
      say('Готово'),
    );
    const out = await clientAssistant({
      slug: 'demo', clubName: 'Demo', timezone: 'Europe/Kyiv',
      messages: [{ role: 'user', content: 'забронюй' }], fetchPublic, generate: fn,
    });

    expect(bodies[1].contents.at(-1).parts[0].functionResponse.response.result.ok).toBe(false);
    expect(out.actions).toEqual<AssistantAction[]>([{
      type: 'book_slot', courtId: COURT, courtName: 'Корт 1', date: '2026-09-27', time: '18:00',
      start: '2026-09-27T15:00:00.000Z', end: '2026-09-27T16:00:00.000Z',
    }]);
  });

  it('некоректний аргумент від моделі не доходить до публічного API', async () => {
    const { fn, bodies } = script(call('get_free_slots', { date: 'завтра' }), say('ок'));
    await clientAssistant({ slug: 'demo', clubName: 'Demo', timezone: 'Europe/Kyiv', messages: [{ role: 'user', content: 'x' }], fetchPublic, generate: fn });
    expect(paths).toEqual([]);
    expect(bodies[1].contents.at(-1).parts[0].functionResponse.response.error).toMatch(/YYYY-MM-DD/);
  });

  it('модель не має інструментів, що читають клієнтів чи гроші', async () => {
    const { fn, bodies } = script(say('ок'));
    await clientAssistant({ slug: 'demo', clubName: 'Demo', timezone: 'Europe/Kyiv', messages: [{ role: 'user', content: 'x' }], fetchPublic, generate: fn });
    const names = bodies[0].tools[0].functionDeclarations.map((d: any) => d.name).sort();
    expect(names).toEqual(['get_club_info', 'get_free_slots', 'get_rentals', 'get_trainers', 'offer_booking']);
  });

  it('промпт містить контекст екрана як довідку, а не наказ', () => {
    const p = clientSystemPrompt('Demo', 'Europe/Kyiv', { courtId: COURT, date: '2026-09-27' });
    expect(p).toContain(COURT);
    expect(p).toContain('довідково');
  });
});
