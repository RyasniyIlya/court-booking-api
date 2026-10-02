/**
 * Разове прибирання тестових карток клієнтів разом із їхніми бронями.
 *
 *   npm run customers:purge -- --scope nopassword                 (сухий прогін)
 *   npm run customers:purge -- --scope nopassword --club padel    (один клуб)
 *   npm run customers:purge -- --scope all --apply --confirm 42   (видалення)
 *
 * Без --apply скрипт лише читає (count/findMany) і нічого не пише.
 * dotenv і prisma підтягуються ліниво всередині main(): імпорт модуля з тесту
 * не читає .env і не створює клієнт.
 */

const HELP = `
Видалення тестових карток клієнтів і їхніх броней.

  npm run customers:purge -- --scope nopassword|all [--club slug] [--apply --confirm N]

Обовʼязкові:
  --scope    nopassword — клієнти без пароля (passwordHash = null)
             all        — усі клієнти вибраних клубів

Необовʼязкові:
  --club     slug клубу. Без нього — усі клуби
  --apply    Справді видалити. Без цього прапора — сухий прогін (лише читання)
  --confirm  Кількість клієнтів, яку показав сухий прогін. Обовʼязковий з --apply:
             якщо в базі зараз інше число — скрипт нічого не пише
  --help     Ця довідка

Що видаляється: картки клієнтів, їхні броні, їхні місця в групах, платежі,
перенесення, абонементи, листи очікування, а також рядки журналу оплат
(BookingLedgerEntry), бонуси (CustomerReward) і прокат цих броней, бо вони
блокують видалення. Групові заняття (контейнери) лишаються, зникають лише
місця цих клієнтів. Усе — в одній транзакції: при помилці не видаляється нічого.
`.trim();

export type Scope = 'nopassword' | 'all';

export interface Options {
  scope: Scope;
  club?: string;
  apply: boolean;
  confirm?: number;
}

export class UsageError extends Error {}

/** Мінімальний «prisma-подібний» клієнт: так його легко підмінити в тесті. */
export interface Delegate {
  findMany(args: any): Promise<any[]>;
  count(args: any): Promise<number>;
  deleteMany(args: any): Promise<{ count: number }>;
}
export interface Db {
  club: { findUnique(args: any): Promise<any> };
  customer: Delegate;
  booking: Delegate;
  bookingSeat: Delegate;
  payment: Delegate;
  bookingReschedule: Delegate;
  bookingLedgerEntry: Delegate;
  customerReward: Delegate;
  bookingRental: Delegate;
  pass: Delegate;
  passUsage: Delegate;
  waitlistEntry: Delegate;
}

export const CHUNK = 1000;

export function chunk<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function parseOptions(argv: string[]): Options {
  const raw: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) raw[key] = true;
    else {
      raw[key] = next;
      i++;
    }
  }

  const scope = raw.scope;
  if (scope !== 'nopassword' && scope !== 'all') {
    throw new UsageError('--scope обовʼязковий: nopassword або all');
  }

  const club = typeof raw.club === 'string' && raw.club.trim() ? raw.club.trim().toLowerCase() : undefined;
  if (raw.club !== undefined && !club) throw new UsageError('--club без значення');

  const apply = raw.apply === true;
  let confirm: number | undefined;
  if (raw.confirm !== undefined) {
    if (typeof raw.confirm !== 'string' || !/^\d+$/.test(raw.confirm)) {
      throw new UsageError('--confirm має бути невідʼємним цілим числом');
    }
    confirm = Number(raw.confirm);
  }
  if (apply && confirm === undefined) {
    throw new UsageError('--apply вимагає --confirm <N>, де N з сухого прогону');
  }

  return { scope, club, apply, confirm };
}

