/**
 * Страховка приватності: телефони й пошта клієнтів не повинні потрапляти в Gemini
 * з жодного інструмента. Основний захист — самі інструменти не віддають контакти
 * (managerTools.ts); це друга лінія на випадок нового інструмента чи поля, де
 * номер «просочився» в рядок (назва броні, нотатка, summary).
 *
 * Одним проходом по тексту: спершу розпізнаємо те, що ЗБЕРІГАЄМО (uuid, дати
 * ISO), інакше шістнадцяткові групи з дефісами й «2026-10-23» читалися б як
 * телефон. Далі пошта, далі телефон.
 */
const PATTERN = new RegExp(
  [
    /(?<keep>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2})/.source,
    /(?<email>[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/.source,
    /(?<phone>\+?\(?\d[\d\s().-]{5,}\d)/.source,
  ].join('|'),
  'gi',
);

export const MASK_PHONE = '[телефон приховано]';
export const MASK_EMAIL = '[пошту приховано]';

function isPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, '').length;
  if (digits < 7) return false;
  /* Ряд годин чи кількостей («10 12 14 16 18 20 22») — не телефон: у номері є хоч одна
     група з 3+ цифр підряд або явний «+». Ціни (450, 1200) і так коротші за 7 цифр. */
  return raw.trimStart().startsWith('+') || /\d{3}/.test(raw);
}

export function maskPii(text: string): string {
  return text.replace(PATTERN, (m, ...rest) => {
    const g = rest[rest.length - 1] as Record<string, string | undefined>;
    if (g.keep) return m;
    if (g.email) return MASK_EMAIL;
    return isPhone(m) ? MASK_PHONE : m;
  });
}

/** Обходить будь-яку JSON-подібну відповідь інструмента й маскує всі рядки. */
export function sanitizeToolResult<T>(value: T): T {
  if (typeof value === 'string') return maskPii(value) as T;
  if (Array.isArray(value)) return value.map(sanitizeToolResult) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeToolResult(v)])) as T;
  }
  return value;
}
