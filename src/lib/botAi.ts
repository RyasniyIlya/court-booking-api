import type { UserRole } from '@prisma/client';

import { prisma } from './db';
import { planFeatures } from './plans';
import { normalizeBotSettings, escapeHtml } from './clubBot';
import { openBookingKeyboard } from './botBooking';
import { chatClubs, pickActiveClub } from './playerHome';
import { sendChatAction, sendMessage } from './telegram';
import { actionsBlock, briefToTelegramHtml, queueActionAlert, splitTelegram, toShownAction } from './aiTelegram';
import { AiError, aiConfigured } from './ai/gemini';
import { clientAssistant } from './ai/clientAssistant';
import { loadPlayerProfile, type PlayerProfile } from './ai/playerContext';
import { ownerAssistant } from './ai/ownerAssistant';
import { CHAT_MAX_PROPOSALS } from './ai/managerTools';
import { effectivePermissions } from './ai/policy';
import { loadPolicy } from './ai/policyStore';
import { envLimit, takeQuota } from './ai/quota';
import { loadContext, saveTurn } from './ai/chatContext';
import './ai/executors';

/**
 * Вільний текст у приватному чаті бота → ІІ (етап 5).
 *
 * Сюди потрапляє лише те, що не розпізнав жоден інший обробник: команди,
 * підписи кнопок клавіатури й покроковий вхід гравця мають пріоритет і
 * відпрацьовують як раніше (див. порядок у botHandlers.handleUpdate). Групи
 * сюди не доходять взагалі — їх відсікає захист на вході.
 *
 * ── Хто з ким розмовляє ───────────────────────────────────────────────────
 * Чат привʼязаний до акаунта персоналу (User) → ІІ-менеджер з ПРАВАМИ ЦІЄЇ
 * РОЛІ, ті самі, що в кабінеті: політика, відфільтровані інструменти, стеля
 * пропозицій. Чат привʼязаний до картки гравця → помічник клубу для гравців,
 * який бачить лише публічну інформацію клубу й профіль САМОЇ ЦІЄЇ людини.
 * Тексти гравців до інструментів персоналу фізично не доходять: це різні
 * функції з різними наборами інструментів, а не один промпт з «режимом».
 * Чужий чат отримує лише підказку, як увійти, — без звернення до моделі.
 *
 * ── Гроші ─────────────────────────────────────────────────────────────────
 * Кожна відповідь — платний виклик. Тому до моделі ми доходимо лише після:
 * тариф з ІІ + ключ на сервері → вмикач власника → захист від флуду (не частіше
 * ніж раз на 3 с і не паралельно) → добовий ліміт у базі (гравцю — свій,
 * персоналу — спільний із кабінетом). Жодна з відмов не викликає модель.
 *
 * ── Не блокуємо вебхук ────────────────────────────────────────────────────
 * Відповідь моделі може тривати десятки секунд; якщо тримати вебхук відкритим,
 * Telegram повторить оновлення, і ми заплатимо двічі. Тому перевірки йдуть
 * синхронно, а виклик моделі — у фоні; помилки фону ловимо тут і в лог пишемо
 * лише код.
 */

/* ── Тексти ─────────────────────────────────────────────────────────────── */

export const UNKNOWN_HINT =
  'Щоб я міг допомогти, спершу увійдіть.\n'
  + '• Гравець: /profile — вхід у профіль клубу.\n'
  + '• Команда клубу: <code>/login пошта пароль</code>.\n'
  + 'Усі команди — /help.';

