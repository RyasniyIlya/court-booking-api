import { prisma } from './db';

/**
 * Видалення даних клубу після розірвання договору — оферта, п. 13.1 і 13.2
 * (docs/legal/07-ПУБЛІЧНА-ОФЕРТА-ДЛЯ-КЛУБІВ.md).
 *
 * ── Єдине правило права на видалення ──────────────────────────────────────
 *
 * Дані клубу підлягають видаленню, коли виконано УСЕ:
 *   1. `Club.terminatedAt` заданий — оператор платформи свідомо зафіксував
 *      розірвання договору (POST /api/platform/clubs/:id/terminate);
 *   2. `now >= terminatedAt + 90 діб` (RETENTION_DAYS * 24 год; на 89-й добі
 *      ще ні, на 90-й уже так);
 *   3. підписка справді скінчилась: немає оплаченого/пробного періоду, що
 *      триває далі за `now` (пізніша з paidUntil/trialEndsAt <= now). Клуб, який
 *      після розірвання заплатив знову, не чіпаємо, поки оператор не зніме
 *      terminatedAt;
 *   4. дані ще не видалені (`dataPurgedAt` порожній).
 *
 * Прострочена оплата (grace 7 днів, lib/billing.ts) і `isActive=false` самі
 * по собі НЕ є розірванням і НІКОЛИ не запускають видалення: клуб міг просто
 * забути заплатити, а видалення незворотне. «Розірвання» — рішення людини.
 *
 * ── Що видаляється, що лишається ──────────────────────────────────────────
 *
 * Видаляється (один раз, однією транзакцією на клуб): клієнти, броні й
 * місця, оплати гравців, журнал розрахунків (BookingLedgerEntry), бонуси,
 * абонементи, корти, години, блокування, тренери, співробітники (User),
 * акції, інвентар і оренда, витрати, закриття змін, журнал змін,
 * скидання паролів, лист очікування, діалоги бота, нотатки CRM клубу.
 * Журнал розрахунків видаляється, а не знеособлюється: це дані клубу про
 * його ж гравців (з email виконавця операції), вони експортувались у межах
 * 90 днів, а оферта обіцяє «видалення». Податковий облік клуб веде сам.
 *
 * Лишається: ClubInvoice (рахунки/оплати підписки — 1095 днів, ПКУ ст. 44.3;
 * тому сам рядок Club не видаляється — FK каскадний, — а знеособлюється:
 * назва, slug, контакти, реквізити, токени, логотип, правила), а також
 * `terminatedAt/dataPurgedAt`, billing-поля й запис аудиту (CrmActivity).
 * Резервні копії видаляються за циклом провайдера БД (Render).
 *
 * ── Вимкнено й dry-run за замовчуванням ───────────────────────────────────
 *
 * DATA_RETENTION_ENABLED=true — інакше планувальник не стартує взагалі.
 * DATA_RETENTION_DRY_RUN — типово true: лише лічить рядки й логує id клубів
 * та кількості, нічого не видаляє. Реальне видалення тільки при
 * DATA_RETENTION_DRY_RUN=false. Персональні дані в лог не потрапляють.
 */

export const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
const TICK_MS = 6 * 60 * 60_000;

export function retentionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DATA_RETENTION_ENABLED === 'true';
}

export function retentionDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DATA_RETENTION_DRY_RUN !== 'false';
}

export type RetentionClub = {
  terminatedAt: Date | null;
  dataPurgedAt?: Date | null;
  paidUntil?: Date | null;
  trialEndsAt?: Date | null;
};

/** Момент, з якого дані клубу можна видаляти; null — розірвання не зафіксоване. */
export function purgeAfter(club: Pick<RetentionClub, 'terminatedAt'>): Date | null {
  return club.terminatedAt ? new Date(club.terminatedAt.getTime() + RETENTION_DAYS * DAY_MS) : null;
}

/** Правило з шапки файлу. Чиста функція: `now` параметром. */
export function purgeEligible(club: RetentionClub, now: Date = new Date()): boolean {
  if (club.dataPurgedAt) return false;
  const after = purgeAfter(club);
  if (!after || now.getTime() < after.getTime()) return false;
  const dates = [club.paidUntil, club.trialEndsAt].filter((d): d is Date => Boolean(d));
  const until = dates.length ? Math.max(...dates.map((d) => d.getTime())) : null;
  if (until !== null && until > now.getTime()) return false;
  return true;
}

/**
 * Таблиці з clubId. Порядок = порядок видалення з урахуванням Restrict/NoAction:
 * журнал розрахунків і бонуси -> оренда -> броні -> клієнти -> решта
 * (дочірні рядки знімаються каскадом від цих). `where` додається до { clubId }.
 */
const PURGE_STEPS: { key: string; model: string; where?: Record<string, unknown> }[] = [
  // Повернення посилаються на оригінал (Restrict) — спочатку вони.
  { key: 'ledgerRefunds', model: 'bookingLedgerEntry', where: { originalId: { not: null } } },
  { key: 'ledger', model: 'bookingLedgerEntry' },
  { key: 'customerRewards', model: 'customerReward' },
  { key: 'rentals', model: 'bookingRental' },
  { key: 'bookings', model: 'booking' },
  { key: 'customers', model: 'customer' },
  { key: 'waitlist', model: 'waitlistEntry' },
  { key: 'passes', model: 'pass' },
  { key: 'passPlans', model: 'passPlan' },
  { key: 'payments', model: 'payment' },
  { key: 'blocks', model: 'block' },
  { key: 'promos', model: 'promo' },
  { key: 'inventory', model: 'inventoryItem' },
  { key: 'expenses', model: 'clubExpense' },
  { key: 'shiftCloses', model: 'shiftClose' },
  { key: 'changeLogs', model: 'changeLog' },
  { key: 'passwordResets', model: 'passwordReset' },
  { key: 'trainers', model: 'trainer' },
  { key: 'users', model: 'user' },
  { key: 'courts', model: 'court' },
  { key: 'hours', model: 'clubHours' },
  { key: 'crmActivities', model: 'crmActivity' },
];

