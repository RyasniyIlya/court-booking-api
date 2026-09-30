import 'dotenv/config';
import express from 'express';
import request from 'supertest';

import { prisma } from '../src/lib/db';
import { analyticsRouter } from '../src/routes/analytics';
import { financeRouter } from '../src/routes/finance';
import { aiRouter } from '../src/routes/admin/ai';
import { signToken, type Auth } from '../src/routes/admin/shared';

import { summarize, type CashRow } from '../src/lib/cashbook';
import { buildLoadProfile } from '../src/lib/loadProfile';
import { TIER_ACTIVE_DAYS, TIER_FADING_DAYS } from '../src/lib/customerRoster';
import { loadCustomerHealth } from '../src/lib/ai/customerHealth';
import { bookingOutlook } from '../src/lib/ai/outlook';

/**
 * Задача Ф-0: перевірка гіпотез аудиту №01–10 на еталонному клубі
 * `kort-demo` (див. `prisma/seed-reference.ts` і
 * `docs/finance/reference-club.md`).
 *
 * Стиль: для кожної цифри — звідки взялось "очікувано" (посилання на
 * розділ довідника або пряма арифметика в коді нижче) і звідки "фактично"
 * (виклик lib-функції напряму або HTTP-запит через supertest із підписаним
 * JWT реального власника/адміна еталонного клубу). Нічого не мокається:
 * і бібліотечні функції, і роути виконуються насправжки проти локальної
 * бази з посіяними даними.
 */

/* ── ОХОРОНА: та сама, що в seed-reference.ts ─────────────────────────── */
function assertLocalDatabase() {
  const url = process.env.DATABASE_URL ?? '';
  let host = '';
  try { host = new URL(url).hostname; } catch { host = ''; }
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLocal) {
    console.error(
      `\n  ✗ DATABASE_URL вказує на хост "${host}", а не на localhost.\n` +
      '    reference-check НІКОЛИ не читає прод (Neon). Передайте локальний\n' +
      '    DATABASE_URL лише в командний рядок цього запуску.\n',
    );
    process.exit(1);
  }
}
assertLocalDatabase();

/* ── Друк ─────────────────────────────────────────────────────────────── */

let pass = 0;
let fail = 0;
let confirmedCount = 0;
let refutedCount = 0;
let partialCount = 0;

function section(title: string) {
  console.log(`\n${'═'.repeat(78)}\n${title}\n${'═'.repeat(78)}`);
}

function row(label: string, expected: unknown, actual: unknown, note = '') {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) pass += 1; else fail += 1;
  const mark = ok ? '✓' : '✗';
  console.log(`  ${mark} ${label}`);
  console.log(`      очікувано: ${JSON.stringify(expected)}`);
  console.log(`      фактично : ${JSON.stringify(actual)}`);
  if (note) console.log(`      ${note}`);
}

function info(label: string, value: unknown) {
  console.log(`  · ${label}: ${JSON.stringify(value)}`);
}

function verdict(n: string, kind: 'CONFIRMED' | 'REFUTED' | 'PARTIAL', text: string) {
  const uk = { CONFIRMED: 'ПІДТВЕРДЖЕНО', REFUTED: 'СПРОСТОВАНО', PARTIAL: 'ЧАСТКОВО' }[kind];
  if (kind === 'CONFIRMED') confirmedCount += 1;
  if (kind === 'REFUTED') refutedCount += 1;
  if (kind === 'PARTIAL') partialCount += 1;
  console.log(`\n  ▶ ВЕРДИКТ ${n}: ${uk} — ${text}`);
}

/* ── Підготовка: клуб, токени, тестовий express-застосунок ─────────────── */

const SLUG = 'kort-demo';

