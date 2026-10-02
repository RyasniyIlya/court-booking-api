/** Escape dynamic text before inserting it into Telegram parse_mode HTML. */
export const telegramHtml = (value: string) => value
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