const TEXT = {
  noAiStaff: '🤖 ІІ-менеджер у боті недоступний: потрібен тариф «Аналітика» і підключений ІІ.',
  offStaff: '🤖 Розмову з ІІ у боті вимкнено власником клубу (Налаштування бота → ІІ-менеджер).',
  noAccess: '🤖 Власник клубу не відкрив вашій ролі доступ до ІІ-менеджера.',
  noAiPlayer: 'Помічник у чаті зараз недоступний. Забронювати корт можна командою /book.',
  offPlayer: 'Клуб ще не підключив помічника в чаті. Забронювати корт можна командою /book.',
  tooLong: 'Повідомлення задовге — стисніть його до одного-двох речень.',
  busy: 'Секунду — я ще відповідаю на попереднє повідомлення.',
  limitStaff: 'Добовий ліміт запитів до ІІ вичерпано. Спробуйте завтра або скористайтеся кабінетом.',
  limitPlayer: 'На сьогодні ліміт запитів до помічника вичерпано. Забронювати корт можна командою /book.',
  failedStaff: 'Не вдалося отримати відповідь від ІІ. Спробуйте ще раз за хвилину.',
  failedPlayer: 'Вибачте, зараз не вдалося відповісти. Спробуйте пізніше або скористайтеся командою /book.',
  blocked: 'Не можу відповісти на це запитання. Спробуйте сформулювати інакше.',
} as const;

/** Скільки символів приймаємо: кабінет пускає 2000, віджет гравця — 1000 */
export const STAFF_MAX_CHARS = 2000;
export const PLAYER_MAX_CHARS = 1000;

/** Між двома запитами до ІІ з одного чату — не менше */
export const FLOOD_MS = 3000;

/* ── Захист від флуду й фонові задачі ───────────────────────────────────── */

const lastAt = new Map<string, number>();
const inflight = new Set<string>();
const tasks = new Set<Promise<void>>();

/**
 * Забрати чат під запит: false, якщо попередній ще йде або минуло менше FLOOD_MS.
 * У памʼяті процесу — навмисно: це швидкий запобіжник від «затиснув відправку»,
 * а не облік грошей (його робить база). Після рестарту він просто порожній.
 */
function claimChat(chatId: string, now = Date.now()): boolean {
  if (inflight.has(chatId)) return false;
  const last = lastAt.get(chatId);
  if (last !== undefined && now - last < FLOOD_MS) return false;
  if (lastAt.size > 5000) {
    for (const [k, t] of lastAt) if (now - t > 60_000) lastAt.delete(k);
  }
  inflight.add(chatId);
  lastAt.set(chatId, now);
  return true;
}

function releaseChat(chatId: string): void {
  inflight.delete(chatId);
  lastAt.set(chatId, Date.now());
}

/** Для тестів: скинути стан захисту. */
export function resetAiGuard(): void {
  lastAt.clear();
  inflight.clear();
}

/** Для тестів: дочекатись усіх фонових відповідей. */
export async function settleAiTasks(): Promise<void> {
  await Promise.allSettled([...tasks]);
}

function background(job: Promise<void>): void {
  const p = job.catch(() => { console.error('[ai] bot background task failed'); });
  tasks.add(p);
  void p.finally(() => tasks.delete(p));
}

