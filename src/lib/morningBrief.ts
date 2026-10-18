import { DateTime } from 'luxon';

import { prisma } from './db';
import { planFeatures } from './plans';
import { normalizeBotSettings } from './clubBot';
import { sendMessage } from './telegram';
import { withSendSummary } from './telegramSafety';
import { actionsBlock, briefToTelegramHtml, splitTelegram, toShownAction, type ShownAction } from './aiTelegram';
import { AiError, aiConfigured } from './ai/gemini';
import { BRIEF_REQUEST, ownerAssistant } from './ai/ownerAssistant';
import { effectivePermissions } from './ai/policy';
import { loadPolicy } from './ai/policyStore';
import { envLimit, takeQuota } from './ai/quota';
import './ai/executors';

/**
 * Ранкова сводка ІІ-менеджера власнику в Telegram.
 *
 * Та сама сводка, що й `/ai/brief` у кабінеті (права власника), плюс до трьох
 * конкретних дій, які менеджер пропонує через інструменти етапу 2: залежно від
 * політики вони стають кнопками «Підтвердити / Відхилити» (ASK), виконуються
 * самі (AUTO) або не з'являються (OFF).
 *
 * ── Рівно раз на добу ─────────────────────────────────────────────────────
 * Сводка коштує грошей, тому «приблизно раз» (як у щоденного зведення, де Set у
 * памʼяті) не годиться: рестарт чи другий інстанс не мають дати другу.
 * Позначка лежить у БД — `Club.botSettings.briefSentOn` ('yyyy-MM-dd' за часом
 * клубу), БЕЗ міграції: колонка вже є, а її читач (normalizeBotSettings) зайві
 * ключі просто ігнорує. Забираємо день одним умовним UPDATE: перемагає той
 * виклик, у якого `count = 1`; решта бачить 0 і мовчить. Позначку ставимо ДО
 * генерації — краще пропустити ранок при збої, ніж заплатити двічі.
 */

const TICK_MS = 15 * 60_000;

/** Скільки годин після налаштованої ще пробуємо (рестарт/деплой у момент сводки). Далі «доброго ранку» вже не буде. */
const CATCHUP_HOURS = 2;

/* Додаток до готового завдання: ліміт у три дії і заборона вигадувати. */
const TG_BRIEF_REQUEST = `${BRIEF_REQUEST}

Це повідомлення піде власнику в Telegram, тож стисло: до 2500 символів. Пункт 4 не розписуй текстом — натомість запропонуй цими діями через інструменти не більше трьох конкретних кроків (лише ті, що справді мають сенс за цифрами); якщо очевидних дій немає, не пропонуй жодної. Якщо за get_customer_health під ризиком є клієнти, одним із кроків можеш запропонувати листи повернення (propose_winback, не більше однієї партії): імена й тексти складає система, ти їх не наводиш. Про кожну запропоновану дію одним рядком скажи, чому вона.`;

/** Скільки дій сводка може запропонувати: стільки ж показуємо кнопками. */
export const MORNING_BRIEF_MAX_PROPOSALS = 3;

const FAILED_TEXT = 'ℹ️ Ранкову сводку ІІ сьогодні зібрати не вдалося. Спробуйте відкрити її в кабінеті → ІІ.';

/** Дата-мітка дня за часом клубу. */
const dayKey = (local: DateTime) => local.toFormat('yyyy-MM-dd');

/**
 * Атомарно «забрати» день для клубу. true — це перший виклик за цю добу.
 *
 * Порівняння рядків 'yyyy-MM-dd' лексикографічне = хронологічне, тому `<`
 * не дає і повторити день, і відкотитись назад.
 */