export type PurgeCounts = Record<string, number>;

/** Знеособлений стан рядка Club: ClubInvoice на нього посилається й лишається. */
export function anonymizedClubData(clubId: string, now: Date) {
  return {
    name: 'Клуб видалено',
    slug: `purged-${clubId}`,
    phone: null,
    address: null,
    logoUrl: null,
    logoData: null,
    logoMime: null,
    logoUpdatedAt: null,
    telegramChatId: null,
    paymentProvider: null,
    paymentTokenEnc: null,
    legalName: null,
    legalCode: null,
    legalAddress: null,
    email: null,
    extraRules: null,
    billingNote: null,
    city: null,
    crmTags: [],
    botSettings: {},
    isActive: false,
    dataPurgedAt: now,
  };
}

/** Лише лічить, що було б видалено. Нічого не пише. */
export async function countClubData(clubId: string): Promise<PurgeCounts> {
  const db = prisma as any;
  const out: PurgeCounts = {};
  for (const s of PURGE_STEPS) {
    if (s.key === 'ledgerRefunds') continue;
    out[s.key] = await db[s.model].count({ where: { clubId, ...(s.where ?? {}) } });
  }
  return out;
}

/**
 * Реальне видалення одного клубу — ОДНА транзакція: або все, або нічого.
 * ClubInvoice не чіпається. Повертає кількості видалених рядків.
 */
export async function purgeClubData(clubId: string, now: Date = new Date()): Promise<PurgeCounts> {
  return (prisma as any).$transaction(async (tx: any) => {
    const counts: PurgeCounts = {};
    for (const s of PURGE_STEPS) {
      const r = await tx[s.model].deleteMany({ where: { clubId, ...(s.where ?? {}) } });
      counts[s.key] = (counts[s.key] ?? 0) + (r?.count ?? 0);
    }
    // Повернення вже враховані в загальній кількості журналу.
    delete counts.ledgerRefunds;
    // Діалоги бота зберігають clubId лише всередині JSON.
    const dialogs = await tx.tgDialog.deleteMany({ where: { data: { path: ['clubId'], equals: clubId } } });
    counts.tgDialogs = dialogs?.count ?? 0;

    await tx.club.update({ where: { id: clubId }, data: anonymizedClubData(clubId, now) });

    // Аудит — у тій самій транзакції, після видалення crmActivities. Лише лічильники.
    await tx.crmActivity.create({
      data: {
        clubId,
        kind: 'SYSTEM',
        author: 'system:data-retention',
        text: `Дані клубу видалено за п. 13.1 оферти (${RETENTION_DAYS} днів після розірвання). Рахунки підписки збережено. Рядків: ${JSON.stringify(counts)}`,
      },
    });
    return counts;
  });
}

export type RetentionResult = { dryRun: boolean; clubs: { id: string; counts: PurgeCounts; purged: boolean }[] };

/** Один прохід: знайти клуби, що підпали під правило, і (не)видалити. */
export async function runRetentionTick(
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<RetentionResult> {
  const dryRun = retentionDryRun(env);
  const result: RetentionResult = { dryRun, clubs: [] };
  if (!retentionEnabled(env)) return result;

  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
  const candidates = await prisma.club.findMany({
    where: { terminatedAt: { lte: cutoff }, dataPurgedAt: null },
    select: { id: true, terminatedAt: true, dataPurgedAt: true, paidUntil: true, trialEndsAt: true },
  });

  for (const c of candidates) {
    if (!purgeEligible(c, now)) continue;
    try {
      if (dryRun) {
        const counts = await countClubData(c.id);
        console.log(`[retention] DRY-RUN club=${c.id} rows=${JSON.stringify(counts)}`);
        result.clubs.push({ id: c.id, counts, purged: false });
      } else {
        const counts = await purgeClubData(c.id, now);
        console.log(`[retention] видалено club=${c.id} rows=${JSON.stringify(counts)}`);
        result.clubs.push({ id: c.id, counts, purged: true });
      }
    } catch {
      // Транзакція відкотилась — клуб лишається цілим і піде в наступний тік.
      console.error(`[retention] помилка club=${c.id}, відкат`);
    }
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startRetentionScheduler() {
  if (timer) return;
  if (!retentionEnabled()) {
    console.log('[retention] вимкнено (DATA_RETENTION_ENABLED=true — увімкнути)');
    return;
  }
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void runRetentionTick()
      .catch(() => console.error('[retention] тік упав'))
      .finally(() => { running = false; });
  }, TICK_MS);
  timer.unref?.();
  console.log(`[retention] увімкнено, ${retentionDryRun() ? 'DRY-RUN (нічого не видаляє)' : 'РЕАЛЬНЕ ВИДАЛЕННЯ'}`);
}

export function stopRetentionScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
