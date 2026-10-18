import type { UserRole } from '@prisma/client';

import { prisma } from './db';
import { planFeatures } from './plans';
import { escapeHtml, normalizeBotSettings } from './clubBot';
import { AiActionError, approveAction, rejectAction } from './ai/actions';
import type { ProposedAction } from './ai/managerTools';
import { answerCallback, editMessageReplyMarkup, sendMessage, type TgUpdate } from './telegram';

/**
 * ІІ-менеджер у Telegram: сводка, кнопки «Підтвердити / Відхилити» і сповіщення
 * про нові пропозиції.
 *
 * Рішення по дії ухвалює той самий `approveAction` / `rejectAction`, що й
 * кабінет: він сам перевіряє клуб, строк, подвійний клік і політику ще раз.
 * Цей модуль додає лише транспорт — хто натиснув і як це виглядає в чаті.
 */

/** Ліміт Telegram на один текст. Ріжемо з запасом: сутності (&amp;) теж рахуються. */
export const TG_LIMIT = 4096;
const CHUNK = 3800;

/** Скільки дій з кнопками показуємо в одній сводці. */
export const MAX_SHOWN_ACTIONS = 3;

const ROLE_LABEL: Record<UserRole, string> = {
  OWNER: 'власник',
  ADMIN: 'адміністратор',
  TRAINER: 'тренер',
  ACCOUNTANT: 'бухгалтер',
};
export const roleLabel = (role: UserRole) => ROLE_LABEL[role] ?? 'співробітник';

/* ── Текст ───────────────────────────────────────────────────────────────── */

/**
 * Відповідь моделі (markdown) → безпечний Telegram HTML.
 *
 * Спершу екрануємо ВСЕ, потім повертаємо лише наші теги: модель може написати
 * «<», а Telegram відкине все повідомлення через один незакритий тег. Дозволяємо
 * тільки <b> — заголовки й **жирний**; решта markdown лишається звичайним текстом.
 */
export function briefToTelegramHtml(markdown: string): string {
  return escapeHtml(markdown.replace(/\r\n/g, '\n'))
    .split('\n')
    .map((line) => {
      const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
      if (heading) return `<b>${heading[1].replace(/\*\*/g, '').trim()}</b>`;
      return line
        .replace(/^\s*[*-]\s+/, '• ')
        .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
    })
    .join('\n')
    .trim();
}

/**
 * Розбити довгий текст на повідомлення ≤ ліміту, лише по межах рядків: теги
 * (<b>…</b>) у нас завжди в межах одного рядка, тож розріз не ламає розмітку.
 */
export function splitTelegram(html: string, max = CHUNK): string[] {
  const parts: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) parts.push(cur.trim());
    cur = '';
  };

  for (let line of html.split('\n')) {
    /* Рядок довший за ліміт (суцільне полотно без переносів) ріжемо жорстко,
       але не всередині сутності «&amp;» і не всередині <b>…</b>. */
    while (line.length > max) {
      let cut = line.lastIndexOf(' ', max);
      if (cut < max / 2) cut = max;
      const amp = line.lastIndexOf('&', cut);
      if (amp > cut - 6 && !line.slice(amp, cut).includes(';')) cut = amp;
      let head = line.slice(0, cut).trim();
      let tail = line.slice(cut).trim();
      /* Розріз посеред <b>: закриваємо в першій частині й відкриваємо в другій. */
      if (head.split('<b>').length > head.split('</b>').length) {
        head += '</b>';
        tail = `<b>${tail}`;
      }
      push();
      parts.push(head);
      line = tail;
    }
    if (cur.length + line.length + 1 > max) push();
    cur += (cur ? '\n' : '') + line;
  }
  push();
  return parts;
}

/* ── Пропозиції: текст і кнопки ──────────────────────────────────────────── */

export type ShownAction = {
  id: string;
  summary: string;
  status: string;
  error: string | null;
  /** Додаткові рядки під пунктом (приклади листів) — звичайний текст, екрануємо при показі */
  details?: string[];
};

/** Скільки прикладів листів показуємо в сводці: власнику треба побачити тон, а не прочитати всі 25. */
const SAMPLE_LETTERS = 2;
const SAMPLE_CHARS = 140;

/**
 * Картка пропозиції для Telegram. Для листів повернення — кількість адресатів
 * і 1–2 приклади текстів (імена вже лише перші, з payload).
 */
