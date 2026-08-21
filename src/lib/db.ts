import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

/** Код помилки Postgres для порушення EXCLUDE-констрейнта */
export const EXCLUSION_VIOLATION = '23P01';

export function isSlotTakenError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  const meta = (e as { meta?: { code?: string } })?.meta?.code;
  if (code === EXCLUSION_VIOLATION || meta === EXCLUSION_VIOLATION) return true;

  // EXCLUDE-констрейнт (на відміну від UNIQUE/P2002) Prisma не розпізнає як
  // PrismaClientKnownRequestError — .code і .meta лишаються undefined. Код
  // Postgres долітає тільки текстом усередині .message необробленого
  // PrismaClientUnknownRequestError, тому перевіряємо і цей шлях.
  const message = (e as { message?: string })?.message ?? '';
  return message.includes(EXCLUSION_VIOLATION);
}

/** Сповіщення адміністратору клубу. Помилка Telegram не має ламати бронь. */
export async function notifyClub(chatId: string | null | undefined, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('[telegram] send failed', e);
  }
}
