import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { prisma } from '../lib/db';
import { planFeatures } from '../lib/plans';
import { AiError, aiConfigured } from '../lib/ai/gemini';
import { clientAssistant } from '../lib/ai/clientAssistant';
import { envLimit, takeQuota } from '../lib/ai/quota';
import { loadPlayerProfile, playerSuggestions, resolveViewer, type PlayerProfile } from '../lib/ai/playerContext';

/**
 * Нейронний менеджер для гравців — публічний чат у віджеті клубу.
 *
 *   GET  /api/public/clubs/:slug/assistant   — чи є чат (для кнопки у віджеті)
 *   POST /api/public/clubs/:slug/assistant   — питання → відповідь + дії
 *
 * Доступний клубам з тарифом «Аналітика» (planFeatures.ai) і лише коли на
 * сервері задано GEMINI_API_KEY. Без ключа чат для гравця просто не
 * показується — це не помилка, а вимкнена можливість.
 */
export const assistantRouter = Router();

/** По IP: людині вистачає з головою, бот швидко впирається. */
const chatLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_REQUESTS' },
});

const bodySchema = z.object({
  /* Історію тримаємо на віджеті й шлемо щоразу: сервер нічого не
     зберігає, тож і чужих розмов у нього нема. Стеля довжини — і від
     витрат, і від спроби запхати в промпт цілий документ. */
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().trim().min(1).max(1000),
  })).min(1).max(20),
  context: z.object({
    courtId: z.string().uuid().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    start: z.string().datetime({ offset: true }).optional(),
    end: z.string().datetime({ offset: true }).optional(),
  }).optional(),
}).refine((b) => b.messages[b.messages.length - 1].role === 'user', { message: 'last message must be from user' });

async function loadAiClub(slug: string) {
  const club = await prisma.club.findFirst({
    where: { slug, isActive: true },
    select: {
      id: true, name: true, timezone: true,
      plan: { select: { tier: true, featTrainers: true, featGroups: true, featAnalytics: true } },
    },
  });
  if (!club) return null;
  return { ...club, ai: planFeatures(club.plan).ai };
}

/**
 * Профіль гравця для персоналізації. Будь-яка проблема (нема токена, чужий
 * клуб, збій БД) означає «гість»: чат не має падати через персоналізацію.
 * AI_PERSONALIZE=off — аварійний вимикач без релізу.
 */
async function viewerProfile(header: string | undefined, clubId: string): Promise<PlayerProfile | null> {
  if (process.env.AI_PERSONALIZE?.trim().toLowerCase() === 'off') return null;
  const viewer = resolveViewer(header, clubId);
  if (!viewer) return null;
  try {
    return await loadPlayerProfile(viewer.customerId, clubId);
  } catch {
    console.error('[ai] player profile failed, falling back to guest');
    return null;
  }
}

assistantRouter.get('/clubs/:slug/assistant', async (req, res) => {
  const club = await loadAiClub(String(req.params.slug));
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });
  const enabled = club.ai && aiConfigured();
  /* Профіль вантажимо лише коли чат узагалі доступний: зайвий запит у БД для вимкненого чату ні до чого. */
  const profile = enabled ? await viewerProfile(req.headers.authorization, club.id) : null;
  res.set('Cache-Control', 'private, no-store').json({
    enabled,
    viewer: profile ? { firstName: profile.firstName } : null,
    suggestions: playerSuggestions(profile),
  });
});

assistantRouter.post('/clubs/:slug/assistant', chatLimiter, async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const club = await loadAiClub(String(req.params.slug));
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });
  if (!club.ai) return res.status(402).json({ error: 'PLAN_REQUIRED', feature: 'ai' });
  if (!aiConfigured()) return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });

  if (!takeQuota('client', club.id, envLimit('AI_CLIENT_DAILY_LIMIT', 300))) {
    return res.status(429).json({ error: 'AI_DAILY_LIMIT' });
  }

  const profile = await viewerProfile(req.headers.authorization, club.id);

  try {
    const { reply, actions, steps, tokens } = await clientAssistant({
      slug: String(req.params.slug),
      clubName: club.name,
      timezone: club.timezone,
      messages: parsed.data.messages,
      context: parsed.data.context,
      profile,
    });
    console.log(`[ai] client chat steps=${steps} tokens=${tokens}`);
    res.json({ reply, actions });
  } catch (e) {
    if (e instanceof AiError && e.code === 'AI_BLOCKED') return res.status(422).json({ error: 'AI_BLOCKED' });
    console.error('[ai] client assistant failed:', e instanceof AiError ? e.code : 'unexpected');
    res.status(502).json({ error: 'AI_UNAVAILABLE' });
  }
});
