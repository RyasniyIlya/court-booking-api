import 'dotenv/config';
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import cors from 'cors';
import compression from 'compression';
import { publicRouter } from './routes/public';
import { assistantRouter } from './routes/assistant';
import { adminRouter } from './routes/admin';
/* Виконавці ІІ-менеджера мають бути зареєстровані в проді, а не лише в тестах. */
import './lib/ai/executors';
import { analyticsRouter } from './routes/analytics';
import { exportRouter } from './routes/export';
import { financeRouter } from './routes/finance';
import { platformRouter } from './routes/platform';
import { platformCrmRouter } from './routes/platformCrm';
import { platformAnalyticsRouter } from './routes/platformAnalytics';
import { partnerRouter } from './routes/partner';
import { federationRouter, federationProvisionRouter, federationRawParser } from './routes/federation';
import { playerProfilesRouter, publicFederationRouter } from './routes/playerProfiles';
import { requireFederationAuth } from './lib/federationAuth';
import { requirePlatformAuth } from './lib/platformAuth';
import { payRouter } from './routes/pay';
import { demoRouter } from './routes/demo';
import { startExpirySweeper } from './lib/expire';
import { startBot, telegramWebhookSecret } from './lib/botRunner';
import { startDigestScheduler } from './lib/digestScheduler';
import { startMorningBriefScheduler } from './lib/morningBrief';
import { startReminderScheduler } from './lib/remind';
import { startPlayerScheduler } from './lib/playerRemind';
import { startWinbackScheduler } from './lib/winback';
import { startWinbackQueueScheduler } from './lib/ai/winbackCampaign';
import { startRetentionScheduler } from './lib/dataRetention';
import { handleUpdate } from './lib/botHandlers';
import { processTelegramUpdate } from './lib/telegramReceipt';
import { paymentsSecretReady } from './lib/crypto';
import { payGeneralLimiter, publicGeneralLimiter } from './lib/rateLimits';

const app = express();
// Content negotiation, Vary and streaming are handled by standard middleware.
// SSE-потік табло не стискаємо: gzip буферизує і гальмує пуші.
app.use(compression({ threshold: 1024, filter: (req, res) => !req.path.endsWith('/stream') && compression.filter(req, res) }));

// За Render/Vercel завжди один хоп реверс-проксі: без цього req.ip показує
// адресу проксі, а не клієнта, і express-rate-limit або лічить усіх одним
// IP, або сам відмовляється працювати, помітивши недовірений X-Forwarded-For.
app.set('trust proxy', 1);

// Не підказуємо стек сервера у кожній відповіді.
app.disable('x-powered-by');