export function toShownAction(a: ProposedAction): ShownAction {
  const shown: ShownAction = { id: a.id, summary: a.summary, status: a.status, error: a.error };
  if (a.kind === 'winback.campaign') {
    const recipients = (a.payload as { recipients?: Array<{ name?: unknown; text?: unknown }> } | null)?.recipients;
    if (Array.isArray(recipients) && recipients.length) {
      const sample = recipients.slice(0, SAMPLE_LETTERS).map((r) => {
        const text = String(r.text ?? '').replace(/\s+/g, ' ').trim();
        return `${String(r.name ?? 'Клієнт')}: «${text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS)}…` : text}»`;
      });
      shown.details = [`Адресатів: ${recipients.length}. Приклади:`, ...sample];
    }
  }
  return shown;
}

/** Пояснення збою для власника: тут лише відомий український текст (див. actions.ts), не сирий виняток. */
const failedLine = (a: ShownAction) => `⚠️ не виконано${a.error ? `: ${escapeHtml(a.error.slice(0, 200))}` : ''}`;

/** Блок «Пропозиції»: PENDING — з номером під кнопки, виконані й збійні — інформаційно. */
export function actionsBlock(
  actions: ShownAction[],
  title = '<b>Пропозиції ІІ</b>',
): { text: string; keyboard: { inline_keyboard: { text: string; callback_data: string }[][] } | undefined } {
  const live = actions.filter((a) => ['PENDING', 'EXECUTED', 'FAILED'].includes(a.status));
  const visible = live.slice(0, MAX_SHOWN_ACTIONS);
  if (visible.length === 0) return { text: '', keyboard: undefined };

  const pending = visible.filter((a) => a.status === 'PENDING');
  const lines = visible.map((a, i) => {
    const tail = a.status === 'PENDING' ? 'чекає вашого рішення' : a.status === 'EXECUTED' ? '✅ виконано автоматично' : failedLine(a);
    const head = `${i + 1}. ${escapeHtml(a.summary)} — ${tail}`;
    const extra = (a.details ?? []).map((d) => `   ${escapeHtml(d)}`);
    return [head, ...extra].join('\n');
  });
  const more = live.length - visible.length;
  if (more > 0) lines.push(`…ще ${more} у черзі дій у кабінеті.`);

  /* Номер на кнопці потрібен лише коли дій кілька: інакше незрозуміло, до якої з них «Підтвердити». */
  const keyboard = pending.length
    ? {
      inline_keyboard: pending.map((a) => {
        const n = visible.length > 1 ? ` ${visible.indexOf(a) + 1}` : '';
        return [
          { text: `✅ Підтвердити${n}`, callback_data: `ai:ok:${a.id}` },
          { text: `❌ Відхилити${n}`, callback_data: `ai:no:${a.id}` },
        ];
      }),
    }
    : undefined;

  return { text: `${title}\n${lines.join('\n')}`, keyboard };
}

/* ── Кнопки: рішення власника ────────────────────────────────────────────── */

/** callback_data: `ai:ok:<uuid>` (42 байти) — з запасом у межах 64. */
const CALLBACK = /^ai:(ok|no):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Кнопка-підсумок на місці ряду «Підтвердити/Відхилити»; її натискання гасимо через `ai:done`. */
const resultRow = (text: string) => [{ text: text.slice(0, 60), callback_data: 'ai:done' }];

/**
 * Натискання кнопок ІІ. true — це «наша» кнопка (оброблена чи відхилена), false — не ІІ.
 *
 * Хто натиснув, визначаємо за привʼязкою чату до акаунта, а не за id дії: id
 * лежить у callback_data, і підроблений запит з чужим id не дає нічого, бо
 * `approveAction` шукає дію тільки серед дій клубу цього власника.
 */
export async function handleAiCallback(q: NonNullable<TgUpdate['callback_query']>): Promise<boolean> {
  if (!q.data?.startsWith('ai:')) return false;

  if (q.data === 'ai:done') {
    await answerCallback(q.id, 'Вже вирішено');
    return true;
  }
  const m = CALLBACK.exec(q.data);
  if (!m) {
    await answerCallback(q.id);
    return true;
  }
  const verb = m[1];
  const id = m[2].toLowerCase();
  const chatId = String(q.message?.chat.id ?? q.from?.id ?? '');

  const me = chatId
    ? await prisma.user.findUnique({
      where: { tgChatId: chatId },
      select: { id: true, role: true, club: { select: { id: true, plan: true } } },
    })
    : null;
  if (!me) {
    await answerCallback(q.id, 'Спершу увійдіть: /login пошта пароль');
    return true;
  }
  /* Рішення по діях клубу — тільки власник. Модератор і тренер у цьому чаті бачать лише відмову. */
  if (me.role !== 'OWNER' || !planFeatures(me.club.plan).ai) {
    await answerCallback(q.id, 'Рішення по діях ІІ приймає лише власник клубу');
    return true;
  }

  let label: string;
  try {
    const owner = { id: me.id, clubId: me.club.id };
    if (verb === 'no') {
      await rejectAction(id, owner);
      label = '❌ Відхилено';
    } else {
      const row = await approveAction(id, owner);
      label = row.status === 'EXECUTED' ? '✅ Виконано' : `⚠️ Не виконано: ${row.error ?? 'помилка'}`;
    }
  } catch (e) {
    if (!(e instanceof AiActionError)) {
      console.error('[ai] telegram decision failed', e);
      await answerCallback(q.id, 'Не вдалося. Спробуйте в кабінеті.');
      return true;
    }
    if (e.code === 'AI_ACTION_NOT_FOUND') {
      /* Чужий клуб і неіснуючий id — однаково: нічого не міняємо й нічого не підказуємо. */
      await answerCallback(q.id, 'Дію не знайдено');
      return true;
    }
    label = e.code === 'AI_ACTION_EXPIRED' ? 'Термін вийшов' : 'Вже вирішено';
  }

  await answerCallback(q.id, label);
  await replaceRow(q, chatId, id, label);
  return true;
}

/** Ряд кнопок цієї дії → підсумок; ряди інших дій сводки лишаються робочими. */
async function replaceRow(q: NonNullable<TgUpdate['callback_query']>, chatId: string, id: string, label: string) {
  const msg = q.message;
  const rows = msg?.reply_markup?.inline_keyboard;
  if (!msg || !rows) return;
  const next = rows.map((row) => (row.some((b) => b.callback_data?.endsWith(`:${id}`)) ? resultRow(label) : row));
  await editMessageReplyMarkup(chatId, msg.message_id, { inline_keyboard: next });
}

/* ── Сповіщення про нові пропозиції ──────────────────────────────────────── */

/** Вікно групування: чат, що за хвилину створив три дії, дає одне повідомлення, а не три. */
const ALERT_WINDOW_MS = 60_000;

type Batch = { actions: ShownAction[]; roles: Set<UserRole>; timer: NodeJS.Timeout };
const batches = new Map<string, Batch>();

/**
 * Повідомити власника про пропозиції, що чекають рішення (з чату кабінету).
 *
 * У памʼяті процесу, без черги: якщо сервер перезапуститься в ці 60 секунд,
 * сповіщення втратиться, але сама пропозиція лишається в «Черзі дій» і живе
 * 48 годин — це зручність, а не єдиний канал.
 */
export function queueActionAlert(clubId: string, requesterRole: UserRole, actions: ShownAction[], windowMs = ALERT_WINDOW_MS): void {
  const pending = actions.filter((a) => a.status === 'PENDING');
  if (pending.length === 0) return;

  const existing = batches.get(clubId);
  if (existing) {
    existing.actions.push(...pending);
    existing.roles.add(requesterRole);
    return;
  }
  const timer = setTimeout(() => {
    const b = batches.get(clubId);
    batches.delete(clubId);
    if (b) void flushAlert(clubId, b).catch((e) => console.error('[ai-alert] не вдалося надіслати', e));
  }, windowMs);
  timer.unref?.();
  batches.set(clubId, { actions: [...pending], roles: new Set([requesterRole]), timer });
}

async function flushAlert(clubId: string, b: Pick<Batch, 'actions' | 'roles'>): Promise<number> {
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: {
      botSettings: true,
      plan: true,
      users: { where: { role: 'OWNER', tgChatId: { not: null } }, select: { tgChatId: true } },
    },
  });
  if (!club || !planFeatures(club.plan).ai || !normalizeBotSettings(club.botSettings).actionAlerts) return 0;

  const who = [...b.roles].map(roleLabel).join(', ');
  const { text, keyboard } = actionsBlock(b.actions, `🤖 <b>ІІ-менеджер пропонує дії</b> (запросив: ${escapeHtml(who)})`);
  if (!text) return 0;

  let sent = 0;
  for (const u of club.users) {
    if (u.tgChatId && await sendMessage(u.tgChatId, text, keyboard)) sent += 1;
  }
  return sent;
}

/** Для тестів: надіслати відкладене негайно. */
export async function flushAlertsNow(): Promise<void> {
  for (const [clubId, b] of [...batches]) {
    clearTimeout(b.timer);
    batches.delete(clubId);
    await flushAlert(clubId, b);
  }
}

/** Для тестів. */
export function resetAlerts(): void {
  for (const b of batches.values()) clearTimeout(b.timer);
  batches.clear();
}
