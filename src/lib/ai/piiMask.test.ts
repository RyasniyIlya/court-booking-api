import { describe, expect, it, vi } from 'vitest';

import { AiError, runAssistant, type GeminiResponse, type ToolDef } from './gemini';
import { maskPii, sanitizeToolResult } from './piiMask';

describe('maskPii', () => {
  it('маскує телефони в різних записах', () => {
    for (const p of ['+380000000007', '+38 (067) 123-45-67', '067 123 45 67', '0671234567', '380 67 123 45 67']) {
      expect(maskPii(`Клієнт ${p}, просить корт`)).toBe('Клієнт [телефон приховано], просить корт');
    }
  });

  it('маскує пошту', () => {
    expect(maskPii('пиши на Ivan.Petrenko+club@mail.ua, дякую')).toBe('пиши на [пошту приховано], дякую');
  });

  it('не чіпає ціни, час, дати, кількості та ряди годин', () => {
    for (const t of ['450 грн', '1200', '18:00–19:30', '2026-10-23', '2026-10-23T15:00:00.000+03:00', '3 корти, 12 гравців', '10 12 14 16 18 20 22', 'Корт 2']) {
      expect(maskPii(t)).toBe(t);
    }
  });

  it('зберігає uuid, навіть із літерами й довгими цифровими групами', () => {
    for (const id of ['11111111-1111-4111-8111-111111111111', '0a1b2c3d-4e5f-4a6b-8c7d-123456789012', '12345678-1234-4234-8234-123456789012']) {
      expect(maskPii(id)).toBe(id);
      expect(sanitizeToolResult({ id, court_id: id })).toEqual({ id, court_id: id });
    }
  });

  it('обходить вкладені обʼєкти й масиви, числа лишає', () => {
    expect(sanitizeToolResult({ a: [{ note: 'дзвонити +380671234567', price_uah: 450 }], n: null, ok: true }))
      .toEqual({ a: [{ note: 'дзвонити [телефон приховано]', price_uah: 450 }], n: null, ok: true });
  });
});

describe('runAssistant: що реально йде в Gemini', () => {
  const call = (name: string): GeminiResponse => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args: {} } }] } }] });
  const done: GeminiResponse = { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] };

  async function sentToModel(tool: ToolDef) {
    const generate = vi.fn().mockResolvedValueOnce(call(tool.decl.name)).mockResolvedValueOnce(done);
    await runAssistant({ system: 's', history: [{ role: 'user', parts: [{ text: 'hi' }] }], tools: [tool], generate });
    return JSON.stringify(generate.mock.calls[1][0].contents);
  }

  const leaky = (over: Partial<ToolDef> = {}): ToolDef => ({
    decl: { name: 'leaky', description: 'd', parameters: { type: 'object', properties: {} } },
    run: async () => [{ id: '11111111-1111-4111-8111-111111111111', note: 'Олена +380671234567 / olena@mail.ua', price_uah: 450 }],
    ...over,
  });

  it('телефон і пошта з результату будь-якого інструмента маскуються', async () => {
    const sent = await sentToModel(leaky());
    expect(sent).not.toMatch(/380671234567|olena@mail/);
    expect(sent).toContain('11111111-1111-4111-8111-111111111111');
    expect(sent).toContain('450');
  });

  it('publicContacts (публічний телефон клубу) пропускається як є', async () => {
    const sent = await sentToModel(leaky({ publicContacts: true }));
    expect(sent).toContain('380671234567');
  });

  it('AiError доступний (імпорт не зламаний)', () => {
    expect(new AiError('AI_BLOCKED').code).toBe('AI_BLOCKED');
  });
});
