import { DateTime } from 'luxon';

import { prisma } from '../db';
import type { ChatMessage } from './clientAssistant';

/**
 * Короткий контекст розмови з ІІ у приватному чаті Telegram.
 *
 * Без нього «а на п'ятницю?» після «що вільно в четвер?» було б питанням без
 * співрозмовника: у кабінеті й віджеті історію тримає фронтенд і шле щоразу,
 * а бот сам нічого не памʼятає між повідомленнями.
 *
 * ── Чому таблиця, а не памʼять процесу ────────────────────────────────────
 * Рестарт на деплої (а вони часті) стер би розмову посеред діалогу, а другий
 * інстанс не бачив би першого. Рядки крихітні, тримаємо добу — таблиця
 * AiChatTurn дешевша за розбір скарг «бот забув, про що ми говорили».
 *
 * ── Ізоляція ──────────────────────────────────────────────────────────────
 * Ключ = (чат, клуб, режим). Розмова персоналу ('staff') і гравця ('player')
 * ніколи не змішуються, як і розмови різних клубів: змінив клуб — починаєш з
 * чистого аркуша. Додатково чат чиститься на /start, виході й зміні клубу.
 *
 * ── Що там лежить ─────────────────────────────────────────────────────────
 * Лише текст запитань і відповідей (≤ 2000 символів кожен), без результатів
 * інструментів. Живе добу й зникає разом із клубом (каскад) та в нічному
 * прибиранні.
 */

export type ChatMode = 'staff' | 'player';

/** Скільки ходів (запитання+відповідь) повертаємо моделі */
export const CONTEXT_TURNS = 10;
export const CONTEXT_TTL_MS = 24 * 3600_000;
export const TURN_MAX_CHARS = 2000;

const clip = (s: string) => (s.length > TURN_MAX_CHARS ? s.slice(0, TURN_MAX_CHARS) : s);

/** Історія для моделі: від старого до нового, починається завжди з питання людини. */
export async function loadContext(chatId: string, clubId: string, mode: ChatMode, now: Date = new Date()): Promise<ChatMessage[]> {
  const rows = await prisma.aiChatTurn.findMany({
    where: { chatId, clubId, mode, createdAt: { gt: new Date(now.getTime() - CONTEXT_TTL_MS) } },
    orderBy: { createdAt: 'desc' },
    take: CONTEXT_TURNS * 2,
    select: { role: true, content: true },
  });
  const list = rows.reverse().map((r) => ({ role: r.role === 'assistant' ? 'assistant' as const : 'user' as const, content: r.content }));
  /* Обрізаний з голови список міг почати з відповіді: Gemini чекає, що розмова відкривається словами людини. */
  while (list.length && list[0].role !== 'user') list.shift();
  return list;
}

/** Зберегти хід. Відповідь на мілісекунду пізніше за питання, щоб порядок був однозначним. */
export async function saveTurn(
  chatId: string, clubId: string, mode: ChatMode, question: string, answer: string, now: Date = new Date(),
): Promise<void> {
  await prisma.aiChatTurn.createMany({
    data: [
      { chatId, clubId, mode, role: 'user', content: clip(question), createdAt: now },
      { chatId, clubId, mode, role: 'assistant', content: clip(answer), createdAt: new Date(now.getTime() + 1) },
    ],
  });
}

/**
 * Забути розмову цього чату (усі клуби й режими). Помилку ковтаємо: скидання —
 * побічна дія /start чи виходу, і вони не мають падати, якщо база смикнулась.
 */
export async function resetContext(chatId: string): Promise<void> {
  try {
    await prisma.aiChatTurn.deleteMany({ where: { chatId } });
  } catch {
    console.warn('[ai] chat context reset failed');
  }
}

/** Нічне прибирання: усе, що старше за добу, моделі вже не віддається. */
export async function purgeOldTurns(now: Date = new Date()): Promise<number> {
  const cutoff = DateTime.fromJSDate(now).minus({ milliseconds: CONTEXT_TTL_MS }).toJSDate();
  const { count } = await prisma.aiChatTurn.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}
