/**
 * Повністю ізольований локальний запуск API для демо кабінету.
 *
 * Без Docker, без Postgres, БЕЗ жодного зв'язку з онлайн-базою:
 *   1. піднімає Postgres у процесі (PGlite, WASM) і віддає його по сокету
 *      на 127.0.0.1 (pglite-socket), тож звичайний Prisma працює без змін у src/;
 *   2. накочує ВСІ prisma/migrations/*\/migration.sql по порядку;
 *   3. засіває вигаданий демо-клуб (див. scripts/README-dev-isolated.md);
 *   4. стартує API (tsx watch src/index.ts) на PORT (за замовчуванням 3000).
 *
 * База живе в пам'яті цього процесу: Ctrl+C = усе зникає, наступний запуск
 * знову чистий стан. Нічого не пишеться на диск і ніщо не йде в мережу.
 *
 * .env НЕ читається: DATABASE_URL / DIRECT_URL / секрети задаються тут у
 * середовищі дочірнього процесу, а dotenv не перезаписує вже задані змінні.
 *
 * Запуск:  npm run dev:isolated
 * Прапорці: --seed-only  (накотити + засіяти + вийти; для перевірки)
 *           --no-api     (лишити тільки базу на DB-порту, без API)
 * Порти:   PORT (API, 3000), ISOLATED_DB_PORT (БД, 54329)
 *
 * Запускається через tsx (див. package.json), щоб імпортувати hashPassword із src/.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const SEED_ONLY = argv.includes('--seed-only');
const NO_API = argv.includes('--no-api');

const DB_PORT = Number(process.env.ISOLATED_DB_PORT ?? 54329);
const API_PORT = String(process.env.PORT ?? 3000);

// Єдина адреса БД, яку цей процес коли-небудь використовує. pgbouncer=true (без
// іменованих prepared statements) і connection_limit=1 обов'язкові: PGlite має одну
// сесію на всі з'єднання, і імена s0, s1... інакше стикаються між клієнтами.
const LOCAL_URL = `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres?sslmode=disable&connection_limit=1&pgbouncer=true`;

// ДО будь-яких імпортів Prisma: навіть випадково успадкований прод-URL
// з оболонки перекривається.
process.env.DATABASE_URL = LOCAL_URL;
process.env.DIRECT_URL = LOCAL_URL;

const { PGlite } = await import('@electric-sql/pglite');
const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
const { PrismaClient } = await import('@prisma/client');
const { DateTime } = await import('luxon');
const { hashPassword } = await import(pathToFileURL(path.join(ROOT, 'src/lib/passwordHash.ts')).href);

const BAR = '='.repeat(72);
console.log(`\n${BAR}\n  ІЗОЛЬОВАНИЙ ДЕМО-РЕЖИМ: база в пам'яті, онлайн-БД не зачіпається\n${BAR}\n`);

/* ── 1. База + міграції ─────────────────────────────────────────────────── */
const pg = await PGlite.create({ extensions: { btree_gist } });

