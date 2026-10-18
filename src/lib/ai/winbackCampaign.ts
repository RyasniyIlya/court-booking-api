import { z } from 'zod';

import { prisma } from '../db';
import { planFeatures } from '../plans';
import { renderWinback } from '../clubBot';
import { botReady } from '../telegram';
import { playerSchedulerEnabled } from '../playerRemind';
import { withSendSummary } from '../telegramSafety';
import { MAX_PER_TICK, inSendWindow, judgeCustomers, sendClaimed, type Eligibility } from '../winback';
import { ActionInvalidError } from './actions';
import { effectivePermissions } from './policy';
import { loadPolicy } from './policyStore';
import {
  LETTER_MAX, MAX_CAMPAIGN, loadClubForLetters, loadLetterFacts, selectAtRisk, sentTodayCount, validateLetter,
  winbackDailyCap, winbackPromo, writeLetters,
} from './winbackLetters';
import { sanitizeName } from './playerContext';
import type { GenerateFn } from './gemini';

/**
 * Кампанія повернення від ІІ: payload дії, відправка за правилами winback.ts і
 * черга на денне вікно.
 *
 * ── Чому нових полів у базі нема ─────────────────────────────────────────
 * Лічильники «скільки листів поспіль / коли останній» — ті самі
 * Customer.winbackCount / winbackLastAt, що й у шаблонного повернення, і ростуть
 * вони в одному місці (sendClaimed). Тому клієнт не отримає і шаблонний, і
 * ІІ-лист поверх ліміту. А «що ще чекає вікна» лежить у result самої дії
 * (AiAction.result.recipients[].status === 'queued') — міграція не потрібна.
 */

/** Скільки діє відкладений лист: стара пропозиція про «давно не були» за два дні — вже не про ту людину. */
export const QUEUE_TTL_MS = 48 * 3600_000;

export const recipientSchema = z.object({
  customerId: z.string().uuid(),
  /** Імʼя для картки: його виставляє код із картки клієнта, а не модель */
  name: z.string().max(40).optional(),
  text: z.string().min(1).max(LETTER_MAX),
  /** true — це шаблон клубу, а не текст моделі */
  fallback: z.boolean().optional(),
});

export const campaignPayloadSchema = z.object({
  recipients: z.array(recipientSchema).min(1).max(MAX_CAMPAIGN),
}).refine((p) => new Set(p.recipients.map((r) => r.customerId)).size === p.recipients.length, { message: 'duplicate customer' });

export type CampaignPayload = z.infer<typeof campaignPayloadSchema>;

export type RecipientStatus = 'sent' | 'queued' | 'skipped';
export type RecipientResult = {
  customerId: string;
  name: string;
  status: RecipientStatus;
  /** Код причини: для skipped — чому не надіслано, для queued — чому ще чекає */
  reason?: string;
  at?: string;
};
export type CampaignResult = { recipients: RecipientResult[]; sent: number; queued: number; skipped: number };

export const tally = (recipients: RecipientResult[]): CampaignResult => ({
  recipients,
  sent: recipients.filter((r) => r.status === 'sent').length,
  queued: recipients.filter((r) => r.status === 'queued').length,
  skipped: recipients.filter((r) => r.status === 'skipped').length,
});

/* ── Пропозиція ──────────────────────────────────────────────────────────── */

/**
 * Зібрати payload для propose: вибрати людей, написати листи. Кидає
 * ActionInvalidError з поясненням, якщо писати нікому (модель перекаже це
 * власнику замість вигаданої пропозиції).
 */
export async function buildCampaignPayload(
  clubId: string,
  opts: { limit?: number; minDays?: number; generate?: GenerateFn; now?: Date },
): Promise<CampaignPayload> {
  const now = opts.now ?? new Date();
  const club = await loadClubForLetters(clubId);
  if (!club) throw new ActionInvalidError('Клуб не знайдено.');

  const remainingCap = winbackDailyCap() - (await sentTodayCount(clubId, club.timezone, now));
  if (remainingCap <= 0) throw new ActionInvalidError('Добовий ліміт листів повернення вже вичерпано. Спробуйте завтра.');

  const limit = Math.max(1, Math.min(opts.limit ?? 10, MAX_CAMPAIGN, remainingCap));
  const people = await selectAtRisk(clubId, club.settings, now, { limit, minDays: opts.minDays });
  if (people.length === 0) {
    throw new ActionInvalidError('Немає кого запрошувати: серед «під ризиком» нікого, хто дав згоду на розсилку, має Telegram і до кого вже можна писати за лімітами.');
  }

  const [facts, promo] = await Promise.all([
    loadLetterFacts(clubId, club.timezone, people, now),
    winbackPromo(clubId, club.settings),
  ]);
  const letters = await writeLetters({ clubName: club.name, settings: club.settings, promo, facts, generate: opts.generate });
  const byId = new Map(letters.map((l) => [l.id, l]));

  return {
    recipients: people.map((p) => {
      const l = byId.get(p.id)!;
      return { customerId: p.id, name: p.name ?? 'Клієнт', text: l.text, ...(l.fallback ? { fallback: true } : {}) };
    }),
  };
}

