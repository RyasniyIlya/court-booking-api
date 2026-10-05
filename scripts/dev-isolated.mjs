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
const lib = (f) => import(pathToFileURL(path.join(ROOT, 'src/lib', f)).href);
const { makeUaIban, isValidUaIban } = await lib('partnerRequisites.ts');
const { buildOfferAcceptance } = await lib('partnerOffer.ts');
const { generateActs, transitionAct } = await lib('partnerActs.ts');

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
const OPERATOR_EMAIL = 'operator@demo.test';
const PARTNER_EMAIL = 'partner@demo.test';
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

  // ── Партнер-будівельник, його клуби, рахунки й виплата (усе вигадане) ──
  const partner = await prisma.partner.create({
    data: {
      name: 'Олег Будівельник (ДЕМО)', company: 'ТОВ «Падел Буд» (демо)', email: PARTNER_EMAIL,
      phone: '+380 00 000 00 90', passwordHash: hash, refCode: 'demobud1',
    },
  });
  // ── Наш профіль отримувача (вигаданий ФОП) і реквізити демо-партнера ──
  // IBAN обчислені за mod-97, тож проходять ту саму перевірку, що й API.
  const sellerIban = makeUaIban('300001', '26001000000001');
  const partnerIban = makeUaIban('305299', '26002000000002');
  if (!isValidUaIban(sellerIban) || !isValidUaIban(partnerIban)) throw new Error('Демо-IBAN не пройшли mod-97');
  const seller = await prisma.sellerProfile.create({
    data: {
      kind: 'FOP', label: 'ФОП (демо)', legalName: 'ФОП Демченко Олена Іванівна (ДЕМО)', code: '3000000001',
      taxInfo: 'платник єдиного податку 3 група, неплатник ПДВ', iban: sellerIban, bankName: 'АТ «Демо-банк»',
      address: 'м. Київ, вул. Демонстраційна, 1', signerName: 'Демченко О. І.', signerBasis: 'виписки з ЄДР',
      email: 'seller@demo.test', phone: '+380 00 000 00 99', isDefault: true,
    },
  });
  const partnerReq = {
    kind: 'FOP', legalName: 'ФОП Будівельник Олег Демович (ДЕМО)', legalCode: '3000000002',
    taxInfo: 'платник єдиного податку 3 група, неплатник ПДВ', vatPayer: false, iban: partnerIban,
    bankName: 'АТ «Демо-банк»', legalAddress: 'м. Львів, вул. Будівельна, 2', signerName: 'Будівельник О. Д.',
    signerBasis: 'виписки з ЄДР', docsEmail: 'docs@demo.test', kvedConfirmed: true, requisitesAt: now.toJSDate(),
  };
  await prisma.partner.update({
    where: { id: partner.id },
    data: {
      ...partnerReq,
      ...buildOfferAcceptance(seller, { id: partner.id, ...partnerReq }, '127.0.0.1', now.minus({ months: 8 }).toJSDate()),
    },
  });

  // Squash Arena привʼязана 14 міс. тому — видно обидві ставки (50% і 20%).
  const attachedLongAgo = now.minus({ months: 14 });
  await prisma.club.update({ where: { id: club.id }, data: { partnerId: partner.id, partnerAttachedAt: attachedLongAgo.toJSDate() } });

  const teamPlan = await prisma.plan.findUnique({ where: { code: 'team' } });
  const basePlan = await prisma.plan.findUnique({ where: { code: 'base' } });
  const padel = await prisma.club.create({
    data: {
      name: 'Padel Lviv (ДЕМО)', slug: 'padel-lviv-demo', timezone: TZ, city: 'Львів',
      planId: teamPlan.id, planPrice: teamPlan.price, paidUntil: now.plus({ days: 12 }).toJSDate(),
      approvedAt: now.minus({ months: 3 }).toJSDate(), partnerId: partner.id,
      partnerAttachedAt: now.minus({ months: 3 }).toJSDate(),
    },
  });
  const trial = await prisma.club.create({
    data: {
      name: 'Tennis Dnipro (ДЕМО, пробний)', slug: 'tennis-dnipro-demo', timezone: TZ, city: 'Дніпро',
      planId: basePlan.id, planPrice: basePlan.price, trialEndsAt: now.plus({ days: 10 }).toJSDate(),
      partnerId: partner.id, partnerAttachedAt: now.minus({ days: 4 }).toJSDate(),
    },
  });
  for (const [c, n] of [[padel, 4], [trial, 2]]) {
    for (let i = 1; i <= n; i++) await prisma.court.create({ data: { clubId: c.id, name: `Корт ${i}`, pricePerHour: 60000 } });
  }

  const inv = (clubId, monthsAgo, amount, status, method = 'transfer') => {
    const from = now.minus({ months: monthsAgo }).startOf('month');
    const paid = status === 'PAID';
    return {
      clubId, amount, status, method: paid ? method : null, sellerId: seller.id,
      periodFrom: from.toJSDate(), periodTo: from.plus({ months: 1 }).toJSDate(),
      issuedAt: from.toJSDate(), paidAt: paid ? from.plus({ days: 3 }).toJSDate() : null,
    };
  };
  const invoices = [];
  // Squash Arena: 14 місяців оплат по 2500 → перші 12 по 50%, потім 20%.
  for (let m = 13; m >= 1; m--) invoices.push(inv(club.id, m, 250000, 'PAID', m % 3 ? 'transfer' : 'link'));
  invoices.push(inv(club.id, 0, 250000, 'ISSUED'));
  // Padel Lviv: 3 оплати по 1500 + один скасований рахунок.
  for (let m = 2; m >= 0; m--) invoices.push(inv(padel.id, m, 150000, 'PAID'));
  invoices.push({ ...inv(padel.id, 1, 150000, 'VOID'), note: 'Помилка в сумі (демо)' });

  // Додаємо номери рахунків К-{рік}-{00001...} в порядку issuedAt
  invoices.sort((a, b) => new Date(a.issuedAt) - new Date(b.issuedAt));
  let invNumber = 1;
  for (const inv of invoices) {
    const issueYear = new Date(inv.issuedAt).getFullYear();
    inv.number = `К-${issueYear}-${String(invNumber).padStart(5, '0')}`;
    invNumber++;
  }
  const createdInvoices = await prisma.clubInvoice.createMany({ data: invoices });
  const allInvoices = await prisma.clubInvoice.findMany({ orderBy: { issuedAt: 'asc' } });

  // Знайдемо ISSUED рахунок squash-arena та PAID рахунки для padel-lviv-demo
  const squashIssuedInv = allInvoices.find(inv => inv.clubId === club.id && inv.status === 'ISSUED');
  const padelPaidInvs = allInvoices.filter(inv => inv.clubId === padel.id && inv.status === 'PAID').slice(0, 2);

  // Мінімальні PNG буфери (різні байти для різних sha256)
  const crypto = (await import('node:crypto')).default;
  const makePng = (seed) => {
    const data = Buffer.alloc(67);
    // PNG signature
    data[0] = 0x89; data[1] = 0x50; data[2] = 0x4e; data[3] = 0x47;
    data[4] = 0x0d; data[5] = 0x0a; data[6] = 0x1a; data[7] = 0x0a;
    // IHDR chunk: 1x1 pixel, 8-bit gray
    data[8] = 0x00; data[9] = 0x00; data[10] = 0x00; data[11] = 0x0d;
    data[12] = 0x49; data[13] = 0x48; data[14] = 0x44; data[15] = 0x52;
    data[16] = 0x00; data[17] = 0x00; data[18] = 0x00; data[19] = 0x01;
    data[20] = 0x00; data[21] = 0x00; data[22] = 0x00; data[23] = 0x01;
    data[24] = 0x08; data[25] = 0x00; data[26] = 0x00; data[27] = 0x00; data[28] = 0x00;
    data[29] = 0x3a; data[30] = 0x7e; data[31] = 0x9b; data[32] = 0x55;
    // IDAT chunk with seed byte for variation
    data[33] = 0x00; data[34] = 0x00; data[35] = 0x00; data[36] = 0x0a;
    data[37] = 0x49; data[38] = 0x44; data[39] = 0x41; data[40] = 0x54;
    data[41] = 0x08; data[42] = 0xd7; data[43] = 0x63; data[44] = seed & 0xff;
    data[45] = 0xf8; data[46] = 0x0f; data[47] = 0x00; data[48] = 0x00; data[49] = 0x01;
    data[50] = 0x01; data[51] = 0x01; data[52] = 0x00; data[53] = 0x18; data[54] = 0xdd; data[55] = 0x8d; data[56] = 0xb4;
    // IEND chunk
    data[57] = 0x00; data[58] = 0x00; data[59] = 0x00; data[60] = 0x00;
    data[61] = 0x49; data[62] = 0x45; data[63] = 0x4e; data[64] = 0x44;
    data[65] = 0xae; data[66] = 0x42; data[67] = 0x60; data[68] = 0x82;
    return data.slice(0, 67);
  };

  // Додаємо PaymentReceipt для padel-lviv-demo ISSUED рахунку (наступний місяць)
  const nextMonthInv = await prisma.clubInvoice.create({
    data: {
      clubId: padel.id, amount: 150000, status: 'ISSUED', method: null, sellerId: seller.id,
      periodFrom: now.plus({ months: 1 }).startOf('month').toJSDate(),
      periodTo: now.plus({ months: 2 }).startOf('month').toJSDate(),
      issuedAt: now.plus({ months: 1 }).startOf('month').toJSDate(),
      number: `К-${now.plus({ months: 1 }).year}-${String(100).padStart(5, '0')}`,
    },
  });

  // Квитанції для padel-lviv-demo ISSUED рахунку
  const receiptsToCreate = [];
  const nextMonthDate = now.plus({ months: 1 }).toISO().split('T')[0];
  const lastMonthDate = now.minus({ months: 1 }).toISO().split('T')[0];
  const twoMonthsAgoDate = now.minus({ months: 2 }).toISO().split('T')[0];

  // PENDING + MATCH
  const pngMatch = makePng(1);
  receiptsToCreate.push({
    clubId: padel.id, invoiceId: nextMonthInv.id, fileData: pngMatch, mime: 'image/png', size: pngMatch.length,
    sha256: crypto.createHash('sha256').update(pngMatch).digest('hex'),
    uploadedAt: now.plus({ hours: 1 }).toJSDate(),
    aiStatus: 'DONE', aiCheckedAt: now.plus({ hours: 2 }).toJSDate(),
    aiResult: {
      extracted: { amount: 1500, currency: 'UAH', date: nextMonthDate,
        payerName: 'Padel Club', recipientIban: partnerIban, purpose: `К-${now.plus({ months: 1 }).year}-00100` },
      checks: { amountMatches: true, recipientMatches: true, ibanMatches: true, dateReasonable: true, purposeMentionsInvoice: true },
      rules: { amountOk: true, ibanOk: true, dateOk: true, purposeOk: true, flags: [], verdict: 'MATCH' },
      verdict: 'MATCH', modelVerdict: 'MATCH', confidence: 0.93, notes: 'Демо-квитанція (MATCH)', model: 'gemini-2.0-flash',
    },
    status: 'PENDING',
  });

  // PENDING + MISMATCH
  const pngMismatch = makePng(2);
  receiptsToCreate.push({
    clubId: padel.id, invoiceId: nextMonthInv.id, fileData: pngMismatch, mime: 'image/png', size: pngMismatch.length,
    sha256: crypto.createHash('sha256').update(pngMismatch).digest('hex'),
    uploadedAt: now.plus({ hours: 3 }).toJSDate(),
    aiStatus: 'DONE', aiCheckedAt: now.plus({ hours: 4 }).toJSDate(),
    aiResult: {
      extracted: { amount: 1400, currency: 'UAH', date: nextMonthDate,
        payerName: 'Padel Club', recipientIban: partnerIban, purpose: `К-${now.plus({ months: 1 }).year}-00100` },
      checks: { amountMatches: false, recipientMatches: true, ibanMatches: true, dateReasonable: true, purposeMentionsInvoice: true },
      rules: { amountOk: false, ibanOk: true, dateOk: true, purposeOk: true, flags: ['AMOUNT_MISMATCH'], verdict: 'MISMATCH' },
      verdict: 'MISMATCH', modelVerdict: 'PARTIAL', confidence: 0.85, notes: 'Сума не збігається', model: 'gemini-2.0-flash',
    },
    status: 'PENDING',
  });

  // PENDING + SKIPPED
  const pngSkipped = makePng(3);
  receiptsToCreate.push({
    clubId: padel.id, invoiceId: nextMonthInv.id, fileData: pngSkipped, mime: 'image/png', size: pngSkipped.length,
    sha256: crypto.createHash('sha256').update(pngSkipped).digest('hex'),
    uploadedAt: now.plus({ hours: 5 }).toJSDate(),
    aiStatus: 'SKIPPED', aiCheckedAt: null, aiResult: null,
    status: 'PENDING',
  });

  // CONFIRMED на старому PAID рахунку
  if (padelPaidInvs.length > 0) {
    const pngConfirmed = makePng(4);
    receiptsToCreate.push({
      clubId: padel.id, invoiceId: padelPaidInvs[0].id, fileData: pngConfirmed, mime: 'image/png', size: pngConfirmed.length,
      sha256: crypto.createHash('sha256').update(pngConfirmed).digest('hex'),
      uploadedAt: now.minus({ months: 1 }).plus({ hours: 1 }).toJSDate(),
      aiStatus: 'DONE', aiCheckedAt: now.minus({ months: 1 }).plus({ hours: 2 }).toJSDate(),
      aiResult: {
        extracted: { amount: 1500, currency: 'UAH', date: lastMonthDate,
          payerName: 'Padel Club', recipientIban: partnerIban, purpose: `К-2026-00001` },
        checks: { amountMatches: true, recipientMatches: true, ibanMatches: true, dateReasonable: true, purposeMentionsInvoice: true },
        rules: { amountOk: true, ibanOk: true, dateOk: true, purposeOk: true, flags: [], verdict: 'MATCH' },
        verdict: 'MATCH', modelVerdict: 'MATCH', confidence: 0.92, notes: 'Підтверджено', model: 'gemini-2.0-flash',
      },
      status: 'CONFIRMED', reviewedAt: now.minus({ months: 1 }).plus({ hours: 3 }).toJSDate(),
    });
  }

  // REJECTED на другому PAID рахунку
  if (padelPaidInvs.length > 1) {
    const pngRejected = makePng(5);
    receiptsToCreate.push({
      clubId: padel.id, invoiceId: padelPaidInvs[1].id, fileData: pngRejected, mime: 'image/png', size: pngRejected.length,
      sha256: crypto.createHash('sha256').update(pngRejected).digest('hex'),
      uploadedAt: now.minus({ months: 2 }).plus({ hours: 1 }).toJSDate(),
      aiStatus: 'DONE', aiCheckedAt: now.minus({ months: 2 }).plus({ hours: 2 }).toJSDate(),
      aiResult: {
        extracted: { amount: 1200, currency: 'UAH', date: twoMonthsAgoDate,
          payerName: 'Padel Club', recipientIban: partnerIban, purpose: `К-2026-00002` },
        checks: { amountMatches: false, recipientMatches: true, ibanMatches: true, dateReasonable: true, purposeMentionsInvoice: true },
        rules: { amountOk: false, ibanOk: true, dateOk: true, purposeOk: true, flags: ['AMOUNT_MISMATCH'], verdict: 'MISMATCH' },
        verdict: 'MISMATCH', modelVerdict: 'MISMATCH', confidence: 0.88, notes: 'Сума не збігається',  model: 'gemini-2.0-flash',
      },
      status: 'REJECTED', reviewedAt: now.minus({ months: 2 }).plus({ hours: 3 }).toJSDate(), rejectReason: 'Сума не збігається (демо)',
    });
  }

  await prisma.paymentReceipt.createMany({ data: receiptsToCreate });

  await prisma.partnerPayout.createMany({
    data: [
      { partnerId: partner.id, amount: 500000, paidAt: now.minus({ months: 6 }).toJSDate(), note: 'Виплата за I півріччя (демо)' },
      { partnerId: partner.id, amount: 300000, paidAt: now.minus({ months: 1 }).toJSDate(), note: 'Виплата (демо)' },
    ],
  });
  // ── Квартальні акти: оплачений за позаминулий квартал і виданий за минулий ──
  const quarterKey = (dt) => `${dt.year}-Q${dt.quarter}`;
  const lastQuarter = quarterKey(now.minus({ quarters: 1 }));
  const pastQuarter = quarterKey(now.minus({ quarters: 2 }));
  for (const [quarter, finalize] of [[pastQuarter, true], [lastQuarter, false]]) {
    const gen = await generateActs({ quarter, partnerId: partner.id, now: now.toJSDate() }, prisma);
    if ('error' in gen) throw new Error(`Акт ${quarter}: ${gen.error}`);
    const act = gen.created[0];
    if (!act) throw new Error(`Акт ${quarter} не створено: ${JSON.stringify(gen.skipped)}`);
    const steps = finalize ? ['issue', 'sign', 'pay'] : ['issue'];
    for (const step of steps) {
      const r = await transitionAct(prisma, act.id, step, { now: now.toJSDate(), paidAt: now.minus({ days: 5 }).toJSDate() });
      if ('error' in r) throw new Error(`Акт ${act.number}: ${step} → ${r.error}`);
    }
  }

  await prisma.lead.create({
    data: {
      name: 'Padel Odesa (ДЕМО, відкриття)', city: 'Одеса', phone: '+380000000091', contactName: 'Ірина (демо)',
      courtsCount: 4, source: 'partner', partnerId: partner.id, note: 'Планована дата відкриття: через 2 місяці',
    },
  });

  // Додаємо shareStatsWithPartner для клубів
  await prisma.club.update({
    where: { id: club.id },
    data: { shareStatsWithPartner: true, shareStatsChangedAt: now.toJSDate() },
  });
  await prisma.club.update({
    where: { id: padel.id },
    data: { shareStatsWithPartner: false },
  });

  // Додаємо ServiceRequest для партнера
  const squashCourts = await prisma.court.findMany({ where: { clubId: club.id }, take: 1 });
  const padelCourts = await prisma.court.findMany({ where: { clubId: padel.id }, take: 1 });

  if (squashCourts.length > 0) {
    await prisma.serviceRequest.create({
      data: {
        clubId: club.id, partnerId: partner.id, courtId: squashCourts[0].id,
        kind: 'surface', message: 'Демо-запит: потребує перегляду покриття корту',
        status: 'NEW',
      },
    });
  }

  if (padelCourts.length > 0) {
    await prisma.serviceRequest.create({
      data: {
        clubId: padel.id, partnerId: partner.id, courtId: padelCourts[0].id,
        kind: 'nets', message: 'Демо-запит: потребує заміни сіток на кортах',
        status: 'IN_PROGRESS', partnerNote: 'Планується демонтаж старих сіток та встановлення нових на цьому тижні',
      },
    });
  }

  // Додаємо 2 ліди партнера для лійки: DEMO і PROPOSAL
  await prisma.lead.create({
    data: {
      name: 'Tennis Academy Kharkiv (ДЕМО)', city: 'Харків', phone: '+380000000092', contactName: 'Максим (демо)',
      courtsCount: 5, source: 'partner', partnerId: partner.id, stage: 'DEMO',
      note: 'Демо призначено на 15 жовтня, планується показ обладнання та можливостей',
    },
  });

  await prisma.lead.create({
    data: {
      name: 'Squash Club Lviv (ДЕМО)', city: 'Львів', phone: '+380000000093', contactName: 'Роман (демо)',
      courtsCount: 3, source: 'partner', partnerId: partner.id, stage: 'PROPOSAL',
      note: 'Надіслано комерційну пропозицію, чекаємо на рішення',
    },
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
console.log(`  ${'OPERATOR'.padEnd(10)} ${OPERATOR_EMAIL}   → /platform`);
console.log(`  ${'PARTNER'.padEnd(10)} ${PARTNER_EMAIL}    → /partner`);
console.log('Партнерські документи:', JSON.stringify({
  sellers: await prisma.sellerProfile.count(),
  invoicesWithSeller: await prisma.clubInvoice.count({ where: { sellerId: { not: null } } }),
  acts: (await prisma.partnerAct.findMany({ select: { number: true, status: true, amount: true }, orderBy: { number: 'asc' } })),
}));
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
    PLATFORM_ADMIN_EMAIL: OPERATOR_EMAIL,
    // Платформений вхід перевіряє чистим bcrypt (routes/platform.ts), без sha256-префікса.
    PLATFORM_ADMIN_PASSWORD_HASH: await (await import('bcryptjs')).default.hash(DEMO_PASSWORD, 10),
    PUBLIC_WEB_URL: 'http://localhost:5175',
  };
  console.log(`\nСтартую API на http://localhost:${API_PORT} (ізольована база). Ctrl+C — зупинити.\n`);
  const child = spawn('npx tsx watch src/index.ts', { env, cwd: ROOT, stdio: 'inherit', shell: true });
  const stop = () => { child.kill(); shutdown(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => shutdown(code ?? 0));
}
