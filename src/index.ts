import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { publicRouter } from './routes/public';
import { adminRouter } from './routes/admin';

const app = express();
app.use(express.json({ limit: '100kb' }));
// Віджет вантажиться на чужих доменах — CORS відкритий тільки для публічного API
app.use('/api/public', cors({ origin: true }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/public', publicRouter);
app.use('/api/admin', adminRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'INTERNAL' });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`API on :${port}`));