/** «Друкує…» на час очікування моделі; Telegram гасить індикатор через ~5 с, тож оновлюємо. */
function startTyping(chatId: string): () => void {
  void sendChatAction(chatId);
  const timer = setInterval(() => { void sendChatAction(chatId); }, 4500);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Відповідь моделі → екранований HTML, порізаний під ліміт Telegram. */
export async function sendLong(chatId: string, markdown: string, markup?: unknown): Promise<void> {
  const parts = splitTelegram(briefToTelegramHtml(markdown));
  if (parts.length === 0) return;
  for (let i = 0; i < parts.length; i++) {
    await sendMessage(chatId, parts[i], i === parts.length - 1 ? markup : undefined);
  }
}

const logFail = (who: string, e: unknown) =>
  console.error(`[ai] bot ${who} chat failed:`, e instanceof AiError ? e.code : 'unexpected');

/* ── Персонал ───────────────────────────────────────────────────────────── */

export type StaffChat = {
  id: string;
  role: UserRole;
  club: { id: string; name: string; timezone: string; plan: Parameters<typeof planFeatures>[0] };
};

/**
 * Вільний текст від персоналу. `menu` і `keyboard` — те, що бот і так показує на
 * незрозуміле повідомлення: коли ІІ недоступний, поведінка лишається знайомою.
 */
export async function handleStaffAiText(
  chatId: string,
  text: string,
  me: StaffChat,
  ui: { menu: string; keyboard: unknown },
): Promise<void> {
  const reply = (body: string) => sendMessage(chatId, `${body}\n\n${ui.menu}`, ui.keyboard);

  if (!planFeatures(me.club.plan).ai || !aiConfigured()) { await reply(TEXT.noAiStaff); return; }

  const club = await prisma.club.findUnique({
    where: { id: me.club.id },
    select: { id: true, name: true, timezone: true, address: true, botSettings: true },
  });
  if (!club) { await reply(TEXT.noAiStaff); return; }
  if (!normalizeBotSettings(club.botSettings).aiChat.staff) { await reply(TEXT.offStaff); return; }

  const perms = effectivePermissions(await loadPolicy(club.id), me.role);
  if (!perms.access) { await reply(TEXT.noAccess); return; }

  if (text.length > STAFF_MAX_CHARS) { await sendMessage(chatId, TEXT.tooLong); return; }
  if (!claimChat(chatId)) { await sendMessage(chatId, TEXT.busy); return; }

  /* Далі будь-який вихід має відпустити чат, інакше він «завис» би до рестарту. */
  let started = false;
  try {
    /* Той самий лічильник, що й у кабінеті: власник не отримує окремих 100 запитів у Telegram. */
    if (!await takeQuota('owner', club.id, envLimit('AI_OWNER_DAILY_LIMIT', 100), { timezone: club.timezone })) {
      await sendMessage(chatId, TEXT.limitStaff);
      return;
    }
    started = true;
    background(runStaff(chatId, text, me, club, perms).finally(() => releaseChat(chatId)));
  } finally {
    if (!started) releaseChat(chatId);
  }
}

async function runStaff(
  chatId: string,
  text: string,
  me: StaffChat,
  club: { id: string; name: string; timezone: string; address: string | null },
  perms: ReturnType<typeof effectivePermissions>,
): Promise<void> {
  const stopTyping = startTyping(chatId);
  try {
    const history = await loadContext(chatId, club.id, 'staff').catch(() => []);
    const out = await ownerAssistant({
      club,
      messages: [...history, { role: 'user', content: text }],
      perms,
      role: me.role,
      manager: { requester: { id: me.id, role: me.role }, maxProposals: CHAT_MAX_PROPOSALS },
    });
    console.log(`[ai] bot staff chat steps=${out.steps} tokens=${out.tokens} actions=${out.actions.length}`);
    await saveTurn(chatId, club.id, 'staff', text, out.reply).catch(() => console.warn('[ai] chat context save failed'));

    await sendLong(chatId, out.reply);
    await sendProposals(chatId, club.id, me.role, out.actions.map(toShownAction));
  } catch (e) {
    logFail('staff', e);
    await sendMessage(chatId, e instanceof AiError && e.code === 'AI_BLOCKED' ? TEXT.blocked : TEXT.failedStaff);
  } finally {
    stopTyping();
  }
}

/**
 * Пропозиції ІІ після відповіді.
 *
 * Кнопки «Підтвердити / Відхилити» отримує лише власник, і тільки в своєму
 * чаті. Для решти ролей пропозиція, що чекає рішення, кнопок не має: людина
 * дізнається, що вона пішла власнику, а власник отримує сповіщення етапу 3
 * (queueActionAlert, з кнопками і з указанням, хто просив). Рішення все одно
 * приймає approveAction, який перевіряє роль ще раз, — це лише інтерфейс.
 */
async function sendProposals(chatId: string, clubId: string, role: UserRole, shown: ReturnType<typeof toShownAction>[]) {
  if (shown.length === 0) return;

  if (role === 'OWNER') {
    const { text, keyboard } = actionsBlock(shown);
    if (text) await sendMessage(chatId, text, keyboard);
    return;
  }

  const pending = shown.filter((a) => a.status === 'PENDING');
  const decided = actionsBlock(shown.filter((a) => a.status !== 'PENDING'), '<b>Дії ІІ</b>');
  if (decided.text) await sendMessage(chatId, decided.text);
  if (pending.length) {
    await sendMessage(chatId, `📨 Пропозицій передано власнику клубу: ${pending.length}. Вони виконаються лише після його підтвердження.`);
    queueActionAlert(clubId, role, pending);
  }
}

/* ── Гравець ────────────────────────────────────────────────────────────── */

/**
 * Вільний текст від гравця. false — чат не привʼязаний до жодної картки (це
 * «чужий» чат: викликач покаже підказку про вхід, модель не чіпаємо).
 */
export async function handlePlayerAiText(chatId: string, text: string): Promise<boolean> {
  /* «Поточний» клуб — той самий, що відкриває /start: де гравець був останнім. */
  const pick = pickActiveClub(await chatClubs(chatId));
  if (!pick) return false;

  const club = await prisma.club.findUnique({
    where: { id: pick.club.id },
    select: { id: true, slug: true, name: true, timezone: true, botSettings: true, plan: true },
  });
  if (!club) return false;

  if (!planFeatures(club.plan).ai || !aiConfigured()) { await sendMessage(chatId, TEXT.noAiPlayer); return true; }
  if (!normalizeBotSettings(club.botSettings).aiChat.players) { await sendMessage(chatId, TEXT.offPlayer); return true; }
  if (text.length > PLAYER_MAX_CHARS) { await sendMessage(chatId, TEXT.tooLong); return true; }
  if (!claimChat(chatId)) { await sendMessage(chatId, TEXT.busy); return true; }

  let started = false;
  try {
    const tz = { timezone: club.timezone };
    /* Спершу свій ліміт гравця (захист від одного балакуна), потім стеля клубу, спільна з віджетом. */
    const ok = await takeQuota(`bot:player:${pick.customerId}`, club.id, envLimit('AI_BOT_PLAYER_DAILY', 20), tz)
      && await takeQuota('client', club.id, envLimit('AI_CLIENT_DAILY_LIMIT', 300), tz);
    if (!ok) { await sendMessage(chatId, TEXT.limitPlayer); return true; }

    started = true;
    background(runPlayer(chatId, text, pick.customerId, club).finally(() => releaseChat(chatId)));
    return true;
  } finally {
    if (!started) releaseChat(chatId);
  }
}

async function runPlayer(
  chatId: string,
  text: string,
  customerId: string,
  club: { id: string; slug: string; name: string; timezone: string },
): Promise<void> {
  const stopTyping = startTyping(chatId);
  try {
    /* Профіль — покращення, не умова (як у віджеті): збій = розмова як з гостем. */
    let profile: PlayerProfile | null = null;
    try {
      profile = await loadPlayerProfile(customerId, club.id);
    } catch {
      console.error('[ai] bot player profile failed, falling back to guest');
    }

    const history = await loadContext(chatId, club.id, 'player').catch(() => []);
    const out = await clientAssistant({
      slug: club.slug,
      clubName: club.name,
      timezone: club.timezone,
      messages: [...history, { role: 'user', content: text }],
      profile,
      channel: 'telegram',
    });
    console.log(`[ai] bot player chat steps=${out.steps} tokens=${out.tokens} offers=${out.actions.length}`);
    await saveTurn(chatId, club.id, 'player', text, out.reply).catch(() => console.warn('[ai] chat context save failed'));

    await sendLong(chatId, out.reply);

    /* Бронь ботом НЕ створюється. Слот, який підібрала модель, лише названо в повідомленні;
       створює його гравець сам у розкладі клубу, де сервер ще раз перевіряє вільність. */
    if (out.actions.length) {
      const lines = out.actions.slice(0, 3).map((a) => `🎾 ${escapeHtml(a.courtName)} · ${escapeHtml(a.date)} ${escapeHtml(a.time)}`);
      const kb = openBookingKeyboard(club.slug);
      await sendMessage(
        chatId,
        `${lines.join('\n')}\n\n${kb ? 'Відкрийте розклад клубу й підтвердіть запис кнопкою — доки ви її не натиснете, бронь не створюється.' : 'Щоб підтвердити запис, скористайтеся командою /book — бронь створюється лише після вашого підтвердження.'}`,
        kb,
      );
    }
  } catch (e) {
    logFail('player', e);
    await sendMessage(chatId, e instanceof AiError && e.code === 'AI_BLOCKED' ? TEXT.blocked : TEXT.failedPlayer);
  } finally {
    stopTyping();
  }
}