// Базові заголовки безпеки. CSP 'none' годиться для JSON-API, але /api/pay
// віддає HTML-сторінки (демо-оплата, повернення з банку) — їм CSP не ставимо.
// Cross-Origin-Resource-Policy свідомо не чіпаємо: логотипи клубів вантажить
// віджет з чужих доменів.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  if (process.env.NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (!req.path.startsWith('/api/pay')) {
    res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
  // Персональні дані не мають осідати в спільних кешах. Це лише значення
  // за замовчуванням: маршрут, що ставить свій Cache-Control, перекриє його.
  if (req.path.startsWith('/api/admin') || req.path.startsWith('/api/platform') || req.path.startsWith('/api/partner') || req.path.startsWith('/api/federation') || req.path.startsWith('/api/demo')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

// Платіжка монтується ПЕРШОЮ і читає сире тіло: підпис вебхука рахується
// від байтів. Якщо тіло пройде через express.json(), підпис не збіжиться.
// Вебхуки банку ліміт не душить (див. payGeneralLimiter).
app.use('/api/pay', payGeneralLimiter, express.raw({ type: '*/*', limit: '100kb' }), payRouter);

// Імпорт лідів з реєстру — до 1000 рядків за раз (~1 МБ). Тільки цей шлях
// і тільки для оператора: загальні 100 КБ лишаються для всього іншого.
// Має стояти ПЕРЕД загальним парсером — той інакше відповість 413 першим.
// Токен перевіряється ДО читання тіла: 5 МБ без входу ніхто не надішле.
// OPTIONS пропускаємо: preflight токена не несе, а CORS підключено нижче.
app.use(
  '/api/platform/leads/import',
  (req, res, next) => (req.method === 'OPTIONS' ? next() : requirePlatformAuth(req, res, next)),
  express.json({ limit: '5mb' }),
);
app.use('/api/federation/import/preview', (req, res, next) => req.method === 'OPTIONS' ? next() : requireFederationAuth(req, res, next), federationRawParser[1]);
app.use('/api/federation/import', (req, res, next) => req.method === 'OPTIONS' ? next() : requireFederationAuth(req, res, next), express.json({ limit: '1mb' }));
app.use(express.json({ limit: '100kb' }));

// Віджет вантажиться на чужих доменах — публічне API відкрите для всіх
app.use('/api/public', cors({ origin: true }));
app.use('/api/public', publicGeneralLimiter);

/**
 * Кабінет живе на іншому домені (Vercel), а API на Render — без CORS
 * браузер не пустить жодного запиту. У розробці все йде через проксі Vite,
 * тому проблема вилазить тільки на проді.
 *
 * Список доменів у ADMIN_ORIGINS, кома як роздільник. Порожньо у production
 * означає «кабінет тільки з того самого домену».
 */
const adminOrigins = (process.env.ADMIN_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use('/api/admin', cors({
  origin(origin, cb) {
    // Запити без Origin — curl, мобільні клієнти, той самий домен
    if (!origin) return cb(null, true);
    if (adminOrigins.includes(origin.replace(/\/+$/, ''))) return cb(null, true);
    // Поза production не заважаємо собі жити
    if (process.env.NODE_ENV !== 'production') return cb(null, true);
    cb(null, false);
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Той самий origin-allowlist, що й кабінет клубу — платформна панель живе
// в тому самому фронтенді, просто за іншим шляхом і іншим входом.
app.use('/api/platform', cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (adminOrigins.includes(origin.replace(/\/+$/, ''))) return cb(null, true);
    if (process.env.NODE_ENV !== 'production') return cb(null, true);
    cb(null, false);
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Кабінет партнера (будівельники кортів) — той самий origin-allowlist.
app.use(['/api/partner', '/api/federation', '/api/demo'], cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (adminOrigins.includes(origin.replace(/\/+$/, ''))) return cb(null, true);
    if (process.env.NODE_ENV !== 'production') return cb(null, true);
    cb(null, false);
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/public', publicRouter);
app.use('/api/public', publicFederationRouter);
app.use('/api/public', assistantRouter);
app.use('/api/admin/finance', financeRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin', playerProfilesRouter);
app.use('/api/admin/analytics', analyticsRouter);
/* Вивантаження бази клубу — окремо від analyticsRouter і без
   requireFeature('analytics'): дані клубу (броні, клієнти) належать
   власнику на будь-якому тарифі, див. коментар у routes/export.ts. */
app.use('/api/admin/export', exportRouter);
app.use('/api/platform', platformRouter);
app.use('/api/platform', federationProvisionRouter);
app.use('/api/platform', platformCrmRouter);
app.use('/api/platform', platformAnalyticsRouter);
app.use('/api/partner', partnerRouter);
app.use('/api/federation', federationRouter);
app.use('/api/demo', demoRouter);

/**
 * Вебхук Telegram. Це єдиний шлях для вхідних команд: фоновий polling
 * вимкнений, щоб бот не створював постійний мережевий трафік.
 *
 * Секрет перевіряємо заголовком, який Telegram шле сам, — адреса вебхука
 * рано чи пізно потрапляє в логи проксі, і одного знання URL має бути
 * замало, щоб слати боту чужі оновлення.
 *
 * 200 лише після обробки. Повтори відсікаються за update_id у базі;
 * незавершена обробка отримує 503, щоб Telegram повторив доставку.
 * Текст повідомлення та пароль у журналі доставок не зберігаються.
 */
app.post('/api/telegram/webhook', async (req, res) => {
  const secret = telegramWebhookSecret();

  const sent = req.get('X-Telegram-Bot-Api-Secret-Token');
  // Порівняння за сталий час; різна довжина — одразу відмова (timingSafeEqual кидає).
  const secretOk = Boolean(secret && sent) &&
    Buffer.byteLength(sent!) === Buffer.byteLength(secret!) &&
    timingSafeEqual(Buffer.from(sent!), Buffer.from(secret!));
  if (!secretOk) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  if (!Number.isSafeInteger(req.body?.update_id) || req.body.update_id < 0 || req.body.update_id > 2147483647) {
    return res.status(400).json({ error: 'BAD_UPDATE' });
  }
  try {
    await processTelegramUpdate(req.body, handleUpdate);
    return res.json({ ok: true });
  } catch {
    console.error('[bot] update processing failed');
    return res.status(503).set('Retry-After', '5').json({ error: 'RETRY_UPDATE' });
  }
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'INTERNAL' });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`API on :${port}`);

  if (!paymentsSecretReady()) {
    console.warn('[pay] PAYMENTS_SECRET не задано — передоплата працювати не буде');
  }
  if (!process.env.PUBLIC_API_URL) {
    console.warn('[pay] PUBLIC_API_URL не задано — вебхуки підуть на localhost');
  }
  if (process.env.NODE_ENV === 'production' && adminOrigins.length === 0) {
    console.warn('[cors] ADMIN_ORIGINS порожній — кабінет з іншого домену не працюватиме');
  }

  if (process.env.BACKGROUND_JOBS === 'off') {
    // Browser/integration checks may use a shared test database. In this
    // mode the HTTP API works, but startup cannot expire bookings or send
    // scheduled messages behind the test's back.
    console.log('[jobs] фонові задачі вимкнені');
  } else {
    // Звільняє слоти під неоплаченими бронями. Страховка на випадок,
    // коли гравець просто закрив вкладку і банк нічого не надішле.
    startExpirySweeper();

    // Бот приймає команди тільки через webhook. Без публічної адреси він
    // лишається в режимі вихідних подієвих сповіщень і нічого не опитує.
    void startBot();

    // Щоденне зведення власнику о DIGEST_HOUR за часом клубу.
    startDigestScheduler();

    // Ранкова сводка ІІ-менеджера власнику (вимкнена, поки власник не ввімкне в налаштуваннях бота).
    startMorningBriefScheduler();

    // Нагадування перед заняттям.
    startReminderScheduler();

    // Гравцям: нагадування за 3 години з «Прийду / Скасувати» і черга.
    startPlayerScheduler();

    // Повернення тих, хто давно не грав: раз на годину, вдень за часом клубу,
    // тільки за згодою гравця й лише там, де клуб це ввімкнув.
    startWinbackScheduler();

    // Листи повернення від ІІ, що чекали денного вікна після затвердження власником.
    startWinbackQueueScheduler();

    // Видалення даних клубів через 90 днів після розірвання (оферта п. 13.1).
    // Вимкнено без DATA_RETENTION_ENABLED=true; без DATA_RETENTION_DRY_RUN=false нічого не видаляє.
    startRetentionScheduler();
  }
});