const pluralLetters = (n: number) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} лист`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} листи`;
  return `${n} листів`;
};

/**
 * Перевірка payload при пропозиції (ActionExecutor.prepare): клієнти — з цього
 * клубу і мають право на лист просто зараз; тексти — без заборонених елементів.
 * Імена в payload ставить код із картки, а не те, що прислали.
 */
export async function prepareCampaign(clubId: string, raw: unknown, now: Date = new Date()): Promise<{ payload: CampaignPayload; summary: string }> {
  const parsed = campaignPayloadSchema.safeParse(raw);
  if (!parsed.success) throw new ActionInvalidError('Повернення клієнтів: некоректні дані (recipients).');

  const club = await loadClubForLetters(clubId);
  if (!club) throw new ActionInvalidError('Клуб не знайдено.');

  const judged = await judgeCustomers(clubId, parsed.data.recipients.map((r) => r.customerId), club.settings.winback, now);
  const hasPromo = Boolean(await winbackPromo(clubId, club.settings));
  const recipients: CampaignPayload['recipients'] = [];
  for (const r of parsed.data.recipients) {
    const j = judged.get(r.customerId);
    /* Клієнт з іншого клубу не знайдеться тут так само, як неіснуючий. */
    if (!j) throw new ActionInvalidError('Клієнта не знайдено в цьому клубі.');
    if (!j.verdict.ok) throw new ActionInvalidError(`Клієнту ${sanitizeName(j.name) ?? 'без імені'} зараз не можна писати (${reasonLabel(j.verdict.reason)}). Обери інших.`);
    /* Шаблон клубу — його власний текст; текст моделі перевіряємо жорстко. */
    const text = r.fallback ? r.text : validateLetter(r.text, { hasPromo });
    if (!text) throw new ActionInvalidError('Текст листа не пройшов перевірку (посилання, телефон, @ або обіцянка знижки). Згенеруй його знову.');
    recipients.push({ customerId: r.customerId, name: sanitizeName(j.name) ?? 'Клієнт', text, ...(r.fallback ? { fallback: true } : {}) });
  }

  const remainingCap = winbackDailyCap() - (await sentTodayCount(clubId, club.timezone, now));
  if (recipients.length > remainingCap) {
    throw new ActionInvalidError(`Добовий ліміт листів повернення: ще можна ${Math.max(0, remainingCap)}, а в запиті ${recipients.length}.`);
  }

  const names = recipients.slice(0, 3).map((r) => r.name).join(', ');
  const tail = recipients.length > 3 ? ', …' : '';
  return { payload: { recipients }, summary: `Повернення клієнтів: ${pluralLetters(recipients.length)} (${names}${tail})` };
}

const REASONS: Record<string, string> = {
  no_chat: 'немає Telegram',
  no_consent: 'немає згоди на розсилку',
  blocked: 'клієнт заблокований',
  never_played: 'ще не грав',
  upcoming: 'вже має запис',
  recent: 'грав нещодавно',
  too_soon: 'лист був надто нещодавно',
  max_reached: 'вичерпано ліміт листів',
};
const reasonLabel = (code: string) => REASONS[code] ?? code;

/* ── Відправка ───────────────────────────────────────────────────────────── */

type Item = { customerId: string; name: string; text: string };

/**
 * Прогнати набір адресатів: у вікні — відправити за повними правилами, поза
 * вікном — позначити «queued». Кожну людину перевіряємо наново саме зараз
 * (згода могла бути знята після підтвердження), а лічильник займає sendClaimed.
 *
 * `budget` — скільки листів ще можна за цей прохід (тіковий стелю); те, що не
 * влізло, лишається queued. Те саме з добовим стелем клубу.
 */
