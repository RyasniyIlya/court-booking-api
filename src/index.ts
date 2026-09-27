import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { publicRouter } from './routes/public';
import { assistantRouter } from './routes/assistant';
import { adminRouter } from './routes/admin';
import { analyticsRouter } from './routes/analytics';
import { financeRouter } from './routes/finance';
import { platformRouter } from './routes/platform';
import { payRouter } from './routes/pay';
import { startExpirySweeper } from './lib/expire';
import { startBot, telegramWebhookSecret } from './lib/botRunner';
import { startDigestScheduler } from './lib/digestScheduler';
import { startReminderScheduler } from './lib/remind';
import { startPlayerScheduler } from './lib/playerRemind';
import { handleUpdate } from './lib/botHandlers';
import { processTelegramUpdate } from './lib/telegramReceipt';
import { paymentsSecretReady } from './lib/crypto';

const app = express();

// За Render/Vercel завжди один хоп реверс-проксі: без цього req.ip показує
// адресу проксі, а не клієнта, і express-rate-limit або лічить усіх одним
// IP, або сам відмовляється працювати, помітивши недовірений X-Forwarded-For.
app.set('trust proxy', 1);

// Платіжка монтується ПЕРШОЮ і читає сире тіло: підпис вебхука рахується
// від байтів. Якщо тіло пройде через express.json(), підпис не збіжиться.
app.use('/api/pay', express.raw({ type: '*/*', limit: '100kb' }), payRouter);

app.use(express.json({ limit: '100kb' }));

// Віджет вантажиться на чужих доменах — публічне API відкрите для всіх
app.use('/api/public', cors({ origin: true }));

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

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/public', publicRouter);
app.use('/api/public', assistantRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin/analytics', analyticsRouter);
app.use('/api/admin/finance', financeRouter);
app.use('/api/platform', platformRouter);

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

  if (!secret || req.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
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

    // Нагадування перед заняттям.
    startReminderScheduler();

    // Гравцям: нагадування за 3 години з «Прийду / Скасувати» і черга.
    startPlayerScheduler();
  }
});
