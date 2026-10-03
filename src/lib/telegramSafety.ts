import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Запобіжник вихідного Telegram-трафіку для пілоту.
 *
 * TELEGRAM_SEND_MODE:
 *   live       (за замовчуванням, також якщо змінна порожня) — поведінка без змін;
 *   allowlist  — слати лише в чати з TELEGRAM_ALLOWLIST_CHAT_IDS (через кому),
 *                решту пропускати й рахувати;
 *   dry        — нічого не слати, у лог іде тільки хеш чату й назва шаблону.
 *
 * Невідоме значення (одруківка) трактуємо як dry: помилка в налаштуванні не
 * має мовчки вмикати бойову розсилку.
 *
 * Тексти повідомлень сюди не потрапляють ніколи — вони містять імена й
 * телефони гравців.
 */

export type SendMode = 'live' | 'allowlist' | 'dry';

let warnedBadMode = false;

export function sendMode(env: NodeJS.ProcessEnv = process.env): SendMode {
  const raw = (env.TELEGRAM_SEND_MODE ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'live') return 'live';
  if (raw === 'allowlist' || raw === 'dry') return raw;
  if (!warnedBadMode) {
    warnedBadMode = true;
    console.warn('[telegram] невідомий TELEGRAM_SEND_MODE — працюю як dry (нічого не шлю)');
  }
  return 'dry';
}

export function allowlist(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.TELEGRAM_ALLOWLIST_CHAT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

/** Короткий незворотний відбиток чату для логів. */
export function chatHash(chatId: string | number): string {
  return createHash('sha256').update(`tg-chat:${chatId}`).digest('hex').slice(0, 10);
}

export type Verdict = 'send' | 'skip-dry' | 'skip-allowlist';

/** Рішення для одного повідомлення. chatId відсутній (answerCallback) — у allowlist пропускаємо як «своє». */
export function verdictFor(chatId: string | number | undefined, env: NodeJS.ProcessEnv = process.env): Verdict {
  const mode = sendMode(env);
  if (mode === 'live') return 'send';
  if (mode === 'dry') return 'skip-dry';
  if (chatId === undefined || chatId === null) return 'send';
  return allowlist(env).has(String(chatId)) ? 'send' : 'skip-allowlist';
}

/* ── Лічильники ─────────────────────────────────────────────────────────── */

export type SendStats = { sent: number; skipped: number; failed: number };

type Scope = SendStats & { template: string };
const als = new AsyncLocalStorage<Scope>();

const totals: SendStats = { sent: 0, skipped: 0, failed: 0 };

export const getSendStats = (): SendStats => ({ ...totals });
export const resetSendStats = () => { totals.sent = 0; totals.skipped = 0; totals.failed = 0; };

export function currentTemplate(fallback: string): string {
  return als.getStore()?.template ?? fallback;
}

export function countSend(kind: keyof SendStats) {
  totals[kind] += 1;
  const scope = als.getStore();
  if (scope) scope[kind] += 1;
}

/**
 * Обгортка масової розсилки: один підсумковий рядок sent/skipped/failed.
 * Назва використовується і як «шаблон» у dry-логах. Мовчить, якщо тік нічого не
 * чіпав, щоб хвилинні тіки не засмічували лог.
 */
export async function withSendSummary<T>(template: string, fn: () => Promise<T>): Promise<T> {
  const scope: Scope = { template, sent: 0, skipped: 0, failed: 0 };
  try {
    return await als.run(scope, fn);
  } finally {
    if (scope.sent + scope.skipped + scope.failed > 0) {
      console.log(`[telegram-summary] ${template} mode=${sendMode()} sent=${scope.sent} skipped=${scope.skipped} failed=${scope.failed}`);
    }
  }
}
