/**
 * Повне скидання ДЕМО-СТЕНДУ (ПЛАН-ДЕМО-СТЕНД.md, D1). Запускає Render Cron `kort-demo-reset`
 * щоночі; вручну — кнопкою «Trigger Run» у Render.
 *
 *   node dist-scripts/scripts/demo-stand-reset.js [--dry-run]     (у Docker-образі)
 *   npx tsx scripts/demo-stand-reset.ts --dry-run                  (локально, лише план)
 *
 * Кроки (усі на демо-базі!):
 *   1. DROP SCHEMA public CASCADE; CREATE SCHEMA public;   (DIRECT_URL, якщо задано)
 *   2. prisma migrate deploy                                (локальний бінарник)
 *   3. плани base/team/pro                                  (initPlans зі scripts/plans-init.ts)
 *   4. федерація squash-demo «Федерація сквошу · ДЕМО», SQUASH
 *   5. демо-світ: клуби, гравці, турніри, акаунт federation@demo.test (runDemoWorld зі scripts/demo-online.ts)
 *
 * ВАРТОВИЙ (src/lib/demoStandGuard.ts): без DEMO_STAND=true І DEMO_RESET_CONFIRM, що дорівнює
 * назві бази з DATABASE_URL, скрипт завершується з кодом 1 ДО будь-якого підключення до БД.
 *
 * .env цей скрипт НЕ підвантажує навмисно: змінні мають прийти з оточення (Render) або бути
 * задані вручну в терміналі — так локальний .env з прод-адресою не підхопиться випадково.
 * --dry-run: лише друкує план і результат вартового, БД не чіпає.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { checkDemoStandGuard, type DemoStandGuardResult } from '../src/lib/demoStandGuard';
import { initPlans } from './plans-init';
import { runDemoWorld } from './demo-online';

const FED_CODE = 'squash-demo';
const FED_NAME = 'Федерація сквошу · ДЕМО';

const PLAN_STEPS = [
  '1. DROP SCHEMA public CASCADE; CREATE SCHEMA public;  (на DIRECT_URL, якщо задано, інакше DATABASE_URL)',
  '2. prisma migrate deploy',
  '3. плани обслуговування base / team / pro',
  `4. федерація ${FED_CODE} «${FED_NAME}» (SQUASH)`,
  '5. демо-світ (3 клуби, гравці, турніри, акаунти @demo.test, federation@demo.test) — scripts/demo-online.ts',
];

function printPlan(guard: DemoStandGuardResult) {
  console.log('План скидання демо-стенду:');
  for (const s of PLAN_STEPS) console.log(`  ${s}`);
  if (guard.ok) console.log(`\nВартовий: ОК — база "${guard.dbName}" @ ${guard.host}.`);
  else console.log(`\nВартовий: ВІДМОВА — ${guard.reason}`);
}

function migrateDeploy(url: string) {
  const bin = path.resolve(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma');
  // DIRECT_URL для міграцій обов'язковий у schema.prisma (directUrl); якщо його не задано, дублюємо DATABASE_URL.
  const env = { ...process.env, DIRECT_URL: process.env.DIRECT_URL || url };
  const r = spawnSync(bin, ['migrate', 'deploy'], { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`prisma migrate deploy завершився з кодом ${r.status ?? r.signal}`);
}

async function main() {
  const args = process.argv.slice(2);
  for (const a of args) {
    if (a !== '--dry-run') { console.error(`Невідомий прапорець ${a}. Допустимо лише --dry-run.`); process.exit(2); }
  }
  const dryRun = args.includes('--dry-run');
  const guard = checkDemoStandGuard(process.env);

  if (dryRun) {
    console.log('Режим: DRY-RUN (до БД не підключаюсь)\n');
    printPlan(guard);
    process.exit(guard.ok ? 0 : 1);
  }
  if (!guard.ok) {
    console.error(`ВІДМОВА: ${guard.reason}\nСкидання потребує DEMO_STAND=true і DEMO_RESET_CONFIRM=<назва демо-бази>.`);
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL as string;
  const directUrl = process.env.DIRECT_URL || dbUrl;
  console.log(`Скидання демо-стенду: база "${guard.dbName}" @ ${guard.host}\n`);

  // 1. Чиста схема. Один клієнт на прямому з'єднанні (PgBouncer не любить довгих операцій).
  console.log('[1/5] DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const raw = new PrismaClient({ datasources: { db: { url: directUrl } } });
  try {
    await raw.$executeRawUnsafe('DROP SCHEMA public CASCADE');
    await raw.$executeRawUnsafe('CREATE SCHEMA public');
  } finally {
    await raw.$disconnect();
  }

  // 2. Міграції (окремий процес).
  console.log('\n[2/5] prisma migrate deploy');
  migrateDeploy(directUrl);

  // 3-5. Дані. Новий клієнт — після міграцій, тож метадані схеми свіжі.
  const prisma = new PrismaClient({ datasources: { db: { url: directUrl } } });
  try {
    console.log('\n[3/5] Плани');
    await initPlans(prisma);

    console.log('\n[4/5] Федерація');
    const fed = await prisma.federation.upsert({
      where: { code: FED_CODE }, create: { name: FED_NAME, code: FED_CODE, sport: 'SQUASH' }, update: {},
    });
    console.log(`  федерація ${fed.code} (${fed.id})`);

    console.log('\n[5/5] Демо-світ');
    process.exitCode = 0;
    const report = await runDemoWorld(prisma);
    if (!report || process.exitCode) throw new Error('Сід демо-світу не виконано (див. повідомлення вище)');
  } finally {
    await prisma.$disconnect();
  }
  console.log('\nГОТОВО: демо-стенд скинуто.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
