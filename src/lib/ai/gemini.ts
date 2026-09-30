/**
 * Google Gemini — тонкий клієнт і цикл викликів інструментів.
 *
 * Ходимо в REST напряму через fetch, без SDK: залежностей у проєкті
 * навмисно мало, а нам потрібен один метод — generateContent. Провайдер
 * ізольований у цьому файлі: асистенти (clientAssistant, ownerAssistant)
 * знають лише `runAssistant` і `ToolDef`, тож заміна моделі чи постачальника
 * не зачіпає ні промптів, ні інструментів, ні роутів.
 *
 * Змінні середовища:
 *   GEMINI_API_KEY  — ключ із Google AI Studio. Без нього ШІ вимкнений, а
 *                     роути відповідають 503 AI_NOT_CONFIGURED.
 *   GEMINI_MODEL    — типово gemini-flash-latest (аліас на актуальну flash: конкретні версії Google знімає з обігу — 2.5-flash уже закрита для нових ключів). Швидка й дешева, для
 *                     консультацій гравцям цього вистачає; для звітів
 *                     власнику можна поставити pro.
 *   GEMINI_FALLBACK_MODELS — запасні моделі через кому, типово
 *                     gemini-flash-lite-latest (див. aiFallbackModels).
 */

export type GeminiPart = {
  text?: string;
  /** Міркування моделі. Назад у історію їх повертаємо як є, читачу не віддаємо. */
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
};

export type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

export type GeminiResponse = {
  candidates?: Array<{ content?: GeminiContent; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
};

export type ToolDecl = {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

/** Інструмент: опис для моделі + що робить наш код, коли вона його викликала. */
export type ToolDef = {
  decl: ToolDecl;
  run: (args: Record<string, unknown>) => Promise<unknown>;
};

export type GenerateFn = (body: Record<string, unknown>) => Promise<GeminiResponse>;

export class AiError extends Error {
  constructor(public code: 'AI_NOT_CONFIGURED' | 'AI_UNAVAILABLE' | 'AI_BLOCKED' | 'AI_TOO_MANY_STEPS', message?: string) {
    super(message ?? code);
  }
}

export const aiConfigured = () => Boolean(process.env.GEMINI_API_KEY?.trim());
export const aiModel = () => process.env.GEMINI_MODEL?.trim() || 'gemini-flash-latest';

/** Паузи перед повторами: 503/429 у Gemini зазвичай тимчасові (перевантаження, ліміт за хвилину). */
const RETRY_DELAYS_MS = [600, 1500];
const RETRYABLE = new Set([429, 503]);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * POST із повтором на тимчасові помилки (503, 429): до двох повторів із
 * паузами ~600 і ~1500 мс + невеликий джитер, щоб клієнти не б'ються в
 * провайдера синхронно. Коди 400/401/403/404 НЕ повторюємо: це помилка
 * запиту чи ключа, повтор лише палить квоту. Мережеву помилку теж не
 * повторюємо — таймаут уже 45 с, і чекати втретє гравець не буде.
 * fetchImpl і sleep підмінюються в тестах: без мережі й реальних пауз.
 */
export async function postWithRetry(
  url: string,
  init: RequestInit,
  opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch {
      throw new AiError('AI_UNAVAILABLE', 'network');
    }
    if (res.ok || !RETRYABLE.has(res.status)) return res;
    if (attempt >= RETRY_DELAYS_MS.length) return res;
    /* Лог — лише статус, без тіла: у ньому бувають фрагменти чужих повідомлень. */
    console.error(`[ai] gemini responded ${res.status}, retry ${attempt + 1}`);
    await sleep(RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 150));
  }
}

/**
 * Запасні моделі — на випадок, коли основна перевантажена (503), вичерпала
 * квоту (429) або Google її зняв (404). Так уже було: flash-latest віддавала
 * 503 «high demand» годинами, і ШІ-чат лежав увесь цей час, хоча lite-модель
 * на тому ж ключі відповідала. GEMINI_FALLBACK_MODELS — через кому; порожній
 * рядок вимикає запасні зовсім.
 */
export const aiFallbackModels = () => {
  const raw = process.env.GEMINI_FALLBACK_MODELS;
  const list = raw === undefined ? ['gemini-flash-lite-latest'] : raw.split(',');
  return list.map((m) => m.trim()).filter((m) => m && m !== aiModel());
};

const FALLBACK_ON = new Set([404, 429, 503]);

/**
 * Скільки тримати основну модель «на лаві» після збою. Без паузи кожне
 * питання спершу чекало б ~2 с повторів на мертвій моделі, а в циклі
 * інструментів — на кожному кроці, і різні кроки однієї відповіді
 * ходили б у різні моделі.
 */
const BENCH_MS = 5 * 60_000;
const benchedUntil = new Map<string, number>();

/** Для тестів: забути, які моделі відпочивають. */
export const resetModelBench = () => benchedUntil.clear();

