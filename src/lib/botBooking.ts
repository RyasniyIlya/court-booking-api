export type BookingClub = { slug: string; name: string };

const trimSlash = (value: string) => value.trim().replace(/\/+$/, '');

/** Public frontend that hosts /c/:slug. The first CORS origin is a safe fallback. */
export function publicWebBase(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = trimSlash(env.PUBLIC_WEB_URL ?? '');
  if (explicit) return explicit;
  const firstOrigin = (env.ADMIN_ORIGINS ?? '').split(',').map(trimSlash).find(Boolean);
  return firstOrigin ?? null;
}

export function clubStartPayload(slug: string) {
  return `club_${slug}`;
}

export function slugFromStartPayload(payload: string | undefined): string | null {
  if (!payload?.startsWith('club_')) return null;
  const slug = payload.slice(5);
  return /^[a-z0-9][a-z0-9-]{1,47}$/.test(slug) ? slug : null;
}

/**
 * Мітка, з якою бот веде людину на сторінку запису.
 *
 * Бот сам броней не створює — він дає посилання. Тому єдиний спосіб
 * побачити у звіті, скільки записів приніс бот, — позначити це посилання
 * так само, як клуб позначає рекламне. Без мітки такі броні зливаються з
 * прямими заходами, і питання «чи потрібен нам бот» лишається без
 * відповіді в цифрах.
 *
 * medium саме `messaging`, а не `cpc`: бот нічого не коштує за клік, і
 * записати його у витрати на рекламу означало б зіпсувати єдине число,
 * заради якого весь облік джерел і робиться.
 */
const BOT_TAGS = 'utm_source=telegram&utm_medium=messaging&utm_campaign=bot';

export function bookingUrl(slug: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = publicWebBase(env);
  return base ? `${base}/c/${encodeURIComponent(slug)}?${BOT_TAGS}` : null;
}

export function profileUrl(slug: string, env: NodeJS.ProcessEnv = process.env): string | null {
  /* Будуємо від publicWebBase, а не від bookingUrl: інакше мітки бота
     приклеїлися б двічі — один раз звідти, другий раз тут. */
  const base = publicWebBase(env);
  return base
    ? `${base}/c/${encodeURIComponent(slug)}?cbProfile=1&${BOT_TAGS}`
    : null;
}

export function clubChoiceKeyboard(clubs: BookingClub[]) {
  return {
    inline_keyboard: clubs.map((club) => [{
      text: `🎾 ${club.name}`,
      callback_data: `bookclub:${club.slug}`,
    }]),
  };
}

export function openBookingKeyboard(slug: string, env: NodeJS.ProcessEnv = process.env) {
  const url = bookingUrl(slug, env);
  if (!url) return undefined;
  const button = url.startsWith('https://')
    ? { text: 'Обрати час і забронювати', web_app: { url } }
    : { text: 'Обрати час і забронювати', url };
  return { inline_keyboard: [[button]] };
}

export function openProfileKeyboard(slug: string, env: NodeJS.ProcessEnv = process.env) {
  const url = profileUrl(slug, env);
  if (!url) return undefined;
  const button = url.startsWith('https://')
    ? { text: 'Відкрити мій профіль', web_app: { url } }
    : { text: 'Відкрити мій профіль', url };
  return { inline_keyboard: [[button]] };
}
