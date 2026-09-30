import 'dotenv/config';
import { DateTime } from 'luxon';
import { prisma } from '../src/lib/db';
import { createClub } from '../src/lib/createClub';
import { hashPassword } from '../src/lib/passwordHash';

/**
 * Еталонний клуб для задачі Ф-0 (перевірка аудиту №01–10).
 *
 * Усі цифри в цьому файлі рахуються ВРУЧНУ і записані поряд у
 * `docs/finance/reference-club.md` — саме тому кожна сума тут з коментарем
 * "чому саме стільки", а не просто число. Скрипт нічого не бронює через
 * HTTP і не викликає бізнес-логіку застосунку (crourtPriceWithPromos,
 * розрахунок знижок тощо) — усі підсумкові поля (`priceTotal`,
 * `promoDiscount`, `rentalTotal`, `trainerPrice`) виставлені руками, щоб
 * довідник був незалежним свідком, а не дзеркалом коду, який перевіряється.
 *
 * Ідемпотентність: скрипт видаляє й перестворює РІВНО клуб зі slug
 * `kort-demo` — жодного іншого клубу в базі він не чіпає.
 *
 * Детермінізм: жодного Math.random чи Date.now() у даних. Єдине джерело
 * "поточного часу" для тих метрик, які рахує сам застосунок від
 * wall-clock `now()` (сегменти клієнтів, retention, 8-тижневе вікно
 * завантаження, точка беззбитковості поточного місяця) — реальний час
 * запуску `reference-check.ts`; це відкрито описано в
 * `docs/finance/reference-club.md`, розділ "Часова прив'язка".
 */

/* ── ОХОРОНА: ніколи не торкатись Neon/прода ──────────────────────────── */

function assertLocalDatabase() {
  const url = process.env.DATABASE_URL ?? '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    console.error('DATABASE_URL відсутній або не парситься. Зупиняюсь.');
    process.exit(1);
  }
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLocal) {
    // Навмисно НЕ друкуємо саму adресу цілком (там пароль) — лише хост,
    // і той лише щоб підтвердити відмову.
    console.error(
      `\n  ✗ DATABASE_URL вказує на хост "${host}", а не на localhost.\n` +
      '    За замовчуванням .env цього проєкту вказує на PRODUCTION Neon.\n' +
      '    seed-reference НІКОЛИ не пише в нього. Підніміть локальний\n' +
      '    Postgres (docker compose up -d) і передайте DATABASE_URL, що\n' +
      '    вказує на localhost, лише в командний рядок цього запуску.\n',
    );
    process.exit(1);
  }
}

assertLocalDatabase();

/* ── Детерміновані допоміжні функції ──────────────────────────────────── */

const TZ = 'Europe/Kyiv';

/** Локальний час клубу (Київ) -> UTC Date. Без Date.now() і без Math.random. */
function kyiv(iso: string): Date {
  const dt = DateTime.fromISO(iso, { zone: TZ });
  if (!dt.isValid) throw new Error(`Невалідна дата "${iso}": ${dt.invalidReason}`);
  return dt.toJSDate();
}

/** Перше число місяця в зоні клубу -> те саме, що monthBounds() у routes/analytics.ts.
 *  Використовуємо ідентичний спосіб побудови дати, щоб ClubExpense.month
 *  завжди збігався з тим, що шукає GET /analytics/expenses?month=YYYY-MM. */
function monthDate(ym: string): Date {
  return DateTime.fromFormat(ym, 'yyyy-MM', { zone: TZ }).startOf('month').toJSDate();
}

/** Фіксовані "випадкові" ідентифікатори — той самий запуск завжди дає ті самі requestId. */
function fixedUuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}
let uuidCounter = 0;
const nextRequestId = () => fixedUuid(++uuidCounter);

const SLUG = 'kort-demo';

/* ── Видалення попередньої версії еталонного клубу ────────────────────── */

async function wipeReferenceClub() {
  const existing = await prisma.club.findUnique({ where: { slug: SLUG }, select: { id: true } });
  if (!existing) return;
  const clubId = existing.id;

  // Порядок важливий: BookingLedgerEntry і CustomerReward мають onDelete:
  // Restrict на клієнта/клуб, BookingRental — onDelete: NoAction на бронь і
  // Restrict на інвентар. Каскад від Club їх не прибере — видаляємо руками.
  // Усе інше (Booking -> BookingSeat/Payment/Reschedule, Customer, Pass ->
  // PassUsage, Trainer, Court, ClubHours, Block, Note, ChangeLog,
  // ClubExpense, Promo, InventoryItem, ShiftClose, PasswordReset, User)
  // каскадується від Club автоматично.
  await prisma.bookingLedgerEntry.deleteMany({ where: { clubId } });
  await prisma.customerReward.deleteMany({ where: { clubId } });
  await prisma.bookingRental.deleteMany({ where: { clubId } });
  await prisma.club.delete({ where: { id: clubId } });
  console.log(`  · стару версію клубу "${SLUG}" видалено`);
}