export async function claimBriefDay(clubId: string, day: string): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE "Club"
    SET "botSettings" = jsonb_set("botSettings", '{briefSentOn}', to_jsonb(${day}::text))
    WHERE "id" = ${clubId}::uuid
      AND jsonb_typeof("botSettings") = 'object'
      AND CASE WHEN jsonb_typeof("botSettings"->'briefSentOn') = 'string'
               THEN "botSettings"->>'briefSentOn' ELSE '' END < ${day}`;
  return n === 1;
}

async function candidates() {
  return prisma.user.findMany({
    where: { role: 'OWNER', tgChatId: { not: null } },
    select: {
      id: true,
      tgChatId: true,
      club: { select: { id: true, name: true, timezone: true, address: true, botSettings: true, plan: true } },
    },
  });
}

/** Одна сводка → повідомлення власнику (сводка + пропозиції). Повертає, чи щось надіслано. */
async function composeAndSend(
  club: { id: string; name: string; timezone: string; address: string | null },
  ownerId: string,
  chats: string[],
): Promise<boolean> {
  const send = async (text: string, keyboard?: unknown) => {
    let ok = false;
    for (const chat of chats) ok = Boolean(await sendMessage(chat, text, keyboard)) || ok;
    return ok;
  };

  const proposed: ShownAction[] = [];
  let reply: string;
  try {
    const perms = effectivePermissions(await loadPolicy(club.id), 'OWNER');
    const out = await ownerAssistant({
      club,
      messages: [{ role: 'user', content: TG_BRIEF_REQUEST }],
      perms,
      role: 'OWNER',
      manager: { requester: { id: ownerId, role: 'OWNER' }, maxProposals: MORNING_BRIEF_MAX_PROPOSALS },
    });
    reply = out.reply;
    for (const a of out.actions) proposed.push(toShownAction(a));
  } catch (e) {
    /* Сирий виняток (мережа, ключ, відмова моделі) власнику не показуємо: лише код у лог. */
    console.error('[brief] не вдалося зібрати сводку', club.id, e instanceof AiError ? e.code : 'unexpected');
    return send(FAILED_TEXT);
  }

  const parts = splitTelegram(briefToTelegramHtml(reply));
  const { text: block, keyboard } = actionsBlock(proposed);
  let ok = false;
  for (const part of parts) ok = (await send(part)) || ok;
  /* Кнопки — під окремим останнім повідомленням: сводка може йти кількома частинами. */
  if (block) ok = (await send(block, keyboard)) || ok;
  return ok;
}

/** Один прохід. Винесено з інтервалу, щоб тест міг покликати напряму. */
export const runMorningBriefTick = (now?: DateTime) => withSendSummary('morning-brief', () => runTick(now));

async function runTick(now: DateTime = DateTime.now()): Promise<number> {
  /* Без ключа Gemini в БД не ходимо взагалі. */
  if (!aiConfigured()) return 0;

  /* Один клуб може мати кількох власників із привʼязаним ботом: генеруємо раз, шлемо всім. */
  const byClub = new Map<string, { club: NonNullable<Awaited<ReturnType<typeof candidates>>[number]['club']>; owners: { id: string; chat: string }[] }>();
  for (const u of await candidates()) {
    if (!u.tgChatId) continue;
    const entry = byClub.get(u.club.id) ?? { club: u.club, owners: [] };
    entry.owners.push({ id: u.id, chat: u.tgChatId });
    byClub.set(u.club.id, entry);
  }

  let delivered = 0;
  for (const { club, owners } of byClub.values()) {
    if (!planFeatures(club.plan).ai) continue;
    const settings = normalizeBotSettings(club.botSettings).morningBrief;
    if (!settings.enabled) continue;

    const local = now.setZone(club.timezone);
    /* Зіпсована зона в БД дає Invalid DateTime: година NaN — без перевірки клуб мовчки випав би з розсилки. */
    if (!local.isValid) {
      console.warn('[brief] некоректний часовий пояс клубу — пропущено', club.id);
      continue;
    }
    if (local.hour < settings.hour || local.hour >= settings.hour + CATCHUP_HOURS) continue;

    try {
      /* Ліміт беремо ДО позначки дня: вичерпана квота не має «спалювати» день,
         інакше сводка не прийшла б і після того, як ліміт оновиться. */
      if (!takeQuota('owner', club.id, envLimit('AI_OWNER_DAILY_LIMIT', 100))) {
        console.log('[brief] добовий ліміт ІІ вичерпано — сводку пропущено', club.id);
        continue;
      }
      if (!(await claimBriefDay(club.id, dayKey(local)))) continue;
      if (await composeAndSend(club, owners[0].id, owners.map((o) => o.chat))) delivered += 1;
    } catch (e) {
      /* Один клуб не ламає решту. Позначка вже стоїть — повтор у наступний тік не дублює платний виклик. */
      console.error('[brief] не вдалось надіслати', club.id, e);
    }
  }
  return delivered;
}

let timer: NodeJS.Timeout | null = null;

export function startMorningBriefScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    void runMorningBriefTick().catch((e) => console.error('[brief] тік упав', e));
  }, TICK_MS);
  /* unref: інтервал не має тримати процес живим сам по собі. */
  timer.unref?.();
  console.log('[brief] ранкова сводка ІІ — за налаштуванням клубу, за його часом');
}

export function stopMorningBriefScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
