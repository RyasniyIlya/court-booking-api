import { PrismaClient } from '@prisma/client';
import { sendMessage } from './telegram';

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
  if (!chatId) return;
  try {
    // Єдиний Telegram-транспорт має таймаут і однакову обробку помилок.
    // Так завислий Telegram не накопичує відкриті запити в API.
    await sendMessage(chatId, text);
  } catch (e) {
    console.error('[telegram] send failed', e);
  }
}