/* ── Ціни, копійки ────────────────────────────────────────────────────── */

const COURT1_PRICE = 50_000; // 500 грн/год
const COURT2_PRICE = 40_000; // 400 грн/год
const TRAINER_RATE = 30_000; // 300 грн/год (Олена, ставка тренера)
const PASS_PRICE = 320_000; // 3 200 грн за 8 занять -> 40 000 коп/заняття
const PASS_SESSIONS = 8;

async function main() {
  console.log(`Еталонний клуб "${SLUG}" — задача Ф-0`);
  await wipeReferenceClub();

  /* ── Клуб, корти, розклад, власник (через lib/createClub.ts) ──────────── */
  const { club, courts } = await createClub({
    name: 'Kort Demo Club',
    slug: SLUG,
    timezone: TZ,
    phone: '+380440000000',
    address: 'Київ, вул. Еталонна, 1',
    slotMinutes: 60,
    leadTimeMinutes: 60,
    horizonDays: 45,
    autoConfirm: true,
    weekday: { openMinute: 8 * 60, closeMinute: 22 * 60 },
    weekend: { openMinute: 8 * 60, closeMinute: 22 * 60 },
    courts: [
      { name: 'Корт 1', pricePerHour: COURT1_PRICE, sortOrder: 1 },
      { name: 'Корт 2', pricePerHour: COURT2_PRICE, sortOrder: 2 },
    ],
    ownerEmail: 'owner@kort-demo.test',
    ownerPassword: 'RefClub-Owner-2026',
  });
  const court1 = courts.find((c) => c.name === 'Корт 1')!;
  const court2 = courts.find((c) => c.name === 'Корт 2')!;

  // createdAt клубу — перед усіма даними (включно з липневим граничним
  // випадком нижче), щоб buildLoadProfile/loadClubLoadProfile нічого не
  // обрізали по цій даті.
  await prisma.club.update({
    where: { id: club.id },
    data: {
      createdAt: kyiv('2026-06-01T00:00:00'),
      passesEnabled: true,
      prepayEnabled: true,
      prepayRequired: false,
      paymentProvider: 'mock',
      approvedAt: kyiv('2026-06-01T00:00:00'),
    },
  });

  /* Тариф "Аналітика" (tier 3) — відкриває finance/analytics/AI без
     залежності від того, чи прогнаний scripts/plans-init.ts у цій базі. */
  const plan = await prisma.plan.upsert({
    where: { code: 'kort-demo-reference-pro' },
    create: {
      code: 'kort-demo-reference-pro',
      name: 'Аналітика (еталон Ф-0)',
      description: 'Службовий тариф лише для еталонного клубу задачі Ф-0.',
      price: 250_000,
      tier: 3,
      featTrainers: true,
      featGroups: true,
      featAnalytics: true,
      isActive: true,
      sortOrder: 999,
    },
    update: {},
  });
  await prisma.club.update({ where: { id: club.id }, data: { planId: plan.id } });

  /* ADMIN-акаунт — потрібен для перевірки №08 (адмін бачить фінанси,
     але не AI). */
  await prisma.user.create({
    data: {
      clubId: club.id,
      email: 'admin@kort-demo.test',
      passwordHash: await hashPassword('RefClub-Admin-2026', 10),
      role: 'ADMIN',
    },
  });

  /* ── Тренер ─────────────────────────────────────────────────────────── */
  const trainer = await prisma.trainer.create({
    data: { clubId: club.id, name: 'Олена Тренер', pricePerHour: TRAINER_RATE, isActive: true },
  });

  /* ── Інвентар для прокату ──────────────────────────────────────────── */
  const racket = await prisma.inventoryItem.create({
    data: {
      clubId: club.id, name: 'Ракетка', category: 'Ракетки', quantity: 10, unit: 'шт',
      rentPrice: 5_000, rentMode: 'FIXED', returnable: true,
    },
  });

  /* ── Акція: -10% на весь серпень 2026, тільки серпень ──────────────── */
  await prisma.promo.create({
    data: {
      clubId: club.id, title: 'Літня знижка', kind: 'DATES',
      weekdays: [], dateFrom: kyiv('2026-08-01T00:00:00'), dateTo: kyiv('2026-08-31T00:00:00'),
      startMinute: 0, endMinute: 1440, discountType: 'PERCENT', discountValue: 10,
      courtIds: [], isActive: true,
    },
  });

  /* ── Клієнти ────────────────────────────────────────────────────────── */
  type NewCustomer = { key: string; name: string; phone: string; createdAt: string };
  const customerDefs: NewCustomer[] = [
    { key: 'ivan', name: 'Іван Готівков', phone: '+380501110001', createdAt: '2026-08-03T09:00:00' },
    { key: 'maria', name: 'Марія Термінал', phone: '+380501110002', createdAt: '2026-08-04T11:00:00' },
    { key: 'oleg', name: 'Олег Онлайн', phone: '+380501110003', createdAt: '2026-08-05T08:00:00' },
    { key: 'nastya', name: 'Настя Абонемент', phone: '+380501110004', createdAt: '2026-08-08T09:00:00' },
    { key: 'daryna', name: 'Дарина Йога', phone: '+380501110005', createdAt: '2026-08-06T17:00:00' },
    { key: 'kostya', name: 'Костя Йога', phone: '+380501110006', createdAt: '2026-08-06T17:00:00' },
    { key: 'liza', name: 'Ліза Йога', phone: '+380501110007', createdAt: '2026-08-06T17:00:00' },
    { key: 'taras', name: 'Тарас Йога', phone: '+380501110008', createdAt: '2026-08-06T17:00:00' },
    { key: 'natalka', name: 'Наталка Тренування', phone: '+380501110009', createdAt: '2026-08-10T14:00:00' },
    { key: 'bogdan', name: 'Богдан Прокат', phone: '+380501110010', createdAt: '2026-08-12T16:00:00' },
    { key: 'yulia', name: 'Юля Знижка', phone: '+380501110011', createdAt: '2026-08-15T10:00:00' },
    { key: 'igor', name: 'Ігор Повернення', phone: '+380501110012', createdAt: '2026-08-18T18:00:00' },
    { key: 'dasha', name: 'Даша Боржниця', phone: '+380501110013', createdAt: '2026-09-05T15:00:00' },
    { key: 'sergiy', name: 'Сергій Скасував', phone: '+380501110014', createdAt: '2026-09-07T18:00:00' },
    { key: 'nastusya', name: 'Настуся Неявка', phone: '+380501110015', createdAt: '2026-08-21T17:00:00' },
    { key: 'olena', name: 'Олена Згасає', phone: '+380501110016', createdAt: '2026-08-02T09:00:00' },
    { key: 'roman', name: 'Роман Зал', phone: '+380501110017', createdAt: '2026-09-10T17:00:00' },
    { key: 'maksym', name: 'Максим Боржник', phone: '+380501110020', createdAt: '2026-08-28T15:00:00' },
    { key: 'future1', name: 'Клієнт Прийдешній', phone: '+380501110018', createdAt: '2026-09-29T09:00:00' },
    { key: 'future2', name: 'Христина Завтра', phone: '+380501110019', createdAt: '2026-09-30T14:00:00' },
    /* Граничний випадок поза серпнем/вереснем: єдиний візит 75 днів до
       "сьогодні" (див. reference-club.md, "Часова прив'язка"). Потрібен,
       щоб показати розбіжність №04: FADING у картотеці (30–90 днів) ловить
       його, а /analytics/deep atRisk (вікно лише 30+30 днів від "зараз")
       — ні, бо 75 днів вже за межами його 60-денного горизонту. */
    { key: 'dmytro', name: 'Дмитро Липневий', phone: '+380501110021', createdAt: '2026-07-15T09:00:00' },
  ];
  const customers = new Map<string, { id: string }>();
  for (const c of customerDefs) {
    const row = await prisma.customer.create({
      data: {
        clubId: club.id, name: c.name, phone: c.phone, phoneTail: c.phone.slice(-7),
        createdAt: kyiv(c.createdAt),
      },
    });
    customers.set(c.key, row);
  }
  const cid = (key: string) => customers.get(key)!.id;
  const cname = (key: string) => customerDefs.find((c) => c.key === key)!.name;
  const cphone = (key: string) => customerDefs.find((c) => c.key === key)!.phone;

  /* ── Допоміжне: приватна бронь + опційний ledger-платіж ───────────────
     Пишемо priceTotal РУКАМИ (без courtPriceWithPromos) — саме тому це
     незалежний свідок для аудиту, а не переказ тієї самої функції. */
  async function privateBooking(args: {
    key: string; customerKey: string; courtId: string; start: string; end: string;
    priceTotal: number; status?: 'CONFIRMED' | 'CANCELLED';
    trainerId?: string; trainerPrice?: number;
    promoNames?: string[]; promoDiscount?: number;
    attendance?: 'UNKNOWN' | 'ARRIVED' | 'NO_SHOW';
    cancelledAt?: string;
  }) {
    return prisma.booking.create({
      data: {
        clubId: club.id, courtId: args.courtId,
        customerId: cid(args.customerKey), customerName: cname(args.customerKey), customerPhone: cphone(args.customerKey),
        startTime: kyiv(args.start), endTime: kyiv(args.end),
        priceTotal: args.priceTotal,
        status: args.status ?? 'CONFIRMED',
        trainerId: args.trainerId, trainerPrice: args.trainerPrice ?? 0,
        promoNames: args.promoNames ?? [], promoDiscount: args.promoDiscount ?? 0,
        attendance: args.attendance ?? 'UNKNOWN',
        source: 'ADMIN',
        cancelledAt: args.cancelledAt ? kyiv(args.cancelledAt) : undefined,
        cancelledBy: args.status === 'CANCELLED'
          ? { email: 'admin@kort-demo.test', role: 'ADMIN' } : undefined,
      },
    });
  }

  async function cashLedger(args: {
    bookingId: string; kind: 'PAYMENT' | 'REFUND'; method: 'CASH' | 'CARD';
    amount: number; at: string; customerKey?: string; note?: string; originalId?: string;
    seatId?: string;
  }) {
    return prisma.bookingLedgerEntry.create({
      data: {
        clubId: club.id, bookingId: args.bookingId, seatId: args.seatId,
        customerId: args.customerKey ? cid(args.customerKey) : undefined,
        requestId: nextRequestId(), kind: args.kind, method: args.method,
        amount: args.amount, account: args.method === 'CASH' ? 'Каса' : 'Термінал',
        note: args.note ?? '', originalId: args.originalId,
        actorId: '00000000-0000-4000-8000-000000000001',
        actorEmail: 'admin@kort-demo.test', actorRole: 'ADMIN',
        createdAt: kyiv(args.at),
      },
    });
  }

  /* ══ СЕРПЕНЬ 2026 ═══════════════════════════════════════════════════ */

  // 1) Іван Готівков — оплата готівкою, повна ціна.
  const ivanAug = await privateBooking({
    key: 'ivanAug', customerKey: 'ivan', courtId: court1.id,
    start: '2026-08-03T10:00:00', end: '2026-08-03T11:00:00', priceTotal: COURT1_PRICE,
    attendance: 'ARRIVED',
  });
  await cashLedger({ bookingId: ivanAug.id, kind: 'PAYMENT', method: 'CASH', amount: COURT1_PRICE, at: '2026-08-03T09:50:00', customerKey: 'ivan' });

  // 2) Марія Термінал — оплата терміналом (card).
  const mariaAug = await privateBooking({
    key: 'mariaAug', customerKey: 'maria', courtId: court2.id,
    start: '2026-08-04T12:00:00', end: '2026-08-04T13:00:00', priceTotal: COURT2_PRICE,
    attendance: 'ARRIVED',
  });
  await cashLedger({ bookingId: mariaAug.id, kind: 'PAYMENT', method: 'CARD', amount: COURT2_PRICE, at: '2026-08-04T11:50:00', customerKey: 'maria' });

  // 3) Олег Онлайн — оплата карткою через платіжку (mock), окрема модель Payment.
  const olegAug = await privateBooking({
    key: 'olegAug', customerKey: 'oleg', courtId: court1.id,
    start: '2026-08-05T09:00:00', end: '2026-08-05T10:00:00', priceTotal: COURT1_PRICE,
    attendance: 'ARRIVED',
  });
  await prisma.payment.create({
    data: {
      clubId: club.id, bookingId: olegAug.id, provider: 'mock', providerRef: 'ref-oleg-aug',
      amount: COURT1_PRICE, status: 'PAID', paidAt: kyiv('2026-08-05T08:40:00'),
    },
  });

  // 4–6) Олена Згасає — три візити в серпні, жодного у вересні (FADING/at-risk).
  for (const [n, day] of [['1', '02'], ['2', '09'], ['3', '16']] as const) {
    const b = await privateBooking({
      key: `olenaAug${n}`, customerKey: 'olena', courtId: court1.id,
      start: `2026-08-${day}T10:00:00`, end: `2026-08-${day}T11:00:00`, priceTotal: COURT1_PRICE,
      attendance: 'ARRIVED',
    });
    await cashLedger({ bookingId: b.id, kind: 'PAYMENT', method: 'CASH', amount: COURT1_PRICE, at: `2026-08-${day}T09:50:00`, customerKey: 'olena' });
  }

  // 7) Абонемент "8 занять" — проданий у серпні, готівкою.
  const nastyaPass = await prisma.pass.create({
    data: {
      clubId: club.id, customerId: cid('nastya'), type: 'PACKAGE',
      totalSessions: PASS_SESSIONS, usedSessions: 0,
      validFrom: kyiv('2026-08-08T00:00:00'), validUntil: kyiv('2026-10-07T00:00:00'),
      price: PASS_PRICE, payMethod: 'CASH', payAccount: 'Каса',
      createdAt: kyiv('2026-08-08T10:00:00'),
    },
  });

  // 8–9) Дві сесії з абонемента в серпні — по повній ціні корту (№06: мали б
  // рахуватись по ціні заняття з абонемента, 40 000 коп, а не 50 000).
  async function passSession(key: string, day: string, month = '08') {
    const b = await privateBooking({
      key, customerKey: 'nastya', courtId: court1.id,
      start: `2026-${month}-${day}T10:00:00`, end: `2026-${month}-${day}T11:00:00`, priceTotal: COURT1_PRICE,
      attendance: 'ARRIVED',
    });
    await prisma.pass.update({ where: { id: nastyaPass.id }, data: { usedSessions: { increment: 1 } } });
    await prisma.passUsage.create({ data: { passId: nastyaPass.id, bookingId: b.id, by: 'SYSTEM' } });
    return b;
  }
  await passSession('passAug1', '11');
  await passSession('passAug2', '25');

  // 10) Групове заняття "Йога": 4 місця, одне неоплачене (Тарас).
  const yogaAug = await prisma.booking.create({
    data: {
      clubId: club.id, courtId: court2.id, capacity: 4, title: 'Йога', pricePerSeat: 15_000,
      trainerId: trainer.id, trainerPrice: 24_000,
      // priceTotal групи — сума ЛИШЕ оплачених місць (так само, як у
      // застосунку: неоплачене місце не піднімає priceTotal контейнера).
      priceTotal: 15_000 * 3,
      startTime: kyiv('2026-08-06T18:00:00'), endTime: kyiv('2026-08-06T19:00:00'),
      status: 'CONFIRMED', source: 'ADMIN',
    },
  });
  async function seat(bookingId: string, key: string, status: 'BOOKED', price: number) {
    return prisma.bookingSeat.create({
      data: {
        bookingId, customerId: cid(key), customerName: cname(key), customerPhone: cphone(key),
        status, price, source: 'ADMIN',
      },
    });
  }
  const seatDaryna = await seat(yogaAug.id, 'daryna', 'BOOKED', 15_000);
  const seatKostya = await seat(yogaAug.id, 'kostya', 'BOOKED', 15_000);
  const seatLiza = await seat(yogaAug.id, 'liza', 'BOOKED', 15_000);
  await seat(yogaAug.id, 'taras', 'BOOKED', 15_000); // без оплати навмисно
  await cashLedger({ bookingId: yogaAug.id, seatId: seatDaryna.id, kind: 'PAYMENT', method: 'CASH', amount: 15_000, at: '2026-08-06T17:50:00', customerKey: 'daryna' });
  await cashLedger({ bookingId: yogaAug.id, seatId: seatKostya.id, kind: 'PAYMENT', method: 'CASH', amount: 15_000, at: '2026-08-06T17:50:00', customerKey: 'kostya' });
  await cashLedger({ bookingId: yogaAug.id, seatId: seatLiza.id, kind: 'PAYMENT', method: 'CARD', amount: 15_000, at: '2026-08-06T17:52:00', customerKey: 'liza' });

  // 11) Наталка Тренування — приватна бронь з тренером: тренерські гроші
  // "зашиті" у priceTotal (№05).
  const natalkaAug = await privateBooking({
    key: 'natalkaAug', customerKey: 'natalka', courtId: court1.id,
    start: '2026-08-10T15:00:00', end: '2026-08-10T16:00:00',
    priceTotal: COURT1_PRICE + TRAINER_RATE, trainerId: trainer.id, trainerPrice: TRAINER_RATE,
    attendance: 'ARRIVED',
  });
  await cashLedger({ bookingId: natalkaAug.id, kind: 'PAYMENT', method: 'CASH', amount: COURT1_PRICE + TRAINER_RATE, at: '2026-08-10T14:50:00', customerKey: 'natalka' });

  // 12) Богдан Прокат — приватна бронь + прокат 2 ракеток (№05).
  const bogdanAug = await privateBooking({
    key: 'bogdanAug', customerKey: 'bogdan', courtId: court2.id,
    start: '2026-08-12T17:00:00', end: '2026-08-12T18:00:00',
    priceTotal: COURT2_PRICE + 10_000, attendance: 'ARRIVED',
  });
  await prisma.booking.update({ where: { id: bogdanAug.id }, data: { rentalTotal: 10_000 } });
  await prisma.bookingRental.create({
    data: {
      clubId: club.id, bookingId: bogdanAug.id, itemId: racket.id, itemName: 'Ракетка',
      quantity: 2, mode: 'FIXED', unitPrice: 5_000, amount: 10_000, returnable: true,
      status: 'RETURNED', issuedAt: kyiv('2026-08-12T17:00:00'), issuedBy: 'admin@kort-demo.test',
      returnedAt: kyiv('2026-08-12T18:05:00'), returnedBy: 'admin@kort-demo.test',
    },
  });
  await cashLedger({ bookingId: bogdanAug.id, kind: 'PAYMENT', method: 'CASH', amount: COURT2_PRICE + 10_000, at: '2026-08-12T16:50:00', customerKey: 'bogdan' });

  // 13) Юля Знижка — акція -10% діє лише в серпні.
  const promoDiscountAug = Math.round(COURT1_PRICE * 0.1); // 5 000
  const yuliaAug = await privateBooking({
    key: 'yuliaAug', customerKey: 'yulia', courtId: court1.id,
    start: '2026-08-15T11:00:00', end: '2026-08-15T12:00:00',
    priceTotal: COURT1_PRICE - promoDiscountAug,
    promoNames: ['Літня знижка'], promoDiscount: promoDiscountAug, attendance: 'ARRIVED',
  });
  await cashLedger({ bookingId: yuliaAug.id, kind: 'PAYMENT', method: 'CASH', amount: COURT1_PRICE - promoDiscountAug, at: '2026-08-15T10:50:00', customerKey: 'yulia' });

  // 14) Ігор Повернення — оплата, потім повне повернення і скасування.
  const igorAug = await privateBooking({
    key: 'igorAug', customerKey: 'igor', courtId: court2.id,
    start: '2026-08-18T19:00:00', end: '2026-08-18T20:00:00', priceTotal: COURT2_PRICE,
    status: 'CANCELLED', cancelledAt: '2026-08-20T10:05:00',
  });
  const igorPay = await cashLedger({ bookingId: igorAug.id, kind: 'PAYMENT', method: 'CASH', amount: COURT2_PRICE, at: '2026-08-18T18:55:00', customerKey: 'igor' });
  await cashLedger({ bookingId: igorAug.id, kind: 'REFUND', method: 'CASH', amount: COURT2_PRICE, at: '2026-08-20T10:05:00', customerKey: 'igor', note: 'Гравець відмовився, повне повернення', originalId: igorPay.id });

  // 15) Настуся Неявка — оплачено заздалегідь, на корт не прийшла.
  const nastusyaAug = await privateBooking({
    key: 'nastusyaAug', customerKey: 'nastusya', courtId: court1.id,
    start: '2026-08-22T08:00:00', end: '2026-08-22T09:00:00', priceTotal: COURT1_PRICE,
    attendance: 'NO_SHOW',
  });
  await prisma.booking.update({ where: { id: nastusyaAug.id }, data: { attendanceAt: kyiv('2026-08-22T09:05:00'), attendanceBy: 'admin@kort-demo.test' } });
  await cashLedger({ bookingId: nastusyaAug.id, kind: 'PAYMENT', method: 'CASH', amount: COURT1_PRICE, at: '2026-08-21T18:00:00', customerKey: 'nastusya' });

  // 16) Максим Боржник — частково оплатив у серпні (15 000 з 40 000), борг
  // 25 000 закриється у вересні (перевіряє "новий борг / погашений борг").
  const maksymAug = await privateBooking({
    key: 'maksymAug', customerKey: 'maksym', courtId: court2.id,
    start: '2026-08-28T16:00:00', end: '2026-08-28T17:00:00', priceTotal: COURT2_PRICE,
    attendance: 'ARRIVED',
  });
  await cashLedger({ bookingId: maksymAug.id, kind: 'PAYMENT', method: 'CASH', amount: 15_000, at: '2026-08-28T15:55:00', customerKey: 'maksym' });

  // 17) Дмитро Липневий — єдиний візит 2026-07-15, поза серпнем/вереснем.
  // Потрібен рівно для розбіжності №04 (FADING у картотеці, але не в
  // /analytics/deep atRisk) — див. коментар у customerDefs вище.
  const dmytroJul = await privateBooking({
    key: 'dmytroJul', customerKey: 'dmytro', courtId: court1.id,
    start: '2026-07-15T10:00:00', end: '2026-07-15T11:00:00', priceTotal: COURT1_PRICE,
    attendance: 'ARRIVED',
  });
  await cashLedger({ bookingId: dmytroJul.id, kind: 'PAYMENT', method: 'CASH', amount: COURT1_PRICE, at: '2026-07-15T09:50:00', customerKey: 'dmytro' });

  /* ══ ВЕРЕСЕНЬ 2026 ══════════════════════════════════════════════════ */

  // 18–19) Ще дві сесії з абонемента Насті — продано в серпні, використано у вересні.
  await passSession('passSep1', '03', '09');
  await passSession('passSep2', '17', '09');

  // 20) Групове заняття "Груповий теніс" — без тренера, усі місця оплачені.
  const tennisSep = await prisma.booking.create({
    data: {
      clubId: club.id, courtId: court2.id, capacity: 3, title: 'Груповий теніс', pricePerSeat: 15_000,
      priceTotal: 15_000 * 3,
      startTime: kyiv('2026-09-10T18:00:00'), endTime: kyiv('2026-09-10T19:00:00'),
      status: 'CONFIRMED', source: 'ADMIN',
    },
  });
  const seatDaryna2 = await seat(tennisSep.id, 'daryna', 'BOOKED', 15_000);
  const seatLiza2 = await seat(tennisSep.id, 'liza', 'BOOKED', 15_000);
  const seatRoman = await seat(tennisSep.id, 'roman', 'BOOKED', 15_000);
  await cashLedger({ bookingId: tennisSep.id, seatId: seatDaryna2.id, kind: 'PAYMENT', method: 'CASH', amount: 15_000, at: '2026-09-10T17:50:00', customerKey: 'daryna' });
  await cashLedger({ bookingId: tennisSep.id, seatId: seatLiza2.id, kind: 'PAYMENT', method: 'CARD', amount: 15_000, at: '2026-09-10T17:52:00', customerKey: 'liza' });
  await cashLedger({ bookingId: tennisSep.id, seatId: seatRoman.id, kind: 'PAYMENT', method: 'CASH', amount: 15_000, at: '2026-09-10T17:50:00', customerKey: 'roman' });

  // 21) Даша Боржниця — частково оплатила (20 000 з 40 000), борг лишається
  // відкритим на момент перевірки.
  const dashaSep = await privateBooking({
    key: 'dashaSep', customerKey: 'dasha', courtId: court2.id,
    start: '2026-09-05T16:00:00', end: '2026-09-05T17:00:00', priceTotal: COURT2_PRICE,
    attendance: 'ARRIVED',
  });
  await cashLedger({ bookingId: dashaSep.id, kind: 'PAYMENT', method: 'CASH', amount: 20_000, at: '2026-09-05T15:55:00', customerKey: 'dasha' });

  // 22) Максим Боржник погашає залишок серпневого боргу у вересні.
  await cashLedger({ bookingId: maksymAug.id, kind: 'PAYMENT', method: 'CASH', amount: 25_000, at: '2026-09-02T10:00:00', customerKey: 'maksym', note: 'Погашення залишку боргу за 28.08' });

  // 23) Сергій Скасував — скасовано за день до заняття, оплати не було.
  await privateBooking({
    key: 'sergiySep', customerKey: 'sergiy', courtId: court1.id,
    start: '2026-09-08T09:00:00', end: '2026-09-08T10:00:00', priceTotal: COURT1_PRICE,
    status: 'CANCELLED', cancelledAt: '2026-09-07T18:00:00',
  });

  // 24) Марія Термінал — повторний візит у вересні.
  const mariaSep = await privateBooking({
    key: 'mariaSep', customerKey: 'maria', courtId: court2.id,
    start: '2026-09-12T12:00:00', end: '2026-09-12T13:00:00', priceTotal: COURT2_PRICE,
    attendance: 'ARRIVED',
  });
  await cashLedger({ bookingId: mariaSep.id, kind: 'PAYMENT', method: 'CARD', amount: COURT2_PRICE, at: '2026-09-12T11:50:00', customerKey: 'maria' });

  // 25) Наталка Тренування — повторна бронь із тренером у вересні.
  const natalkaSep = await privateBooking({
    key: 'natalkaSep', customerKey: 'natalka', courtId: court1.id,
    start: '2026-09-15T15:00:00', end: '2026-09-15T16:00:00',
    priceTotal: COURT1_PRICE + TRAINER_RATE, trainerId: trainer.id, trainerPrice: TRAINER_RATE,
    attendance: 'ARRIVED',
  });
  await cashLedger({ bookingId: natalkaSep.id, kind: 'PAYMENT', method: 'CASH', amount: COURT1_PRICE + TRAINER_RATE, at: '2026-09-15T14:50:00', customerKey: 'natalka' });

  // 26) Іван Готівков — повторний візит у вересні.
  const ivanSep = await privateBooking({
    key: 'ivanSep', customerKey: 'ivan', courtId: court1.id,
    start: '2026-09-20T10:00:00', end: '2026-09-20T11:00:00', priceTotal: COURT1_PRICE,
    attendance: 'ARRIVED',
  });
  await cashLedger({ bookingId: ivanSep.id, kind: 'PAYMENT', method: 'CASH', amount: COURT1_PRICE, at: '2026-09-20T09:50:00', customerKey: 'ivan' });

  // 27) Юля Знижка — той самий клієнт у вересні, БЕЗ акції (акція діяла
  // лише в серпні) — повна ціна, promoNames порожній.
  const yuliaSep = await privateBooking({
    key: 'yuliaSep', customerKey: 'yulia', courtId: court1.id,
    start: '2026-09-22T11:00:00', end: '2026-09-22T12:00:00', priceTotal: COURT1_PRICE,
    attendance: 'ARRIVED',
  });
  await cashLedger({ bookingId: yuliaSep.id, kind: 'PAYMENT', method: 'CASH', amount: COURT1_PRICE, at: '2026-09-22T10:50:00', customerKey: 'yulia' });

  // 28) Богдан Прокат — повторний прокат у вересні, 1 ракетка, не повернена.
  const bogdanSep = await privateBooking({
    key: 'bogdanSep', customerKey: 'bogdan', courtId: court2.id,
    start: '2026-09-24T17:00:00', end: '2026-09-24T18:00:00',
    priceTotal: COURT2_PRICE + 5_000, attendance: 'ARRIVED',
  });
  await prisma.booking.update({ where: { id: bogdanSep.id }, data: { rentalTotal: 5_000 } });
  await prisma.bookingRental.create({
    data: {
      clubId: club.id, bookingId: bogdanSep.id, itemId: racket.id, itemName: 'Ракетка',
      quantity: 1, mode: 'FIXED', unitPrice: 5_000, amount: 5_000, returnable: true,
      status: 'ISSUED', issuedAt: kyiv('2026-09-24T17:00:00'), issuedBy: 'admin@kort-demo.test',
    },
  });
  await cashLedger({ bookingId: bogdanSep.id, kind: 'PAYMENT', method: 'CARD', amount: COURT2_PRICE + 5_000, at: '2026-09-24T16:50:00', customerKey: 'bogdan' });

  // 29–30) Дві майбутні (відносно "сьогодні") підтверджені броні в кінці
  // вересня — неоплачені, але входять у нарахування місяця повністю.
  await privateBooking({
    key: 'future1', customerKey: 'future1', courtId: court2.id,
    start: '2026-09-29T10:00:00', end: '2026-09-29T11:00:00', priceTotal: COURT2_PRICE,
  });
  await privateBooking({
    key: 'future2', customerKey: 'future2', courtId: court1.id,
    start: '2026-09-30T15:00:00', end: '2026-09-30T16:00:00', priceTotal: COURT1_PRICE,
  });

  /* ── Витрати клубу: серпень повний, вересень БЕЗ оренди (навмисно) ─── */
  async function expense(month: string, category: 'RENT' | 'SALARY' | 'BANK_FEE', label: string, amountGrn: number) {
    return prisma.clubExpense.create({
      data: { clubId: club.id, month: monthDate(month), category, label, amount: Math.round(amountGrn * 100) },
    });
  }
  await expense('2026-08', 'RENT', 'Оренда залу', 15_000);
  await expense('2026-08', 'SALARY', 'Зарплата адміністратора', 12_000);
  await expense('2026-08', 'BANK_FEE', 'Комісія еквайрингу', 500);
  await expense('2026-09', 'SALARY', 'Зарплата адміністратора', 12_000);
  // Оренда за вересень навмисно НЕ внесена — саме цю прогалину має ловити
  // "expensesMissing"/порівняння з fallbackExpenses у breakEven().

  /* ── Закриття змін: серпень — точно, вересень — з нестачею готівки ─── */
  await prisma.shiftClose.create({
    data: {
      clubId: club.id, requestId: nextRequestId(),
      openedAt: kyiv('2026-08-01T08:00:00'), closedAt: kyiv('2026-08-31T22:00:00'),
      expectedCash: 830_000, countedCash: 830_000,
      expectedCard: 55_000, countedCard: 55_000,
      entriesCount: 16, note: 'Серпень зійшовся без розбіжностей.',
      actorId: '00000000-0000-4000-8000-000000000001', actorEmail: 'admin@kort-demo.test',
      actorName: 'Адміністратор', actorRole: 'ADMIN',
    },
  });
  await prisma.shiftClose.create({
    data: {
      clubId: club.id, requestId: nextRequestId(),
      openedAt: kyiv('2026-09-01T08:00:00'), closedAt: kyiv('2026-09-28T22:00:00'),
      expectedCash: 255_000, countedCash: 250_000,
      expectedCard: 100_000, countedCard: 100_000,
      entriesCount: 10, note: 'Нестача готівки 50 грн — з’ясовуємо з адміністратором зміни.',
      actorId: '00000000-0000-4000-8000-000000000001', actorEmail: 'admin@kort-demo.test',
      actorName: 'Адміністратор', actorRole: 'ADMIN',
    },
  });

  console.log('\n  ✓ Еталонний клуб готовий');
  console.log(`    slug: ${SLUG}`);
  console.log('    owner@kort-demo.test / RefClub-Owner-2026');
  console.log('    admin@kort-demo.test / RefClub-Admin-2026');
  console.log('    Очікувані цифри: court-booking-api/docs/finance/reference-club.md');
  console.log('    Перевірка проти API: npx tsx scripts/reference-check.ts\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