export async function deliverItems(
  clubId: string,
  items: Item[],
  now: Date,
  opts: { budget?: number } = {},
): Promise<RecipientResult[]> {
  const club = await loadClubForLetters(clubId);
  const queuedAll = (reason?: string): RecipientResult[] => items.map((i) => ({ customerId: i.customerId, name: i.name, status: 'queued', ...(reason ? { reason } : {}) }));
  if (!club) return items.map((i) => ({ customerId: i.customerId, name: i.name, status: 'skipped', reason: 'club_missing' }));
  if (!inSendWindow(now, club.timezone)) return queuedAll('window');

  const judged = await judgeCustomers(clubId, items.map((i) => i.customerId), club.settings.winback, now);
  const promo = await winbackPromo(clubId, club.settings);
  const clubLine = { name: club.name, slug: club.slug };

  let sentToday = await sentTodayCount(clubId, club.timezone, now);
  let budget = opts.budget ?? MAX_PER_TICK;
  const out: RecipientResult[] = [];

  for (const item of items) {
    const base = { customerId: item.customerId, name: item.name };
    const j = judged.get(item.customerId);
    if (!j) { out.push({ ...base, status: 'skipped', reason: 'not_found' }); continue; }

    const verdict: Eligibility = j.verdict;
    if (!verdict.ok) { out.push({ ...base, status: 'skipped', reason: verdict.reason }); continue; }

    /* Тіковий і добовий стелі не скасовують лист, а відкладають: людина лишається в черзі. */
    if (budget <= 0) { out.push({ ...base, status: 'queued', reason: 'tick_cap' }); continue; }
    if (sentToday >= winbackDailyCap()) { out.push({ ...base, status: 'queued', reason: 'daily_cap' }); continue; }

    const res = await sendClaimed(
      { id: j.id, chatId: j.chatId!, storedCount: j.storedCount, storedLastAt: j.storedLastAt, count: verdict.count },
      now,
      () => renderWinback({
        club: clubLine, settings: club.settings, playerName: item.name, days: verdict.days, promo, customerId: j.id, bodyText: item.text,
      }),
    );

    if (res === 'sent') {
      budget -= 1;
      sentToday += 1;
      out.push({ ...base, status: 'sent', at: now.toISOString() });
    } else if (res === 'retry') {
      /* Тимчасова помилка Telegram: лишаємо в черзі, наступний прохід спробує знову (до кінця строку). */
      out.push({ ...base, status: 'queued', reason: 'retry' });
    } else {
      out.push({ ...base, status: 'skipped', reason: res === 'permanent' ? 'bot_blocked' : 'changed' });
    }
  }
  return out;
}

/** Виконавець: payload → відправка або черга. Повторно перевіряє payload і політику не тут (це робить actions.ts). */
export async function executeCampaign(clubId: string, raw: unknown, now: Date = new Date()): Promise<CampaignResult> {
  const parsed = campaignPayloadSchema.safeParse(raw);
  if (!parsed.success) throw new ActionInvalidError('Повернення клієнтів: некоректні дані.');

  /* Жорсткі правила тексту перевіряємо й тут: payload міг бути змінений між пропозицією та рішенням. */
  const club = await loadClubForLetters(clubId);
  const hasPromo = club ? Boolean(await winbackPromo(clubId, club.settings)) : false;
  const items: Item[] = parsed.data.recipients.map((r) => {
    const text = r.fallback ? r.text : validateLetter(r.text, { hasPromo });
    return { customerId: r.customerId, name: r.name ?? 'Клієнт', text: text ?? '' };
  });
  const bad = new Set(items.filter((i) => !i.text).map((i) => i.customerId));
  const live = items.filter((i) => !bad.has(i.customerId));
  const delivered = live.length ? await deliverItems(clubId, live, now) : [];
  const byId = new Map(delivered.map((d) => [d.customerId, d]));

  return tally(items.map((i) => byId.get(i.customerId) ?? { customerId: i.customerId, name: i.name, status: 'skipped', reason: 'bad_text' }));
}

/* ── Черга на вікно ──────────────────────────────────────────────────────── */

/**
 * Один прохід: дописати те, що чекало вікна (або повтору після помилки
 * Telegram). Діє тільки для вже ВИКОНАНИХ (затверджених) дій: пропозиції, що
 * чекають рішення, сюди не потрапляють.
 *
 * Перед відправкою ще раз перевіряємо політику власника: якщо після
 * підтвердження «розсилку» вимкнули — відкладене знімається, а не йде за
 * вчорашнім дозволом.
 */