const migDir = path.join(ROOT, 'prisma', 'migrations');
const migrations = readdirSync(migDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
for (const name of migrations) {
  const sql = readFileSync(path.join(migDir, name, 'migration.sql'), 'utf8');
  try {
    await pg.exec(sql);
  } catch (e) {
    console.error(`Міграція ${name} не пройшла: ${e.message}`);
    process.exit(1);
  }
}
console.log(`Міграцій накочено: ${migrations.length}`);

const server = new PGLiteSocketServer({ db: pg, port: DB_PORT, host: '127.0.0.1', maxConnections: 10 });
await server.start();
console.log(`In-process Postgres слухає 127.0.0.1:${DB_PORT}`);

/* ── 2. Демо-дані (усе вигадане) ────────────────────────────────────────── */
const DEMO_PASSWORD = 'DemoOnly-2026!';
const USERS = [
  { email: 'owner@demo.test', name: 'Олена Демченко (власник)', role: 'OWNER' },
  { email: 'admin@demo.test', name: 'Максим Адмін (адміністратор)', role: 'ADMIN' },
  { email: 'trainer@demo.test', name: 'Андрій Тренер', role: 'TRAINER' },
  { email: 'accountant@demo.test', name: 'Ірина Бухгалтер', role: 'ACCOUNTANT' },
];
const TZ = 'Europe/Kyiv';

const prisma = new PrismaClient({ datasourceUrl: LOCAL_URL });

function phone(n) {
  // +380 00 000 00 NN — вигаданий, нікому не належить
  return `+38000000${String(n).padStart(4, '0')}`;
}
const uuid = () => randomUUID();

async function seed() {
  const now = DateTime.now().setZone(TZ);
  const day0 = now.startOf('day');
  const at = (dayOffset, hour, minute = 0) => day0.plus({ days: dayOffset }).set({ hour, minute }).toJSDate();
  const mins = (d, h, m = 0) => day0.plus({ days: d }).set({ hour: h, minute: m });

  // Плани (як у scripts/plans-init.ts) і клуб на плані tier 3.
  const planDefs = [
    { code: 'base', name: 'Броні', price: 100000, tier: 1, sortOrder: 10, featTrainers: false, featGroups: false, featAnalytics: false },
    { code: 'team', name: 'Команда', price: 150000, tier: 2, sortOrder: 20, featTrainers: true, featGroups: true, featAnalytics: false },
    { code: 'pro', name: 'Аналітика', price: 250000, tier: 3, sortOrder: 30, featTrainers: true, featGroups: true, featAnalytics: true },
  ];
  let proPlan;
  for (const p of planDefs) {
    const row = await prisma.plan.create({ data: { ...p, description: 'DEMO' } });
    if (p.code === 'pro') proPlan = row;
  }

  const club = await prisma.club.create({
    data: {
      name: 'Squash Arena (ДЕМО)',
      slug: 'squash-arena',
      timezone: TZ,
      phone: '+380 00 000 00 00',
      address: 'вул. Вигадана, 1, Київ (демо)',
      slotMinutes: 60,
      leadTimeMinutes: 30,
      horizonDays: 14,
      autoConfirm: true,
      passesEnabled: true,
      planId: proPlan.id,
      planPrice: proPlan.price,
      paidUntil: now.plus({ days: 30 }).toJSDate(),
      approvedAt: now.toJSDate(),
      offerAcceptedAt: now.toJSDate(),
      offerVersion: '2026-09',
      taxRegime: 'FOP_3',
      email: 'club@demo.test',
    },
  });

  await prisma.clubHours.createMany({
    data: Array.from({ length: 7 }, (_, weekday) => ({
      clubId: club.id,
      weekday,
      openMinute: weekday === 0 || weekday === 6 ? 9 * 60 : 8 * 60,
      closeMinute: weekday === 0 || weekday === 6 ? 21 * 60 : 22 * 60,
    })),
  });

  const courtDefs = [
    ['Корт 1', 45000], ['Корт 2', 45000], ['Корт 3', 45000],
    ['Корт 4', 45000], ['Корт 5', 50000], ['VIP корт', 70000],
  ];
  const courts = [];
  for (let i = 0; i < courtDefs.length; i++) {
    courts.push(await prisma.court.create({
      data: { clubId: club.id, name: courtDefs[i][0], pricePerHour: courtDefs[i][1], sortOrder: i + 1 },
    }));
  }

  // Тренер + акаунти персоналу
  const trainer = await prisma.trainer.create({
    data: { clubId: club.id, name: 'Андрій Тренер', phone: phone(900), pricePerHour: 60000, note: 'Демо-тренер', sortOrder: 1 },
  });
  await prisma.trainerHours.createMany({
    data: [1, 2, 3, 4, 5, 6, 0].map((weekday) => ({
      trainerId: trainer.id, weekday, openMinute: 10 * 60, closeMinute: 20 * 60, isClosed: weekday === 0,
    })),
  });

  const hash = await hashPassword(DEMO_PASSWORD, 10);
  const users = {};
  for (const u of USERS) {
    users[u.role] = await prisma.user.create({
      data: {
        clubId: club.id, email: u.email, name: u.name, role: u.role, passwordHash: hash,
        trainerId: u.role === 'TRAINER' ? trainer.id : null,
      },
    });
  }
  const owner = users.OWNER;
  const admin = users.ADMIN;

  // Клієнти
  const names = [
    'Олег Коваленко', 'Марія Шевчук', 'Дмитро Бондар', 'Анна Мельник', 'Сергій Ткаченко',
    'Катерина Кравченко', 'Володимир Олійник', 'Наталя Лисенко', 'Богдан Савчук', 'Юлія Руденко',
    'Павло Мороз', 'Тетяна Гончар', 'Роман Василенко', 'Оксана Паламарчук', 'Іван Кушнір',
    'Світлана Білик', 'Артем Яременко', 'Леся Клименко', 'Тарас Демʼяненко', 'Віра Степаненко',
    'Денис Харченко', 'Ольга Сидоренко', 'Микита Пономаренко', 'Єва Гриценко',
  ];
  const customers = [];
  for (let i = 0; i < names.length; i++) {
    const p = phone(i + 1);
    customers.push(await prisma.customer.create({
      data: {
        clubId: club.id, name: names[i], phone: p, phoneTail: p.slice(-7),
        email: i % 3 === 0 ? `player${i + 1}@demo.test` : null,
        skillLevel: ['D', 'C', 'C_PLUS', 'B', 'B_PLUS'][i % 5],
        firstChannel: ['DIRECT', 'SOCIAL', 'SEARCH', 'REFERRAL', 'RECEPTION', 'BOT'][i % 6],
        createdAt: day0.minus({ days: 40 - i }).toJSDate(),
        termsAcceptedAt: now.toJSDate(), termsVersion: '2026-09',
      },
    }));
  }

  // ── Бронювання ──
  // Для кожного: [день, корт, година, тривалість(год), клієнт, оплата, статус-виклад]
  // Оплата: null = не оплачено; ['CASH'|'CARD'|'TRANSFER', рахунок]; 'ONLINE'
  const ACC = { CASH: 'Каса', CARD: 'Термінал', TRANSFER: 'Рахунок клубу' };
  const pickPay = (i) => (['CASH', 'CARD', 'CARD', 'TRANSFER', 'ONLINE'][i % 5]);
  const planned = []; // { d, court, h, dur, cust, pay, trainer? }
  // Блокування кортів (створюються нижче) — броні в ці вікна не ставимо.
  const BLOCKS = [{ d: 0, court: 2, from: 12, to: 14 }, { d: 2, court: 4, from: 10, to: 14 }];
  const overlaps = (a, b) => a.d === b.d && a.h < b.h + b.dur && b.h < a.h + a.dur;
  // Додає бронь лише якщо вона не перетинає наявні (корт, тренер, блок) — як і EXCLUDE-констрейнти.
  const add = (p) => {
    if (BLOCKS.some((b) => b.d === p.d && b.court === p.court && p.h < b.to && b.from < p.h + p.dur)) return;
    if (planned.some((q) => overlaps(p, q) && (q.court === p.court || (p.trainer && q.trainer)))) return;
    planned.push(p);
  };

  // Тренерські заняття сьогодні (спершу, щоб їхні слоти не відібрали звичайні броні)
  [[1, 11, 22], [3, 13, 23], [5, 16, 3]].forEach(([c, h, ci]) => add({ d: 0, court: c, h, dur: 1, cust: ci, pay: 'CARD', trainer: true }));
  // Сьогодні: реалістичний день (минулі години — відвідані, майбутні — активні)
  const today = [
    [0, 8, 1, 0], [1, 8, 1, 1], [3, 9, 1, 2], [0, 10, 1, 3], [2, 10, 2, 4],
    [4, 11, 1, 5], [1, 12, 1, 6], [5, 12, 1, 7], [0, 13, 1, 8], [3, 14, 1, 9],
    [2, 15, 1, 10], [4, 16, 1, 11], [0, 17, 1, 12], [1, 17, 2, 13], [5, 18, 1, 14],
    [3, 18, 1, 15], [2, 19, 1, 16], [0, 19, 1, 17], [4, 20, 1, 18], [1, 20, 1, 19],
    [5, 20, 1, 20], [3, 20, 1, 21],
  ];
  today.forEach(([c, h, dur, ci], i) => add({ d: 0, court: c, h, dur, cust: ci, pay: i % 7 === 6 ? null : pickPay(i) }));

  // Завтра
  [[0, 9, 4], [1, 11, 5], [3, 18, 6], [2, 19, 7], [5, 19, 8], [4, 20, 9]].forEach(([c, h, ci], i) =>
    add({ d: 1, court: c, h, dur: 1, cust: ci, pay: i % 2 ? null : 'CARD' }));

  // Історія 30 днів: детермінована, без перетинів (корт×година унікальні за день)
  for (let d = -30; d < 0; d++) {
    const wd = day0.plus({ days: d }).weekday; // 1..7
    const count = wd >= 6 ? 12 : 8;
    for (let k = 0; k < count; k++) {
      const court = (k * 5 + d * 3 + 120) % 6;
      const h = 9 + ((k * 3 + (d + 60)) % 12);
      add({ d, court, h, dur: 1, cust: (k * 7 + d + 60) % customers.length, pay: pickPay(k + d + 60) });
    }
  }

  const created = [];
  for (const p of planned) {
    const court = courts[p.court];
    const start = mins(p.d, p.h);
    const end = start.plus({ hours: p.dur });
    const isPast = end.toMillis() <= now.toMillis();
    const cust = customers[p.cust];
    const trainerPrice = p.trainer ? trainer.pricePerHour : 0;
    const priceTotal = court.pricePerHour * p.dur + trainerPrice;
    const paid = p.pay !== null;
    const noShow = isPast && !p.trainer && (p.cust % 11 === 5);
    const row = await prisma.booking.create({
      data: {
        clubId: club.id, courtId: court.id,
        customerId: cust.id, customerName: cust.name, customerPhone: cust.phone,
        trainerId: p.trainer ? trainer.id : null, trainerPrice,
        startTime: start.toJSDate(), endTime: end.toJSDate(),
        status: 'CONFIRMED',
        source: p.pay === 'ONLINE' ? 'WIDGET' : 'ADMIN',
        priceTotal, listPrice: priceTotal,
        attendance: isPast ? (noShow ? 'NO_SHOW' : 'ARRIVED') : 'UNKNOWN',
        attendanceAt: isPast ? end.minus({ hours: 1 }).toJSDate() : null,
        paymentPlan: paid ? { method: p.pay === 'ONLINE' ? 'ONLINE' : p.pay, account: p.pay === 'ONLINE' ? '' : ACC[p.pay] } : { method: 'UNSPECIFIED', account: '' },
        createdBy: admin.email,
        createdAt: start.minus({ days: 2 }).toJSDate(),
        trafficChannel: cust.firstChannel,
      },
    });
    created.push({ row, p, isPast });
    if (!paid || noShow) continue;
    const paidAt = (isPast ? end.minus({ minutes: 50 }) : now.minus({ hours: 1 })).toJSDate();
    if (p.pay === 'ONLINE') {
      await prisma.payment.create({
        data: {
          clubId: club.id, bookingId: row.id, provider: 'demo', providerRef: `demo-${row.id}`,
          amount: priceTotal, status: 'PAID', paidAt, providerAt: paidAt,
        },
      });
    } else {
      await prisma.bookingLedgerEntry.create({
        data: {
          clubId: club.id, bookingId: row.id, customerId: cust.id, requestId: uuid(),
          kind: 'PAYMENT', method: p.pay, amount: priceTotal, account: ACC[p.pay],
          note: '', actorId: admin.id, actorEmail: admin.email, actorRole: 'ADMIN', createdAt: paidAt,
        },
      });
    }
  }
  // одне повернення: скасована сьогодні платна бронь з ручним поверненням
  const refundable = created.find((c) => c.p.d === 0 && c.p.pay === 'CARD' && !c.p.trainer && c.isPast === false);
  if (refundable) {
    const orig = await prisma.bookingLedgerEntry.findFirst({ where: { bookingId: refundable.row.id, kind: 'PAYMENT' } });
    if (orig) {
      await prisma.booking.update({
        where: { id: refundable.row.id },
        data: { status: 'CANCELLED', cancelledAt: now.toJSDate(), cancelledBy: { role: 'ADMIN', email: admin.email } },
      });
      await prisma.bookingLedgerEntry.create({
        data: {
          clubId: club.id, bookingId: refundable.row.id, customerId: orig.customerId, requestId: uuid(),
          kind: 'REFUND', method: 'CARD', amount: orig.amount, account: 'Термінал', note: 'Клієнт захворів (демо)',
          originalId: orig.id, actorId: admin.id, actorEmail: admin.email, actorRole: 'ADMIN',
        },
      });
    }
  }

  // Блокування кортів
  const BL = ['Обслуговування покриття', 'Турнір клубу (демо)'];
  await prisma.block.createMany({
    data: BLOCKS.map((b, i) => ({ clubId: club.id, courtId: courts[b.court].id, reason: BL[i], startTime: at(b.d, b.from), endTime: at(b.d, b.to) })),
  });

  // Групове заняття: сьогодні 18:00, Корт 5? (зайнятий) — беремо завтра 17:00 на VIP-вільному корті Корт 4
  const gStart = mins(1, 17);
  const group = await prisma.booking.create({
    data: {
      clubId: club.id, courtId: courts[3].id, capacity: 6, title: 'Група новачків (демо)',
      pricePerSeat: 15000, startTime: gStart.toJSDate(), endTime: gStart.plus({ hours: 1 }).toJSDate(),
      status: 'CONFIRMED', source: 'ADMIN', priceTotal: 0, trainerId: null, createdBy: admin.email,
    },
  });
  for (let i = 0; i < 4; i++) {
    const c = customers[12 + i];
    const seat = await prisma.bookingSeat.create({
      data: { bookingId: group.id, customerId: c.id, customerName: c.name, customerPhone: c.phone, status: 'BOOKED', source: 'ADMIN', price: 15000 },
    });
    if (i < 3) {
      await prisma.bookingLedgerEntry.create({
        data: {
          clubId: club.id, bookingId: group.id, seatId: seat.id, customerId: c.id, requestId: uuid(),
          kind: 'PAYMENT', method: i === 0 ? 'CASH' : 'CARD', amount: 15000, account: i === 0 ? 'Каса' : 'Термінал',
          note: 'Місце в групі', actorId: admin.id, actorEmail: admin.email, actorRole: 'ADMIN',
        },
      });
    }
  }

  // Абонементи
  await prisma.passPlan.createMany({
    data: [
      { clubId: club.id, name: 'Пакет 10 занять', type: 'PACKAGE', totalSessions: 10, days: 90, price: 400000, sortOrder: 1 },
      { clubId: club.id, name: 'Безліміт 30 днів', type: 'UNLIMITED', totalSessions: null, days: 30, price: 600000, sortOrder: 2 },
    ],
  });
  const pass = await prisma.pass.create({
    data: {
      clubId: club.id, customerId: customers[0].id, type: 'PACKAGE', totalSessions: 10, usedSessions: 3,
      validFrom: day0.minus({ days: 20 }).toJSDate(), validUntil: day0.plus({ days: 70 }).toJSDate(),
      price: 400000, payMethod: 'CARD', payAccount: 'Термінал', createdAt: day0.minus({ days: 20 }).toJSDate(),
    },
  });
  const pastOfCust0 = created.filter((c) => c.isPast && c.row.customerId === customers[0].id).slice(0, 3);
  for (const c of pastOfCust0) {
    await prisma.passUsage.create({ data: { passId: pass.id, bookingId: c.row.id, by: admin.email } });
  }
  await prisma.pass.create({
    data: {
      clubId: club.id, customerId: customers[4].id, type: 'UNLIMITED',
      validFrom: day0.minus({ days: 5 }).toJSDate(), validUntil: day0.plus({ days: 25 }).toJSDate(),
      price: 600000, payMethod: 'TRANSFER', payAccount: 'Рахунок клубу', createdAt: day0.minus({ days: 5 }).toJSDate(),
    },
  });

  // Витрати: поточний і попередній місяць
  const m0 = now.startOf('month');
  for (const m of [m0.minus({ months: 1 }), m0]) {
    for (const e of [
      ['RENT', 'Оренда приміщення', 8500000], ['SALARY', 'Зарплата адміністраторів', 6000000],
      ['UTILITIES', 'Комунальні послуги', 1200000], ['MARKETING', 'Реклама (Instagram)', 800000],
      ['BANK_FEE', 'Комісія еквайрингу', 150000], ['TAX', 'Єдиний податок + ЄСВ', 1100000],
      ['EQUIPMENT', "М'ячі та ракетки", 350000],
    ]) {
      await prisma.clubExpense.create({ data: { clubId: club.id, month: m.toJSDate(), category: e[0], label: e[1], amount: e[2] } });
    }
  }

  // Знижка та інвентар
  await prisma.promo.create({
    data: {
      clubId: club.id, title: 'Ранкова знижка -20%', kind: 'WEEKLY', weekdays: [1, 2, 3, 4, 5],
      startMinute: 8 * 60, endMinute: 11 * 60, discountType: 'PERCENT', discountValue: 20, courtIds: [],
    },
  });
  await prisma.inventoryItem.createMany({
    data: [
      { clubId: club.id, name: 'Ракетка для сквошу', category: 'Оренда', quantity: 12, unit: 'шт', rentPrice: 5000, rentMode: 'FIXED', sortOrder: 1 },
      { clubId: club.id, name: 'М\'ячі (набір)', category: 'Продаж', quantity: 40, unit: 'шт', rentPrice: 15000, rentMode: 'FIXED', returnable: false, sortOrder: 2 },
      { clubId: club.id, name: 'Захисні окуляри', category: 'Оренда', quantity: 10, unit: 'шт', rentPrice: 3000, rentMode: 'FIXED', sortOrder: 3 },
    ],
  });

  return { club, bookings: planned.length + 1 };
}

let summary;
try {
  summary = await seed();
} catch (e) {
  console.error('Сід не вдався:', e);
  await prisma.$disconnect();
  await server.stop();
  await pg.close();
  process.exit(1);
}

const counts = {
  bookings: await prisma.booking.count(),
  payments_ledger: await prisma.bookingLedgerEntry.count(),
  customers: await prisma.customer.count(),
  courts: await prisma.court.count(),
};
console.log(`Демо-клуб засіяно: slug=${summary.club.slug}`, JSON.stringify(counts));
console.log(`Логіни (ТІЛЬКИ ДЕМО, пароль для всіх: ${DEMO_PASSWORD}):`);
for (const u of USERS) console.log(`  ${u.role.padEnd(10)} ${u.email}`);
await prisma.$disconnect();

async function shutdown(code = 0) {
  try { await server.stop(); await pg.close(); } catch { /* вихід */ }
  process.exit(code);
}

if (SEED_ONLY) {
  await shutdown(0);
}

if (NO_API) {
  console.log(`\nБаза доступна: ${LOCAL_URL}\nCtrl+C — зупинити (дані зникнуть).`);
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
} else {
  /* ── 3. API на цій базі ── */
  const env = {
    ...process.env,
    DATABASE_URL: LOCAL_URL,
    DIRECT_URL: LOCAL_URL,
    JWT_SECRET: 'isolated-demo-secret-not-for-prod-0123456789',
    PAYMENTS_SECRET: 'isolated-demo-payments-secret-0123456789',
    PUBLIC_API_URL: `http://localhost:${API_PORT}`,
    PORT: API_PORT,
    NODE_ENV: 'development',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_BOT_USERNAME: '',
    TELEGRAM_WEBHOOK_URL: '',
    TELEGRAM_WEBHOOK_SECRET: '',
    GEMINI_API_KEY: '',
    BACKGROUND_JOBS: 'off',
  };
  console.log(`\nСтартую API на http://localhost:${API_PORT} (ізольована база). Ctrl+C — зупинити.\n`);
  const child = spawn('npx tsx watch src/index.ts', { env, cwd: ROOT, stdio: 'inherit', shell: true });
  const stop = () => { child.kill(); shutdown(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => shutdown(code ?? 0));
}
