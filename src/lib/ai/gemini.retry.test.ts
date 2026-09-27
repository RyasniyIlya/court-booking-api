import { describe, expect, it, vi } from 'vitest';

import { AiError, callGemini, postWithRetry } from './gemini';

const resp = (status: number) => new Response(status === 200 ? '{}' : 'err', { status });

/** fetch, що віддає заготовлені статуси по черзі; sleep — миттєвий і запамʼятовує паузи. */
const setup = (...statuses: number[]) => {
  const queue = [...statuses];
  const fetchImpl = vi.fn(async () => resp(queue.shift() ?? 500)) as unknown as typeof fetch;
  const sleep = vi.fn(async (_ms: number) => {});
  return { fetchImpl, sleep };
};

describe('postWithRetry', () => {
  it('503 → 200: успіх після одного повтору', async () => {
    const { fetchImpl, sleep } = setup(503, 200);
    const res = await postWithRetry('http://x', {}, { fetchImpl, sleep });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(600);
    expect(sleep.mock.calls[0][0]).toBeLessThan(800);
  });

  it('429 тричі: рівно 3 виклики, паузи ~600 і ~1500', async () => {
    const { fetchImpl, sleep } = setup(429, 429, 429);
    const res = await postWithRetry('http://x', {}, { fetchImpl, sleep });
    expect(res.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[1][0]).toBeGreaterThanOrEqual(1500);
  });

  it.each([400, 401, 403, 404])('%i не повторюється', async (status) => {
    const { fetchImpl, sleep } = setup(status, 200);
    const res = await postWithRetry('http://x', {}, { fetchImpl, sleep });
    expect(res.status).toBe(status);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('мережева помилка → AI_UNAVAILABLE без повтору', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
    const sleep = vi.fn(async () => {});
    await expect(postWithRetry('http://x', {}, { fetchImpl, sleep })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('callGemini після вичерпання повторів', () => {
  it('429×3 → AI_UNAVAILABLE', async () => {
    vi.useFakeTimers();
    const prevKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => resp(429));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = callGemini({}).catch((e) => e);
      await vi.runAllTimersAsync();
      const err = await p;
      expect(err).toBeInstanceOf(AiError);
      expect((err as AiError).code).toBe('AI_UNAVAILABLE');
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
      vi.useRealTimers();
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
    }
  });
});