/** Один запит до Gemini. Ключ іде заголовком, а не в адресі — адреси потрапляють у логи. */
export const callGemini: GenerateFn = async (body) => {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new AiError('AI_NOT_CONFIGURED');

  const now = Date.now();
  const models = [aiModel(), ...aiFallbackModels()];
  const ready = models.filter((m) => (benchedUntil.get(m) ?? 0) <= now);
  /* Якщо на лаві всі — пробуємо всіх: краще зайвий запит, ніж відмова без спроби. */
  const order = ready.length ? ready : models;

  let lastStatus = 0;
  for (const model of order) {
    const res = await postWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      },
    );

    if (res.ok) {
      benchedUntil.delete(model);
      return (await res.json()) as GeminiResponse;
    }

    /* Тіло помилки не пробрасуємо нагору: у ньому бувають фрагменти запиту,
       а значить — чужі повідомлення гравця. У лог іде тільки статус. */
    console.error(`[ai] gemini ${model} responded ${res.status}`);
    lastStatus = res.status;
    if (!FALLBACK_ON.has(res.status)) break;
    benchedUntil.set(model, Date.now() + BENCH_MS);
  }

  throw new AiError('AI_UNAVAILABLE', String(lastStatus));
};

/** Скільки символів відповіді інструмента віддаємо моделі. Більше — це вже дамп, а не відповідь. */
const TOOL_RESULT_LIMIT = 12_000;

function toolResponse(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value ?? null);
  if (text.length <= TOOL_RESULT_LIMIT) return { result: value ?? null };
  return { result: text.slice(0, TOOL_RESULT_LIMIT), truncated: true };
}

const textOf = (content?: GeminiContent) =>
  (content?.parts ?? [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();

/**
 * Цикл: модель просить інструмент → ми виконуємо → повертаємо результат →
 * так, доки вона не дасть текстову відповідь.
 *
 * Інструменти виконуються тільки з того набору, що передав викликач, за
 * іменем. Модель не може ні додати свій, ні дістатися чогось поза ним.
 * Помилка інструмента не валить розмову: модель отримує `error` і
 * пояснює людині своїми словами (без стектрейсу — там шляхи й запити).
 */
export async function runAssistant(opts: {
  system: string;
  history: GeminiContent[];
  tools: ToolDef[];
  maxOutputTokens?: number;
  maxSteps?: number;
  generate?: GenerateFn;
}): Promise<{ reply: string; steps: number; tokens: number }> {
  const generate = opts.generate ?? callGemini;
  const contents = [...opts.history];
  const byName = new Map(opts.tools.map((t) => [t.decl.name, t]));
  let tokens = 0;

  for (let step = 0; step < (opts.maxSteps ?? 6); step++) {
    const res = await generate({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents,
      ...(opts.tools.length ? { tools: [{ functionDeclarations: opts.tools.map((t) => t.decl) }] } : {}),
      generationConfig: { maxOutputTokens: opts.maxOutputTokens ?? 1024, temperature: 0.4 },
    });
    tokens += res.usageMetadata?.totalTokenCount ?? 0;

    if (res.promptFeedback?.blockReason) throw new AiError('AI_BLOCKED', res.promptFeedback.blockReason);
    const content = res.candidates?.[0]?.content;
    if (!content) throw new AiError('AI_BLOCKED', res.candidates?.[0]?.finishReason ?? 'empty');

    const calls = content.parts.filter((p) => p.functionCall);
    if (calls.length === 0) return { reply: textOf(content), steps: step + 1, tokens };

    /* Хід моделі повертаємо в історію цілком, разом із підписами міркувань:
       без них Gemini 2.5 губить нитку між викликами інструментів. */
    contents.push({ role: 'model', parts: content.parts });

    const answers = await Promise.all(calls.map(async ({ functionCall }) => {
      const name = functionCall!.name;
      const tool = byName.get(name);
      if (!tool) return { functionResponse: { name, response: { error: 'unknown tool' } } };
      try {
        return { functionResponse: { name, response: toolResponse(await tool.run(functionCall!.args ?? {})) } };
      } catch (e) {
        const message = e instanceof Error && e.name === 'ToolInputError' ? e.message : 'tool failed';
        return { functionResponse: { name, response: { error: message } } };
      }
    }));
    contents.push({ role: 'user', parts: answers });
  }

  throw new AiError('AI_TOO_MANY_STEPS');
}

/** Некоректний аргумент від моделі: текст помилки їй корисний, тож його віддаємо. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/**
 * Пошук в інтернеті через Google Search grounding: погода, новини, події.
 *
 * Окремий запит, а не інструмент у тому самому виклику: Gemini не завжди
 * дозволяє поєднувати googleSearch із власними функціями в одному запиті.
 * Асистент викликає це як звичайну функцію й отримує готовий текст.
 */
export async function groundedSearch(question: string, generate: GenerateFn = callGemini): Promise<string> {
  const res = await generate({
    contents: [{ role: 'user', parts: [{ text: question }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: { maxOutputTokens: 700, temperature: 0.2 },
  });
  return textOf(res.candidates?.[0]?.content) || 'Даних не знайдено.';
}

/** Проста ланка між HTTP-тілом і історією Gemini: тільки текст, тільки user/model. */
export function toHistory(messages: Array<{ role: 'user' | 'assistant'; content: string }>): GeminiContent[] {
  return messages.map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] }));
}
