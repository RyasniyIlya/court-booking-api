/**
 * Фото й відео корту — те, що гравець бачить у віджеті до першої броні.
 *
 * Фото лежать байтами в базі, як логотип клубу й знімки з комори: файлова
 * система Render ефемерна. Відео байтами не лежить ніде — це десятки
 * мегабайт на ролик, і роздавати їх із Postgres означало б покласти базу
 * першим же переглядом. Клуб дає посилання на YouTube або Vimeo, а ми
 * зберігаємо його в канонічному вигляді.
 */

export const COURT_PHOTO_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * 1,5 МБ на знімок.
 *
 * Кабінет стискає фото перед відправкою до ~1600 px по довшій стороні, тож
 * справжній файл важить 200–400 КБ. Межа з запасом — для знімка, який
 * браузер стиснути не зміг і надіслав як є.
 */
export const COURT_PHOTO_MAX_BYTES = 1536 * 1024;

/** Вісім знімків на корт: галерея, а не фотоальбом — і стеля для бази. */
export const COURT_PHOTO_LIMIT = 8;

/**
 * Перевірка за вмістом, а не за заявленим Content-Type: заголовок надсилає
 * клієнт, і він може збрехати. SVG не приймаємо навмисно — він виконує
 * скрипти, а віддається з нашого домену.
 */
export function sniffImage(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * Адреса знімка. Мітки часу в ній немає: знімок не замінюється, а
 * видаляється й завантажується новим рядком з новим id — тож адреса
 * незмінна, і браузер може тримати її рік.
 */
export const courtPhotoUrl = (id: string) => `/api/public/courts/photos/${id}`;

export type CourtVideo = { provider: 'youtube' | 'vimeo'; id: string };

const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com']);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{6,12}$/;

/**
 * Розбирає посилання на ролик. Усе, що не YouTube і не Vimeo, — null.
 *
 * Білий список, а не «будь-який https»: адреса потрапляє в <iframe src> на
 * сайті клубу, і довільний хост там — це чужа сторінка всередині віджета.
 * З посилання беремо тільки ідентифікатор ролика, а адресу для плеєра
 * збираємо самі — решта параметрів від користувача туди не доїжджає.
 */
export function parseCourtVideo(input: string): CourtVideo | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') {
    return YOUTUBE_ID.test(parts[0] ?? '') ? { provider: 'youtube', id: parts[0] } : null;
  }

  if (YOUTUBE_HOSTS.has(host)) {
    const id = parts[0] === 'watch'
      ? url.searchParams.get('v') ?? ''
      : ['shorts', 'embed', 'live', 'v'].includes(parts[0] ?? '') ? parts[1] ?? '' : '';
    return YOUTUBE_ID.test(id) ? { provider: 'youtube', id } : null;
  }

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = parts[0] === 'video' ? parts[1] ?? '' : parts[0] ?? '';
    return VIMEO_ID.test(id) ? { provider: 'vimeo', id } : null;
  }

  return null;
}

/** Канонічна адреса ролика — саме вона лягає в базу. */
export function courtVideoUrl(video: CourtVideo): string {
  return video.provider === 'youtube'
    ? `https://www.youtube.com/watch?v=${video.id}`
    : `https://vimeo.com/${video.id}`;
}
