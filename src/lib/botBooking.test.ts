import { describe, expect, it } from 'vitest';

/** Мітки, з якими бот веде на сторінку запису (див. botBooking.ts). */
const TAGS = 'utm_source=telegram&utm_medium=messaging&utm_campaign=bot';
import { bookingUrl, clubChoiceKeyboard, clubStartPayload, openBookingKeyboard, openProfileKeyboard, profileUrl, slugFromStartPayload } from './botBooking';

describe('Telegram player booking', () => {
  it('round-trips a club slug through a Telegram deep link payload', () => {
    expect(slugFromStartPayload(clubStartPayload('dynamo-tennis'))).toBe('dynamo-tennis');
    expect(slugFromStartPayload('club_../secret')).toBeNull();
  });

  /* Посилання бота несуть мітку: бот сам броней не створює, і без неї
     його записи зливаються з прямими заходами — тобто питання «чи
     потрібен нам бот» лишається без відповіді в цифрах. */
  it('builds the public club URL and a Telegram Web App button', () => {
    const env = { PUBLIC_WEB_URL: 'https://booking.example.com/' } as NodeJS.ProcessEnv;
    expect(bookingUrl('dynamo-tennis', env)).toBe('https://booking.example.com/c/dynamo-tennis?' + TAGS);
    expect(openBookingKeyboard('dynamo-tennis', env)?.inline_keyboard[0][0]).toHaveProperty('web_app.url');
  });

  it('opens a linked player directly on the profile screen', () => {
    const env = { PUBLIC_WEB_URL: 'https://booking.example.com/' } as NodeJS.ProcessEnv;
    expect(profileUrl('dynamo-tennis', env)).toBe('https://booking.example.com/c/dynamo-tennis?cbProfile=1&' + TAGS);
    /* Мітки мають приклеїтись рівно один раз. */
    expect(profileUrl('dynamo-tennis', env)!.match(/utm_source/g)).toHaveLength(1);
    expect(openProfileKeyboard('dynamo-tennis', env)?.inline_keyboard[0][0])
      .toEqual({ text: 'Відкрити мій профіль', web_app: { url: 'https://booking.example.com/c/dynamo-tennis?cbProfile=1&' + TAGS } });
  });

  it('creates one safe callback button per club', () => {
    expect(clubChoiceKeyboard([{ name: 'Динамо', slug: 'dynamo' }]))
      .toEqual({ inline_keyboard: [[{ text: '🎾 Динамо', callback_data: 'bookclub:dynamo' }]] });
  });
});
