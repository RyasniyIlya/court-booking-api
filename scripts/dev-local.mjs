/**
 * Локальний запуск API без побічних ефектів на проді.
 *
 * Навіщо. `npm run dev` з .env — це бот, що конкурує з Render за вебхук,
 * дайджести справжнім клубам о 21:00 і витрата ліміту Gemini. Тут ці
 * змінні задаються порожніми в оточенні процесу ДО старту: dotenv і
 * Prisma CLI не перезаписують уже задані змінні, тому значення з .env
 * сюди не доїдуть.
 *
 * База — з .env (онлайн). Прапорець --docker перемикає на Postgres з
 * docker-compose (`docker compose up -d db`).
 *
 * Запуск:
 *   node scripts/dev-local.mjs                         (API: tsx watch src/index.ts)
 *   node scripts/dev-local.mjs --docker                (те саме, локальна база)
 *   node scripts/dev-local.mjs --docker npx prisma migrate deploy
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LOCAL_DB = 'postgresql://postgres:postgres@localhost:5432/courts';

const argv = process.argv.slice(2);
const docker = argv[0] === '--docker';
if (docker) argv.shift();

const env = {
  ...process.env,
  PUBLIC_API_URL: 'http://localhost:3000',
  PORT: '3000',
  // Порожньо — бот не стартує, вебхук на Render не чіпається,
  // сповіщення й дайджести не шлються.
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_BOT_USERNAME: '',
  TELEGRAM_WEBHOOK_URL: '',
  TELEGRAM_WEBHOOK_SECRET: '',
  // Порожньо — ШІ вимкнений, запити до Gemini не йдуть.
  GEMINI_API_KEY: '',
  // Фонові задачі (протермінування броней, нагадування, дайджест) на
  // онлайн-базі — справа Render, локальний процес їх не дублює.
  BACKGROUND_JOBS: 'off',
  ...(docker && {
    DATABASE_URL: LOCAL_DB,
    DIRECT_URL: LOCAL_DB,
    JWT_SECRET: 'local-dev-secret-not-for-prod-0123456789',
    PAYMENTS_SECRET: 'local-dev-payments-secret-0123456789',
  }),
};

const [cmd, ...args] = argv.length ? argv : ['npx', 'tsx', 'watch', 'src/index.ts'];

// Корінь court-booking-api — щоб скрипт працював і з кореня монорепо.
const cwd = fileURLToPath(new URL('..', import.meta.url));
// Один рядок, а не (cmd, args): на Windows npx — це .cmd, його запускає лише
// shell, а shell з масивом аргументів Node 24 позначає як DEP0190.
const child = spawn([cmd, ...args].join(' '), { env, cwd, stdio: 'inherit', shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
