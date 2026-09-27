import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { AiError, aiConfigured } from '../../lib/ai/gemini';
import { BRIEF_REQUEST, ownerAssistant } from '../../lib/ai/ownerAssistant';
import { loadOwnerSnapshot, ownerSuggestions, snapshotHeadline } from '../../lib/ai/ownerContext';
import { envLimit, takeQuota } from '../../lib/ai/quota';
import { requireAuth, requireFeature, requireRole } from './shared';

/**
 * Нейроаналітик власника.
 *
 *   POST /api/admin/ai/chat   — розмова з аналітиком
 *   POST /api/admin/ai/brief  — ранкова сводка (готове завдання)
 *
 * Тільки власник: у відповідях виручка й економіка клубу, модератору вони
 * за ролями недоступні — як і сторінка фінансів. Тариф «Аналітика».
 */
export const aiRouter = Router();

/* Строго з префіксом /ai: роутер монтується в корінь адмінки, і `use` без
   шляху відповів би 403 на запити до всіх роутів, що йдуть після нього. */
aiRouter.use('/ai', requireAuth, requireRole('OWNER'), requireFeature('ai'));

const chatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().trim().min(1).max(2000),
  })).min(1).max(30),
}).refine((b) => b.messages[b.messages.length - 1].role === 'user', { message: 'last message must be from user' });

async function ownerClub(clubId: string) {
  const c = await prisma.club.findUnique({
    where: { id: clubId },
    select: { id: true, name: true, timezone: true, address: true, plan: { select: { name: true } } },
  });
  if (!c) return null;
  const { plan, ...rest } = c;
  return { ...rest, planName: plan?.name ?? null };
}

/** Сводка коштує кількох викликів із пошуком, тому кешуємо на пів години: відкрив двічі — заплатили раз. */
const briefCache = new Map<string, { at: number; reply: string }>();
const BRIEF_TTL_MS = 30 * 60_000;
/** «Оновити» не має сенсу частіше: той самий знімок клубу (кеш 5 хв) дасть майже той самий текст за повну ціну повного прогону. */
const BRIEF_MIN_REFRESH_MS = 5 * 60_000;

function fail(res: import('express').Response, e: unknown) {
  if (e instanceof AiError && e.code === 'AI_BLOCKED') return res.status(422).json({ error: 'AI_BLOCKED' });
  console.error('[ai] owner assistant failed:', e instanceof AiError ? e.code : 'unexpected');
  return res.status(502).json({ error: 'AI_UNAVAILABLE' });
}

/* Статус + «голова» кабінету: рядок зі знімком і три питання під ситуацію.
   Без ключа Gemini в БД не ходимо взагалі. Знімок кешується на 5 хв, тож
   відкриття сторінки не б'є по БД щоразу. */
aiRouter.get('/ai/status', async (req, res) => {
  if (!aiConfigured()) return res.json({ configured: false, headline: null, suggestions: [] });
  let snap = null;
  try {
    const club = await ownerClub(req.auth!.clubId);
    if (club) snap = await loadOwnerSnapshot(club);
  } catch {
    snap = null;
  }
  res.json({ configured: true, headline: snapshotHeadline(snap), suggestions: ownerSuggestions(snap) });
});

aiRouter.post('/ai/chat', async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  if (!aiConfigured()) return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });

  const club = await ownerClub(req.auth!.clubId);
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });
  if (!takeQuota('owner', club.id, envLimit('AI_OWNER_DAILY_LIMIT', 100))) {
    return res.status(429).json({ error: 'AI_DAILY_LIMIT' });
  }

  try {
    const { reply, steps, tokens } = await ownerAssistant({ club, messages: parsed.data.messages });
    console.log(`[ai] owner chat steps=${steps} tokens=${tokens}`);
    res.json({ reply });
  } catch (e) {
    fail(res, e);
  }
});

aiRouter.post('/ai/brief', async (req, res) => {
  if (!aiConfigured()) return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });

  const club = await ownerClub(req.auth!.clubId);
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });

  const cached = briefCache.get(club.id);
  /* refresh:true ігноруємо, якщо кеш свіжіший за 5 хв: знімок клубу (теж 5-хвилинний
     кеш) майже не встигає змінитись, а повний прогін із пошуком коштує як новий. */
  const fresh = req.body?.refresh === true && (!cached || Date.now() - cached.at >= BRIEF_MIN_REFRESH_MS);
  if (cached && !fresh && Date.now() - cached.at < BRIEF_TTL_MS) {
    return res.json({ reply: cached.reply, cached: true });
  }
  if (!takeQuota('owner', club.id, envLimit('AI_OWNER_DAILY_LIMIT', 100))) {
    return res.status(429).json({ error: 'AI_DAILY_LIMIT' });
  }

  try {
    const { reply, steps, tokens } = await ownerAssistant({ club, messages: [{ role: 'user', content: BRIEF_REQUEST }] });
    console.log(`[ai] owner brief steps=${steps} tokens=${tokens}`);
    briefCache.set(club.id, { at: Date.now(), reply });
    res.json({ reply, cached: false });
  } catch (e) {
    fail(res, e);
  }
});