/** Тільки хост і імʼя бази. Користувач і пароль з URL ніколи не друкуються. */
export function describeDbTarget(url: string | undefined): string {
  if (!url) return 'DATABASE_URL не задано';
  try {
    const u = new URL(url);
    const dbName = decodeURIComponent(u.pathname.replace(/^\//, '')) || '(без імені)';
    return `хост ${u.hostname}${u.port ? `:${u.port}` : ''}, база ${dbName}`;
  } catch {
    return 'DATABASE_URL не вдалося розібрати';
  }
}

export function formatHeader(env: { DATABASE_URL?: string }, opts: Options): string {
  return [
    `  База:    ${describeDbTarget(env.DATABASE_URL)}`,
    `  Scope:   ${opts.scope === 'all' ? 'all (усі клієнти)' : 'nopassword (passwordHash = null)'}`,
    `  Клуб:    ${opts.club ?? 'усі клуби'}`,
    `  Режим:   ${opts.apply ? 'APPLY (видалення)' : 'DRY RUN (лише читання)'}`,
  ].join('\n');
}

export interface Targets {
  customerIds: string[];
  /** B: броні цих клієнтів */
  bookingIds: string[];
  /** S: місця цих клієнтів + усі місця їхніх броней */
  seatIds: string[];
  /** Групові контейнери, з яких зникнуть місця (самі контейнери лишаються) */
  containerIds: string[];
  /** Рядки журналу оплат, що блокують видалення (з замиканням по originalId) */
  ledger: { id: string; originalId: string | null }[];
}

export function customerWhere(opts: Options, clubId?: string) {
  return {
    ...(clubId ? { clubId } : {}),
    ...(opts.scope === 'nopassword' ? { passwordHash: null } : {}),
  };
}

export async function resolveClubId(db: Pick<Db, 'club'>, opts: Options): Promise<string | undefined> {
  if (!opts.club) return undefined;
  const club = await db.club.findUnique({ where: { slug: opts.club }, select: { id: true } });
  if (!club) throw new UsageError(`Клуб "${opts.club}" не знайдено`);
  return club.id;
}

/** Лише читання. */
export async function collectTargets(db: Db, opts: Options, clubId?: string): Promise<Targets> {
  const customers = await db.customer.findMany({
    where: customerWhere(opts, clubId),
    select: { id: true },
  });
  const customerIds = customers.map((c) => c.id as string);

  const bookingIds = new Set<string>();
  for (const part of chunk(customerIds)) {
    const rows = await db.booking.findMany({
      where: { customerId: { in: part } },
      select: { id: true },
    });
    rows.forEach((r) => bookingIds.add(r.id));
  }

  const seatIds = new Set<string>();
  const containerIds = new Set<string>();
  for (const part of chunk(customerIds)) {
    const rows = await db.bookingSeat.findMany({
      where: { customerId: { in: part } },
      select: { id: true, bookingId: true },
    });
    for (const r of rows) {
      seatIds.add(r.id);
      if (!bookingIds.has(r.bookingId)) containerIds.add(r.bookingId);
    }
  }
  for (const part of chunk([...bookingIds])) {
    const rows = await db.bookingSeat.findMany({
      where: { bookingId: { in: part } },
      select: { id: true },
    });
    rows.forEach((r) => seatIds.add(r.id));
  }

  const targets: Targets = {
    customerIds,
    bookingIds: [...bookingIds],
    seatIds: [...seatIds],
    containerIds: [...containerIds],
    ledger: [],
  };
  targets.ledger = await collectLedger(db, targets);
  return targets;
}

/**
 * Журнал оплат: рядки по B, S і C плюс усі повернення, що вказують на ці
 * рядки через originalId (FK Restrict) — навіть якщо самі вони по інших
 * броньках. Інакше видалення оригіналу впаде.
 */
async function collectLedger(db: Db, t: Pick<Targets, 'customerIds' | 'bookingIds' | 'seatIds'>) {
  const rows = new Map<string, string | null>();
  const select = { id: true, originalId: true };
  const add = (found: any[]) => {
    const fresh: string[] = [];
    for (const r of found) {
      if (!rows.has(r.id)) {
        rows.set(r.id, r.originalId ?? null);
        fresh.push(r.id);
      }
    }
    return fresh;
  };

  let frontier: string[] = [];
  for (const part of chunk(t.bookingIds)) {
    frontier.push(...add(await db.bookingLedgerEntry.findMany({ where: { bookingId: { in: part } }, select })));
  }
  for (const part of chunk(t.seatIds)) {
    frontier.push(...add(await db.bookingLedgerEntry.findMany({ where: { seatId: { in: part } }, select })));
  }
  for (const part of chunk(t.customerIds)) {
    frontier.push(...add(await db.bookingLedgerEntry.findMany({ where: { customerId: { in: part } }, select })));
  }

  while (frontier.length) {
    const next: string[] = [];
    for (const part of chunk(frontier)) {
      next.push(...add(await db.bookingLedgerEntry.findMany({ where: { originalId: { in: part } }, select })));
    }
    frontier = next;
  }

  return [...rows].map(([id, originalId]) => ({ id, originalId }));
}

/**
 * Шари журналу «листя першими»: спершу рядки, на які ніхто з решти не
 * посилається (повернення), потім їхні оригінали. originalId — Restrict
 * (schema.prisma, BookingLedgerEntry.original), тож інакше не можна.
 */
export function layerLedger(rows: Targets['ledger']): string[][] {
  const remaining = new Map(rows.map((r) => [r.id, r.originalId]));
  const layers: string[][] = [];
  while (remaining.size) {
    const referenced = new Set<string>();
    for (const orig of remaining.values()) if (orig && remaining.has(orig)) referenced.add(orig);
    const layer = [...remaining.keys()].filter((id) => !referenced.has(id));
    if (layer.length === 0) throw new Error('Цикл у BookingLedgerEntry.originalId — зупинено');
    layer.forEach((id) => remaining.delete(id));
    layers.push(layer);
  }
  return layers;
}

export interface Plan {
  customers: number;
  bookings: number;
  seats: number;
  containersTouched: number;
  ledger: number;
  rewards: number;
  rentals: number;
  /** Нижче — каскадом, окремого delete немає */
  payments: number;
  reschedules: number;
  passes: number;
  passUsages: number;
  waitlist: number;
}

async function sumChunks(ids: string[], fn: (part: string[]) => Promise<number>): Promise<number> {
  let total = 0;
  for (const part of chunk(ids)) total += await fn(part);
  return total;
}

/** Лише count-запити. Показує і те, що піде каскадом. */
export async function countPlan(db: Db, t: Targets): Promise<Plan> {
  const byBooking = (model: Delegate) => sumChunks(t.bookingIds, (p) => model.count({ where: { bookingId: { in: p } } }));
  const bySeat = (model: Delegate) => sumChunks(t.seatIds, (p) => model.count({ where: { seatId: { in: p } } }));
  const byCustomer = (model: Delegate) => sumChunks(t.customerIds, (p) => model.count({ where: { customerId: { in: p } } }));

  return {
    customers: t.customerIds.length,
    bookings: t.bookingIds.length,
    seats: t.seatIds.length,
    containersTouched: t.containerIds.length,
    ledger: t.ledger.length,
    rewards: await byCustomer(db.customerReward),
    rentals: await byBooking(db.bookingRental),
    payments: (await byBooking(db.payment)) + (await bySeat(db.payment)),
    reschedules: await byBooking(db.bookingReschedule),
    passes: await byCustomer(db.pass),
    passUsages: await sumChunks(t.customerIds, (p) => db.passUsage.count({ where: { pass: { customerId: { in: p } } } })),
    waitlist: await byCustomer(db.waitlistEntry),
  };
}

export function formatPlan(p: Plan): string {
  return [
    `  Клієнтів:                      ${p.customers}`,
    `  Броней (B):                    ${p.bookings}`,
    `  Місць у групах (S):            ${p.seats}  (групових занять зачеплено: ${p.containersTouched}, самі заняття лишаються)`,
    `  Рядків журналу оплат:          ${p.ledger}  (явно, блокують видалення)`,
    `  Бонусів (CustomerReward):      ${p.rewards}  (явно)`,
    `  Прокату (BookingRental):       ${p.rentals}  (явно)`,
    `  Платежів:                      ${p.payments}  (каскадом від броней/місць)`,
    `  Перенесень броней:             ${p.reschedules}  (каскадом)`,
    `  Абонементів:                   ${p.passes}  (каскадом від клієнта)`,
    `  Використань абонементів:       ${p.passUsages}  (каскадом від абонементів)`,
    `  Записів листа очікування:      ${p.waitlist}  (каскадом від клієнта)`,
  ].join('\n');
}

export type Counts = Record<string, number>;

/**
 * Видалення. Викликати лише всередині prisma.$transaction (tx).
 * Порядок за onDelete у schema.prisma:
 *  1. BookingLedgerEntry — booking/seat/customer/original усі Restrict;
 *     спершу повернення, потім їхні оригінали (шарами).
 *  2. CustomerReward — customer Restrict.
 *  3. BookingRental — booking NoAction (нічого не каскадує).
 *  4. BookingSeat — каскадом прибирає Payment за seatId.
 *  5. Booking — каскадом Payment, BookingReschedule.
 *  6. Customer — каскадом Pass(+PassUsage), WaitlistEntry; решта посилань SetNull.
 *
 * Денормалізованого лічильника місць у контейнері групи в схемі немає:
 * seatsTaken/seatsBooked рахуються на льоту з BookingSeat (routes/admin/
 * bookings.ts, lib/bookingExport.ts), тож перераховувати нічого.
 */
export async function executePurge(tx: Db, t: Targets): Promise<Counts> {
  const counts: Counts = {
    BookingLedgerEntry: 0,
    CustomerReward: 0,
    BookingRental: 0,
    BookingSeat: 0,
    Booking: 0,
    Customer: 0,
  };

  for (const layer of layerLedger(t.ledger)) {
    for (const part of chunk(layer)) {
      counts.BookingLedgerEntry += (await tx.bookingLedgerEntry.deleteMany({ where: { id: { in: part } } })).count;
    }
  }
  for (const part of chunk(t.customerIds)) {
    counts.CustomerReward += (await tx.customerReward.deleteMany({ where: { customerId: { in: part } } })).count;
  }
  for (const part of chunk(t.bookingIds)) {
    counts.BookingRental += (await tx.bookingRental.deleteMany({ where: { bookingId: { in: part } } })).count;
  }
  for (const part of chunk(t.seatIds)) {
    counts.BookingSeat += (await tx.bookingSeat.deleteMany({ where: { id: { in: part } } })).count;
  }
  for (const part of chunk(t.bookingIds)) {
    counts.Booking += (await tx.booking.deleteMany({ where: { id: { in: part } } })).count;
  }
  for (const part of chunk(t.customerIds)) {
    counts.Customer += (await tx.customer.deleteMany({ where: { id: { in: part } } })).count;
  }
  return counts;
}

/** Оболонка над транзакцією: повторно збирає цілі всередині неї й звіряє з --confirm. */
export async function applyPurge(
  prisma: { $transaction<T>(fn: (tx: any) => Promise<T>, opts?: { timeout?: number; maxWait?: number }): Promise<T> },
  opts: Options,
  clubId: string | undefined,
): Promise<Counts> {
  return prisma.$transaction(
    async (tx: Db) => {
      const fresh = await collectTargets(tx, opts, clubId);
      if (fresh.customerIds.length !== opts.confirm) {
        throw new UsageError(
          `У транзакції знайдено ${fresh.customerIds.length} клієнтів, а --confirm ${opts.confirm}. Нічого не видалено.`,
        );
      }
      return executePurge(tx, fresh);
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.length === 0) {
    console.log(`\n${HELP}\n`);
    return;
  }

  let opts: Options;
  try {
    opts = parseOptions(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`\n  ✗ ${e.message}\n\n${HELP}\n`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  // Ліниво: .env читається лише при справжньому запуску, не при імпорті в тесті.
  await import('dotenv/config');
  console.log(`\n${formatHeader(process.env, opts)}\n`);
  const { prisma } = await import('../src/lib/db');

  try {
    const db = prisma as unknown as Db;
    const clubId = await resolveClubId(db, opts);
    const targets = await collectTargets(db, opts, clubId);
    const plan = await countPlan(db, targets);
    console.log(formatPlan(plan));

    if (plan.customers === 0) {
      console.log('\n  Нічого видаляти.\n');
      return;
    }
    if (plan.ledger > 0) {
      console.log(`\n  ! Буде стерто ${plan.ledger} рядків журналу оплат (фінансова історія). Переконайтесь, що це тестові дані.`);
    }

    if (!opts.apply) {
      console.log(
        `\n  DRY RUN: нічого не змінено. Щоб видалити:\n` +
          `    npm run customers:purge -- --scope ${opts.scope}${opts.club ? ` --club ${opts.club}` : ''} --apply --confirm ${plan.customers}\n`,
      );
      return;
    }

    if (opts.confirm !== plan.customers) {
      console.error(`\n  ✗ --confirm ${opts.confirm}, а в базі ${plan.customers} клієнтів. Нічого не видалено.\n`);
      process.exitCode = 1;
      return;
    }

    const counts = await applyPurge(prisma as any, opts, clubId);
    console.log('\n  ✓ Видалено:');
    for (const [table, n] of Object.entries(counts)) console.log(`    ${table.padEnd(20)} ${n}`);
    console.log('    (платежі, перенесення, абонементи, лист очікування — каскадом)\n');
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`\n  ✗ ${e.message}\n`);
    } else {
      console.error(e);
      console.error('\n  ✗ Помилка. Транзакцію відкочено, нічого не видалено.\n');
    }
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Запускаємо лише коли файл виконано напряму (tsx scripts/purge-customers.ts).
if (/purge-customers\.[cm]?[tj]s$/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