export const runWinbackQueue = (now?: Date) => withSendSummary('winback-ai', () => runQueueInner(now));

async function runQueueInner(now: Date = new Date()): Promise<number> {
  const rows = await prisma.aiAction.findMany({
    where: { kind: 'winback.campaign', status: 'EXECUTED', result: { path: ['queued'], gt: 0 } },
    orderBy: { executedAt: 'asc' },
    take: 100,
    select: { id: true, clubId: true, requestedRole: true, executedAt: true, result: true },
  });

  let delivered = 0;
  /* Тіковий стелю — на клуб, а не на дію: дві затверджені кампанії не дають 50 листів за раз. */
  const budgets = new Map<string, number>();
  const clubs = new Map<string, { ok: boolean; messagingOn: boolean } | undefined>();

  for (const row of rows) {
    const prev = (row.result as CampaignResult | null)?.recipients;
    if (!Array.isArray(prev)) continue;
    const queued = prev.filter((r) => r.status === 'queued');
    if (queued.length === 0) continue;

    let state = clubs.get(row.clubId);
    if (!state) {
      const club = await prisma.club.findUnique({ where: { id: row.clubId }, select: { isActive: true, approvedAt: true, plan: true } });
      const perms = effectivePermissions(await loadPolicy(row.clubId), row.requestedRole);
      state = { ok: Boolean(club?.isActive && club.approvedAt && planFeatures(club.plan).ai), messagingOn: perms.access && perms.messaging !== 'OFF' };
      clubs.set(row.clubId, state);
    }
    if (!state.ok) continue;

    let next: RecipientResult[];
    const expired = !row.executedAt || now.getTime() - row.executedAt.getTime() > QUEUE_TTL_MS;
    if (expired || !state.messagingOn) {
      next = prev.map((r) => (r.status === 'queued' ? { ...r, status: 'skipped' as const, reason: expired ? 'expired' : 'policy_off' } : r));
    } else {
      const club = await loadClubForLetters(row.clubId);
      if (!club || !inSendWindow(now, club.timezone)) continue;
      const hasPromo = Boolean(await winbackPromo(row.clubId, club.settings));

      const payload = await prisma.aiAction.findFirst({ where: { id: row.id, clubId: row.clubId }, select: { payload: true } });
      const texts = new Map<string, string>();
      const p = campaignPayloadSchema.safeParse(payload?.payload);
      if (p.success) for (const r of p.data.recipients) texts.set(r.customerId, r.fallback ? r.text : (validateLetter(r.text, { hasPromo }) ?? ''));

      const budget = budgets.get(row.clubId) ?? MAX_PER_TICK;
      if (budget <= 0) continue;
      const items = queued.map((r) => ({ customerId: r.customerId, name: r.name, text: texts.get(r.customerId) ?? '' }));
      const ready = items.filter((i) => i.text);
      const res = ready.length ? await deliverItems(row.clubId, ready, now, { budget }) : [];
      const byId = new Map(res.map((r) => [r.customerId, r]));
      const sent = res.filter((r) => r.status === 'sent').length;
      delivered += sent;
      budgets.set(row.clubId, budget - sent);
      next = prev.map((r) => (r.status === 'queued' ? (byId.get(r.customerId) ?? { ...r, status: 'skipped' as const, reason: 'bad_text' }) : r));
    }

    await prisma.aiAction.updateMany({
      where: { id: row.id, clubId: row.clubId, status: 'EXECUTED' },
      data: { result: tally(next) as unknown as object },
    });
  }
  return delivered;
}

/* ── Планувальник ────────────────────────────────────────────────────────── */

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Кожні 10 хвилин: черга затверджених листів чекає вікна 11:00, і година
 * затримки там була б помітною. Умови вмикання — ті самі, що в шаблонного
 * повернення (див. startWinbackScheduler): локальний запуск маркетингу не шле.
 */
export function startWinbackQueueScheduler() {
  if (timer) return;
  if (!playerSchedulerEnabled() || !botReady()) return;

  timer = setInterval(() => {
    if (running) return;
    running = true;
    void runWinbackQueue()
      .catch(() => console.error('[winback-ai] тік черги упав'))
      .finally(() => { running = false; });
  }, 10 * 60_000);
  timer.unref?.();
  console.log('[winback-ai] черга листів ІІ-повернення увімкнена (кожні 10 хв, 11:00–20:00 за часом клубу)');
}

export function stopWinbackQueueScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

