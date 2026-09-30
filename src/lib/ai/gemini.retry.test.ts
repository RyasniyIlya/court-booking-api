import { describe, expect, it, vi } from 'vitest';

import { AiError, aiFallbackModels, callGemini, postWithRetry, resetModelBench } from './gemini';

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

/** callGemini з тестовим ключем і заданими запасними моделями; fetch відповідає за назвою моделі. */
async function withGemini(
  fallbacks: string | undefined,
  statusFor: (model: string) => number,
  fn: (fetchSpy: ReturnType<typeof vi.spyOn>) => Promise<void>,
) {
  vi.useFakeTimers();
  resetModelBench();
  const prev = { key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL, fb: process.env.GEMINI_FALLBACK_MODELS };
  process.env.GEMINI_API_KEY = 'test-key';
  delete process.env.GEMINI_MODEL;
  if (fallbacks === undefined) delete process.env.GEMINI_FALLBACK_MODELS;
  else process.env.GEMINI_FALLBACK_MODELS = fallbacks;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const model = /models\/([^:]+):/.exec(String(url))?.[1] ?? '';
    return resp(statusFor(decodeURIComponent(model)));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await fn(spy);
  } finally {
    spy.mockRestore();
    errSpy.mockRestore();
    vi.useRealTimers();
    resetModelBench();
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore('GEMINI_API_KEY', prev.key);
    restore('GEMINI_MODEL', prev.model);
    restore('GEMINI_FALLBACK_MODELS', prev.fb);
  }
}

const settle = async <T>(p: Promise<T>) => {
  const caught = p.catch((e) => e);
  await vi.runAllTimersAsync();
  return caught;
};

const modelsCalled = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((c) => /models\/([^:]+):/.exec(String(c[0]))?.[1]);

describe('callGemini після вичерпання повторів', () => {
  it('без запасних: 429×3 → AI_UNAVAILABLE', async () => {
    await withGemini('', () => 429, async (spy) => {
      const err = await settle(callGemini({}));
      expect(err).toBeInstanceOf(AiError);
      expect((err as AiError).code).toBe('AI_UNAVAILABLE');
      expect(spy).toHaveBeenCalledTimes(3);
    });
  });
});

describe('callGemini: запасна модель', () => {
  it('типово запасна — gemini-flash-lite-latest', async () => {
    await withGemini(undefined, () => 200, async () => {
      expect(aiFallbackModels()).toEqual(['gemini-flash-lite-latest']);
    });
  });

  it('основна 503 → відповідає запасна', async () => {
    await withGemini(undefined, (m) => (m === 'gemini-flash-latest' ? 503 : 200), async (spy) => {
      const res = await settle(callGemini({}));
      expect(res).toEqual({});
      expect(modelsCalled(spy)).toEqual([
        'gemini-flash-latest', 'gemini-flash-latest', 'gemini-flash-latest', 'gemini-flash-lite-latest',
      ]);
    });
  });

  it('після збою основна відпочиває: наступний запит одразу йде в запасну', async () => {
    await withGemini(undefined, (m) => (m === 'gemini-flash-latest' ? 503 : 200), async (spy) => {
      await settle(callGemini({}));
      spy.mockClear();
      await settle(callGemini({}));
      expect(modelsCalled(spy)).toEqual(['gemini-flash-lite-latest']);
    });
  });

  it('404 (модель знята) теж переходить на запасну', async () => {
    await withGemini(undefined, (m) => (m === 'gemini-flash-latest' ? 404 : 200), async (spy) => {
      await settle(callGemini({}));
      expect(modelsCalled(spy)).toEqual(['gemini-flash-latest', 'gemini-flash-lite-latest']);
    });
  });

  it('400 (кривий запит) запасну не пробує — там буде те саме', async () => {
    await withGemini(undefined, () => 400, async (spy) => {
      const err = await settle(callGemini({}));
      expect((err as AiError).code).toBe('AI_UNAVAILABLE');
      expect(modelsCalled(spy)).toEqual(['gemini-flash-latest']);
    });
  });

  it('обидві лежать → AI_UNAVAILABLE', async () => {
    await withGemini(undefined, () => 503, async (spy) => {
      const err = await settle(callGemini({}));
      expect((err as AiError).code).toBe('AI_UNAVAILABLE');
      expect(spy).toHaveBeenCalledTimes(6);
    });
  });
});