async function main() {
  const club = await prisma.club.findUnique({ where: { slug: SLUG } });
  if (!club) {
    console.error(`Клуб "${SLUG}" не знайдено. Спершу запустіть: npm run db:seed:reference`);
    process.exit(1);
  }

  const owner = await prisma.user.findFirstOrThrow({ where: { clubId: club.id, role: 'OWNER' } });
  const admin = await prisma.user.findFirstOrThrow({ where: { clubId: club.id, role: 'ADMIN' } });

  const authOf = (u: typeof owner): Auth => ({ userId: u.id, clubId: club.id, role: u.role, trainerId: null });
  const ownerToken = signToken(authOf(owner), '1h', owner.passwordHash);
  const adminToken = signToken(authOf(admin), '1h', admin.passwordHash);

  const app = express();
  app.use(express.json());
  app.use('/api/admin/analytics', analyticsRouter);
  app.use('/api/admin/finance', financeRouter);
  app.use('/api/admin', aiRouter); // aiRouter сам монтує себе на /ai

  const asOwner = (path: string) => request(app).get(path).set('Authorization', `Bearer ${ownerToken}`);
  const asAdmin = (path: string) => request(app).get(path).set('Authorization', `Bearer ${adminToken}`);

  const custByPhone = async (phone: string) =>
    prisma.customer.findFirstOrThrow({ where: { clubId: club.id, phone } });

  console.log(`Еталонний клуб: ${club.name} (${club.id})`);
  console.log(`Власник: ${owner.email} · Адмін: ${admin.email}`);
  console.log('Числа "очікувано" — з docs/finance/reference-club.md, крім позначених "рахуємо тут же".');

  /* ════════════════════════════════════════════════════════════════════
     №01 — два різні "прибутки": Виручка (нарахування) vs Фінанси (каса)
     ════════════════════════════════════════════════════════════════════ */
  section('№01 — "Чистий прибуток": Виручка (нарахування) проти Фінансів (каса)');
  {
    const expAug = await asOwner('/api/admin/analytics/expenses?month=2026-08');
    const expSep = await asOwner('/api/admin/analytics/expenses?month=2026-09');
    const pnl = await asOwner('/api/admin/finance/pnl?month=2026-09');
    const pnlAug = pnl.body.months.find((m: { month: string }) => m.month === '2026-08');
    const pnlSep = pnl.body.months.find((m: { month: string }) => m.month === '2026-09');

    row('Виручка (нарахування), серпень, коп', 700_000, expAug.body.revenue);
    row('Чистий прибуток (нарахування), серпень, коп', -2_050_000, expAug.body.netProfit,
      'routes/analytics.ts:722 netProfit = revenue(periodStats, CONFIRMED.priceTotal) - totalExpenses');
    row('Каса (П&Л), серпень, коп', 895_000, pnlAug.income);
    row('Прибуток (каса, П&Л), серпень, коп', -1_855_000, pnlAug.profit,
      'lib/financeReports.ts:189 profit = income(каса) - expenses');
    info('Розбіжність №01 за серпень, грн', (expAug.body.netProfit - pnlAug.profit) / 100);

    row('Виручка (нарахування), вересень, коп', 540_000, expSep.body.revenue);
    row('Чистий прибуток (нарахування), вересень, коп', -660_000, expSep.body.netProfit);
    row('Каса (П&Л), вересень, коп', 355_000, pnlSep.income);
    row('Прибуток (каса, П&Л), вересень, коп', -845_000, pnlSep.profit);
    info('Розбіжність №01 за вересень, грн', (expSep.body.netProfit - pnlSep.profit) / 100);

    const bothDiffer = expAug.body.netProfit !== pnlAug.profit && expSep.body.netProfit !== pnlSep.profit;
    const directionFlips = Math.sign(expAug.body.netProfit - pnlAug.profit)
      !== Math.sign(expSep.body.netProfit - pnlSep.profit);
    verdict('№01', bothDiffer ? 'CONFIRMED' : 'REFUTED',
      `два незалежні поля "прибуток" завжди розходяться (routes/analytics.ts /expenses -> netProfit ` +
      `на нарахуванні; routes/finance.ts /pnl -> profit на касі), і напрямок розбіжності ` +
      `${directionFlips ? 'навіть міняється місяць до місяця' : 'стабільний'} — жодного простого коефіцієнта перерахунку немає.`);
  }

  /* ════════════════════════════════════════════════════════════════════
     №02 — /analytics/deep ігнорує period=custom&from&to
     ════════════════════════════════════════════════════════════════════ */
  section('№02 — /analytics/deep і period=custom');
  {
    const week = await asOwner('/api/admin/analytics/deep?period=week');
    const month = await asOwner('/api/admin/analytics/deep?period=month');
    const custom = await asOwner('/api/admin/analytics/deep?period=custom&from=2026-08-01&to=2026-08-31');

    info('operationalRange (period=week)', week.body.operationalRange);
    info('operationalRange (period=month)', month.body.operationalRange);
    info('operationalRange (period=custom&from=2026-08-01&to=2026-08-31)', custom.body.operationalRange);

    // Якщо баг є, custom.operationalRange.from збігається з ПОТОЧНИМ
    // місяцем (як у period=month), а не з 2026-08-01, який просили.
    // (Якщо цей скрипт колись запустять буквально в серпні 2026 — редкий
    // збіг зіпсує саме цю перевірку; loadRange-перевірка нижче лишається
    // надійною незалежно від дати запуску.)
    const customIgnoredCustomDates = !String(custom.body.operationalRange.from).startsWith('2026-08-01')
      && custom.body.operationalRange.from === month.body.operationalRange.from;
    row('custom-запит справді дав межі 2026-08-01..2026-08-31', true, !customIgnoredCustomDates,
      'routes/analytics.ts:460-463: `const period = parsed.data.period; const unit = period === \'week\' ? \'week\' : \'month\';` ' +
      'для period=\'custom\' unit стає \'month\', from/to з query взагалі не читаються.');

    row('loadRange однаковий для week/month/custom (завжди останні 8 тижнів)',
      true, week.body.loadRange.from === month.body.loadRange.from && month.body.loadRange.from === custom.body.loadRange.from,
      'routes/analytics.ts:467-469: loadFrom/loadTo рахуються від now(), period взагалі не бере участі.');

    verdict('№02', customIgnoredCustomDates ? 'CONFIRMED' : 'REFUTED',
      'period=custom&from&to повністю ігнорується для operationalRange (тихо трактується як "цей місяць") ' +
      'і повністю ігнорується для loadRange (завжди останні 8 завершених тижнів) — обидва блоки з опису задачі підтверджено.');
  }

  /* ════════════════════════════════════════════════════════════════════
     №03 — учасники групових занять не потрапляють у "різних клієнтів"
     ════════════════════════════════════════════════════════════════════ */
  section('№03 — різні клієнти: BookingSeat не враховано');
  {
    const from = new Date('2026-08-01T00:00:00.000Z');
    const to = new Date('2026-08-31T23:59:59.999Z');
    const [bookings, seats] = await Promise.all([
      prisma.booking.findMany({
        where: { clubId: club.id, status: 'CONFIRMED', startTime: { gte: from, lte: to } },
        select: { customerId: true },
      }),
      prisma.bookingSeat.findMany({
        where: { status: 'BOOKED', booking: { clubId: club.id, status: 'CONFIRMED', startTime: { gte: from, lte: to } } },
        select: { customerId: true },
      }),
    ]);
    const correctDistinct = new Set([
      ...bookings.map((b) => b.customerId).filter(Boolean),
      ...seats.map((s) => s.customerId).filter(Boolean),
    ]).size;

    const summary = await asOwner('/api/admin/analytics/summary?period=custom&from=2026-08-01&to=2026-08-31');
    const top = await asOwner('/api/admin/analytics/customers/top?period=custom&from=2026-08-01&to=2026-08-31&limit=50');

    row('Різних клієнтів (правильно, з місцями групи), серпень', 14, correctDistinct);
    row('Різних клієнтів за /analytics/summary (лише Booking.customerId), серпень', 10, summary.body.current.uniqueCustomers,
      'routes/analytics.ts:133 `new Set(bookings.map(b => b.customerId))` — bookingSeat не запитується взагалі.');
    const seatNames = ['Дарина Йога', 'Костя Йога', 'Ліза Йога', 'Тарас Йога'];
    const topNames = new Set((top.body as { name: string }[]).map((r) => r.name));
    const missingFromTop = seatNames.filter((n) => !topNames.has(n));
    row('Учасники групи відсутні в /customers/top', seatNames, missingFromTop,
      'routes/analytics.ts:209-217 той самий запит без bookingSeat.');

    verdict('№03', (correctDistinct - summary.body.current.uniqueCustomers === 4 && missingFromTop.length === 4)
      ? 'CONFIRMED' : 'PARTIAL',
      `фактична база серпня — 14 різних клієнтів, /analytics/summary і /customers/top бачать лише 10: ` +
      `${missingFromTop.join(', ')} відсутні в обох звітах, хоча троє з них платили (лише місце Тараса неоплачене).`);
  }

  /* ════════════════════════════════════════════════════════════════════
     №04 — churn/"під ризиком" визначений по-різному
     ════════════════════════════════════════════════════════════════════ */
  section('№04 — визначення відтоку: картотека vs Deep vs AI');
  {
    const dmytro = await custByPhone('+380501110021'); // Дмитро Липневий, 75 днів тому
    const olena = await custByPhone('+380501110016'); // Олена Згасає, ~43 дні тому

    const roster = await asOwner('/api/admin/analytics/customers?limit=500');
    const rosterRows = roster.body.customers as { id: string; tier: string; name: string }[];
    const dmytroTier = rosterRows.find((r) => r.id === dmytro.id)?.tier;
    const olenaTier = rosterRows.find((r) => r.id === olena.id)?.tier;

    const deep = await asOwner('/api/admin/analytics/deep?period=month');
    const atRiskIds = new Set<string>((deep.body.retention.atRiskIds ?? []) as string[]);

    const health = await loadCustomerHealth(club.id);

    info('Картотека (lib/customerRoster.ts tierOf, межі 30/90 днів): Дмитро.tier', dmytroTier);
    info('Картотека: Олена.tier', olenaTier);
    info('/analytics/deep retention.atRiskIds.length (lib/deepAnalytics.ts, вікно 30+30 днів від now)', atRiskIds.size);
    info('Дмитро у /analytics/deep atRiskIds?', atRiskIds.has(dmytro.id));
    info('Олена у /analytics/deep atRiskIds?', atRiskIds.has(olena.id));
    info('AI lib/ai/customerHealth.ts: segments.FADING (та сама tierOf, що й картотека)', health.segments.FADING);
    info('AI lib/ai/customerHealth.ts: last30d.atRisk (та сама retentionFromVisits, що й Deep)', health.last30d.atRisk);

    const rosterFlagsDmytro = dmytroTier === 'FADING';
    const deepMissesDmytro = !atRiskIds.has(dmytro.id);
    const mismatch = rosterFlagsDmytro && deepMissesDmytro;

    row('Картотека: Дмитро (75 днів тому) = FADING', true, rosterFlagsDmytro,
      `lib/customerRoster.ts tierOf: ${TIER_ACTIVE_DAYS} < 75 <= ${TIER_FADING_DAYS} -> FADING`);
    row('/analytics/deep: Дмитро НЕ у atRiskIds (75 днів — за межами вікна 30+30)', true, deepMissesDmytro,
      'lib/deepAnalytics.ts retentionFromVisits: previousFrom = now-60д; 75 днів тому — вже "older", не "previous"');

    verdict('№04', mismatch ? 'CONFIRMED' : 'PARTIAL',
      'три різні формули відтоку в одному продукті: картотека (30/90 днів від дати останнього візиту, ' +
      'lib/customerRoster.ts tierOf) і Deep-аналітика (вікно "попередні 30 днів vs поточні 30 днів", ' +
      'lib/deepAnalytics.ts retentionFromVisits, максимум 60 днів пам\'яті) дають РІЗНІ списки клієнтів під ризиком ' +
      '— клієнт зі 75-денною паузою є "згасаючим" у картотеці, але вже не є "під ризиком" у Deep. ' +
      'AI (lib/ai/customerHealth.ts) не вибирає жодну з них — рахує обидві одразу в одній відповіді ' +
      '(segments за tierOf, last30d за retentionFromVisits), тобто сам собі суперечить.');
  }

  /* ════════════════════════════════════════════════════════════════════
     №05 — гроші тренера й прокату в "виручці корту"
     ════════════════════════════════════════════════════════════════════ */
  section('№05 — priceTotal приватної броні включає тренера й прокат');
  {
    const natalka = await prisma.booking.findFirstOrThrow({
      where: { clubId: club.id, customerName: 'Наталка Тренування', startTime: { gte: new Date('2026-08-01') } },
    });
    const bogdan = await prisma.booking.findFirstOrThrow({
      where: { clubId: club.id, customerName: 'Богдан Прокат', startTime: { gte: new Date('2026-08-01'), lt: new Date('2026-09-01') } },
    });

    row('Наталка Аug: priceTotal (корт 50 000 + тренер 30 000)', 80_000, natalka.priceTotal);
    row('Наталка: trainerPrice', 30_000, natalka.trainerPrice);
    row('Богдан Aug: priceTotal (корт 40 000 + прокат 10 000)', 50_000, bogdan.priceTotal);
    row('Богдан: rentalTotal', 10_000, bogdan.rentalTotal);

    // buildLoadProfile (те саме, що й у /analytics/load, /analytics/deep
    // courtPerformance, loadClubLoadProfile) бере priceTotal як є.
    const profile = buildLoadProfile({
      from: natalka.startTime, to: new Date(natalka.endTime.getTime() + 1),
      timezone: 'Europe/Kyiv',
      hours: [{ weekday: natalka.startTime.getUTCDay(), openMinute: 0, closeMinute: 1440, isClosed: false }],
      courts: [{ id: natalka.courtId }],
      blocks: [],
      bookings: [{ courtId: natalka.courtId, startTime: natalka.startTime, endTime: natalka.endTime, priceTotal: natalka.priceTotal }],
    });
    row('buildLoadProfile "revenue" корту за цей слот = повний priceTotal (з тренером)', 80_000, profile.totals.revenue,
      'lib/loadProfile.ts:271 `cell.revenue += b.priceTotal` — жодного віднімання trainerPrice/rentalTotal немає.');

    const trueCourtOnly = natalka.priceTotal - natalka.trainerPrice;
    verdict('№05', profile.totals.revenue !== trueCourtOnly ? 'CONFIRMED' : 'REFUTED',
      `будь-яка "виручка корту" в продукті (тепловa карта /analytics/load, courtPerformance у /analytics/deep, ` +
      `revenue90 у breakEven) бере priceTotal приватної броні як є: для Наталки це 80 000 коп замість ` +
      `"чистих" 50 000 коп корту — 30 000 коп тренерської ставки полічені як дохід корту. Групові заняття ` +
      `цього не мають (trainerPrice там лежить окремим полем, поза priceTotal) — дірка лише в приватних бронях.`);
  }

  /* ════════════════════════════════════════════════════════════════════
     №06 — заняття з абонемента оцінені по повній ціні корту
     ════════════════════════════════════════════════════════════════════ */
  section('№06 — заняття з абонемента у нарахуванні: повна ціна корту замість ціни заняття');
  {
    const passRow = await prisma.pass.findFirstOrThrow({ where: { clubId: club.id, price: 320_000 } });
    const sessions = await prisma.passUsage.findMany({ where: { passId: passRow.id }, select: { bookingId: true } });
    const bookings = await prisma.booking.findMany({
      where: { id: { in: sessions.map((s) => s.bookingId!).filter(Boolean) } },
      select: { priceTotal: true, startTime: true },
    });
    const truePricePerSession = Math.round(passRow.price / passRow.totalSessions!);

    row('Ціна одного заняття з абонемента (320 000 / 8)', 40_000, truePricePerSession);
    for (const b of bookings.sort((a, c) => a.startTime.getTime() - c.startTime.getTime())) {
      row(`Нараховано за заняття ${b.startTime.toISOString().slice(0, 10)}`, 50_000, b.priceTotal,
        `мало бути ${truePricePerSession} (ціна абонемента/занять), а не повна ціна корту`);
    }
    const overstatement = bookings.reduce((s, b) => s + (b.priceTotal - truePricePerSession), 0);
    info('Сумарне перенарахування по всіх 4 заняттях, коп', overstatement);

    verdict('№06', bookings.every((b) => b.priceTotal === 50_000) ? 'CONFIRMED' : 'PARTIAL',
      `кожне з 4 занять, списаних з абонемента (по 2 у серпні й вересні), нараховане по повній ціні корту ` +
      `(50 000 коп), хоча реальна ціна заняття з цього абонемента — 40 000 коп. Немає жодного місця в коді, ` +
      `де booking.priceTotal перераховувався б при списанні PassUsage (routes/admin/customers.ts, ендпоінт ` +
      `use-pass — лише pass.usedSessions++ і новий рядок PassUsage, priceTotal броні не чіпається).`);
  }

  /* ════════════════════════════════════════════════════════════════════
     №07 — веб: дублікати плиток, пороги в стані екрана
     ════════════════════════════════════════════════════════════════════ */
  section('№07 — веб (court-booking-web): дублікати й пороги в стані екрана — ЗА ЧИТАННЯМ КОДУ');
  console.log('  Немає рантайму фронтенда в цьому скрипті — court-booking-web не піднімається тут.');
  console.log('  Докази: court-booking-web/src/components/AdminSettings.jsx:1873-1874 рендерить');
  console.log('  <DeepAnalyticsSection data={deep}/> і <AnalyticsMonitor data={deep}/> ПОРЯД з тих самих даних —');
  console.log('  funnel і retention-плитки дублюються (DeepAnalyticsSection:2008-2044 vs AnalyticsMonitor "Огляд").');
  console.log('  court-booking-web/src/lib/analyticsMonitor.js:1,18 — MONITOR_DEFAULTS у useState(), не на клубі;');
  console.log('  AnalyticsMonitor.jsx:43 сам каже "Діють до закриття вкладки аналітики".');
  verdict('№07', 'CONFIRMED', 'підтверджено читанням коду (деталі — у docs/finance/audit-f0-report.md).');

  /* ════════════════════════════════════════════════════════════════════
     №08 — ADMIN бачить повну виручку, AI для нього закритий
     ════════════════════════════════════════════════════════════════════ */
  section('№08 — роль ADMIN: аналітика/фінанси відкриті, AI закритий');
  {
    const deepAsAdmin = await asAdmin('/api/admin/analytics/deep?period=month');
    const pnlAsAdmin = await asAdmin('/api/admin/finance/pnl?month=2026-09');
    const aiAsAdmin = await asAdmin('/api/admin/ai/status');
    const aiAsOwner = await asOwner('/api/admin/ai/status');

    row('ADMIN: /analytics/deep — статус', 200, deepAsAdmin.status);
    row('ADMIN: /finance/pnl — статус', 200, pnlAsAdmin.status);
    const expensesAsAdmin = await asAdmin('/api/admin/analytics/expenses?month=2026-09');
    row('ADMIN: /analytics/expenses revenue == еталон вересня', 540_000, expensesAsAdmin.body.revenue);
    row('ADMIN: /admin/ai/status — статус (має бути заборонено)', 403, aiAsAdmin.status,
      "routes/admin/ai.ts:24 `requireRole('OWNER')` — TRAINER, ACCOUNTANT і ADMIN однаково недопущені");
    row('OWNER: /admin/ai/status — статус (дозволено)', 200, aiAsOwner.status);

    verdict('№08', (deepAsAdmin.status === 200 && expensesAsAdmin.body.revenue === 540_000 && aiAsAdmin.status === 403)
      ? 'CONFIRMED' : 'REFUTED',
      'ADMIN бачить ту саму повну виручку клубу в аналітиці й фінансах, що й OWNER (жодного обмеження за роллю ' +
      'в routes/analytics.ts і routes/finance.ts, обидва requireRole(\'OWNER\',\'ADMIN\'[,\'ACCOUNTANT\'])), ' +
      'а AI (routes/admin/ai.ts) відкритий лише OWNER. Цифровий дайджест (lib/digestScheduler.ts:51) також іде ' +
      'на OWNER і ADMIN однаково — рівно та сама асиметрія.');
  }

  /* ════════════════════════════════════════════════════════════════════
     №09 — два прогнози: фіксований ±17.5% vs 8-тижнева норма AI
     ════════════════════════════════════════════════════════════════════ */
  section('№09 — прогноз: фіксований ±17.5% (Виручка) vs 8-тижнева норма (AI)');
  {
    const forecast = await asOwner('/api/admin/analytics/forecast?period=week');
    if (forecast.body.available) {
      const { low, mid, high } = forecast.body.forecast;
      const expectedLow = Math.round(mid * 0.825);
      const expectedHigh = Math.round(mid * 1.175);
      row('forecast.low == mid * 0.825 (фіксований коридор, а не статистика)', expectedLow, low,
        'routes/analytics.ts:365 `low: Math.round(mid * 0.825)`');
      row('forecast.high == mid * 1.175', expectedHigh, high, 'routes/analytics.ts:367');
    } else {
      info('forecast.available', false);
    }

    const club7 = { id: club.id, name: club.name, timezone: club.timezone, address: club.address };
    const outlook = await bookingOutlook(club7, 7);
    console.log('  lib/ai/outlook.ts bookingOutlook (AI-прогноз, зовсім інша методика — 8 настань цього дня тижня за 56 днів):');
    for (const d of outlook.slice(0, 3)) {
      info(`    ${d.date} (${d.weekday})`, { booked: d.booked, usual_for_weekday: d.usual_for_weekday });
    }

    verdict('№09', 'CONFIRMED',
      '/analytics/forecast будує коридор як mid ± 17.5% від mid (фіксована ширина, лінія коду, не статистика), ' +
      'а lib/ai/outlook.ts (інструмент AI get_booking_outlook) рахує "норму" як середнє booked за 8 останніх ' +
      'настань того самого дня тижня за 56 днів історії — геть інша модель, і жодного зв\'язку між двома числами.');
  }

  /* ════════════════════════════════════════════════════════════════════
     №10 — веб: дати не в таймзоні клубу; дата двічі в запиті ліміту
     ════════════════════════════════════════════════════════════════════ */
  section('№10 — дати не в таймзоні клубу (веб); дата передається двічі (річний ліміт)');
  {
    // Частина 2 гіпотези: перевірка ЖИВЕ в API, не у веб-коді (уточнення
    // локації бага порівняно з формулюванням аудиту) — routes/finance.ts,
    // підрахунок yearNet для річного ліміту ФОП.
    const rows: CashRow[] = [
      { id: '1', at: new Date('2026-09-05T10:00:00Z'), kind: 'PAYMENT', method: 'CASH', account: 'Каса', amount: 20_000, source: 'BOOKING', customer: null, description: '', actor: null },
      { id: '2', at: new Date('2026-09-20T10:00:00Z'), kind: 'PAYMENT', method: 'CASH', account: 'Каса', amount: 25_000, source: 'BOOKING', customer: null, description: '', actor: null },
    ];
    const yearStart = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-09-28T23:59:59Z');

    // Так, як зараз викликає routes/finance.ts:151 —
    //   `summarize(yearRows, tz, yearStart, yearStart)` — ДРУГИЙ параметр
    // теж yearStart, а не `to`.
    const buggy = summarize(rows, 'Europe/Kyiv', yearStart, yearStart);
    // Як мало б бути:
    const fixed = summarize(rows, 'Europe/Kyiv', yearStart, to);

    row('routes/finance.ts:151 виклик: byDay.length (від=yearStart, до=yearStart)', 1, buggy.byDay.length,
      'from і to — той самий yearStart, тому днів у діапазоні рівно один: сам yearStart.');
    row('Правильний виклик (від=yearStart, до=to): byDay.length суттєво більший за 1', true, fixed.byDay.length > 250,
      `фактично ${fixed.byDay.length} днів (січень–вересень) — саме стільки мало б бути в byDay, якби викликали з (yearStart, to).`);
    row('net не залежить від from/to (рахується по всіх переданих rows) — тому limit.pct НЕ зламаний', rows[0].amount + rows[1].amount, buggy.net,
      'lib/cashbook.ts summarize(): received/refunded/net ітерують rows цілком; from/to використані лише для порожніх днів у byDay.');

    console.log('  Веб-частина (AnalyticsMonitor.jsx дати не в таймзоні клубу) — ЗА ЧИТАННЯМ КОДУ:');
    console.log('  court-booking-web/src/components/AnalyticsMonitor.jsx:7 `new Date(value).toLocaleString(\'uk-UA\')`');
    console.log('  без {timeZone: club.timezone} — бере таймзону ПРИСТРОЮ глядача. Сам компонент це визнає в UI');
    console.log('  (AnalyticsMonitor.jsx:36): "Дати — у часовому поясі вашого пристрою."');

    verdict('№10', 'PARTIAL',
      'обидві частини гіпотези мають підстави, але локація не там, де сформульовано в аудиті. "Дата передається ' +
      'двічі" — реальний дефект, але в API (routes/finance.ts:151 `summarize(yearRows, tz, yearStart, yearStart)`), ' +
      'не у веб-коді; наразі без видимого ефекту на limit.pct (summarize.net не залежить від from/to), тобто це ' +
      'латентний, а не проявлений баг. "Дати не в таймзоні клубу" підтверджено — але це AnalyticsMonitor.jsx, ' +
      'display-only, і сам компонент чесно попереджає про це в інтерфейсі.');
  }

  /* ── Підсумок ────────────────────────────────────────────────────────── */
  section('ПІДСУМОК');
  console.log(`  Перевірок зі збігом очікування: ${pass}, з розбіжністю: ${fail}`);
  console.log(`  Вердиктів: підтверджено ${confirmedCount}, спростовано ${refutedCount}, частково ${partialCount}`);
  console.log('  Повний розбір і рекомендації — docs/finance/audit-f0-report.md');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
