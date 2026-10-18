import { Router, type NextFunction, type Request, type Response } from 'express';
import type { UserRole } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { AiError, aiConfigured } from '../../lib/ai/gemini';
import { BRIEF_REQUEST, ownerAssistant } from '../../lib/ai/ownerAssistant';
import { loadOwnerSnapshot, ownerSuggestions, snapshotHeadline } from '../../lib/ai/ownerContext';
import { envLimit, takeQuota } from '../../lib/ai/quota';
import '../../lib/ai/executors';
import { AiActionError, approveAction, expireStaleActions, rejectAction } from '../../lib/ai/actions';
import { ReportRefused, buildReportFile, reportParamsSchema } from '../../lib/ai/reportFile';
import { XLSX_CONTENT_TYPE } from '../../lib/xlsx';
import { recordChanges } from '../../lib/changeLog';
import { effectivePermissions, policyBodySchema, type EffectivePermissions } from '../../lib/ai/policy';
import { loadPolicy, savePolicy } from '../../lib/ai/policyStore';
import { queueActionAlert } from '../../lib/aiTelegram';
import { param, requireAuth, requireFeature, requireRole } from './shared';

/**
 * Нейроаналітик власника й права ІІ.
 *
 *   POST /api/admin/ai/chat    — розмова з аналітиком
 *   POST /api/admin/ai/brief   — ранкова сводка (готове завдання)
 *   GET  /api/admin/ai/status  — рядок-знімок і питання для кабінету
 *   GET|PUT /api/admin/ai/policy        — що ІІ дозволено (тільки OWNER)
 *   GET  /api/admin/ai/actions          — журнал/черга дій ІІ (тільки OWNER)
 *   POST /api/admin/ai/actions/:id/approve|reject — рішення власника
 *   GET  /api/admin/ai/actions/:id/file — xlsx-звіт, зібраний на льоту за поточними правами того, хто качає
 *
 * Розмова: власник завжди; інші ролі — лише якщо власник відкрив їм доступ у
 * політиці, і тоді інструменти й знімок урізані до їхніх прав (виручка
 * модератору за ролями недоступна — як і сторінка фінансів). Політику й
 * чергу дій бачить і міняє тільки власник. Тариф «Аналітика».
 */
export const aiRouter = Router();

/* Строго з префіксом /ai: роутер монтується в корінь адмінки, і `use` без
   шляху відповів би 403 на запити до всіх роутів, що йдуть після нього. */
aiRouter.use('/ai', requireAuth, requireFeature('ai'));

const ownerOnly = requireRole('OWNER');

/** Доступ до розмови: власник завжди, інші ролі — за політикою. Права кладемо в res.locals. */
async function aiAccess(req: Request, res: Response, next: NextFunction) {
  const perms = effectivePermissions(await loadPolicy(req.auth!.clubId), req.auth!.role);
  if (!perms.access) return res.status(403).json({ error: 'FORBIDDEN' });
  res.locals.aiPerms = perms;
  next();
}
const permsOf = (res: Response) => res.locals.aiPerms as EffectivePermissions;

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
/** Сводка залежить від прав: кеш однієї ролі не має віддаватись іншій, а після зміни політики — застарілий. */
const briefKey = (clubId: string, p: EffectivePermissions) =>
  `${clubId}:${[p.readFinance, p.readCustomers, p.readStaff].map(Number).join('')}`;
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
aiRouter.get('/ai/status', aiAccess, async (req, res) => {
  const perms = permsOf(res);
  if (!aiConfigured()) return res.json({ configured: false, headline: null, suggestions: [] });
  let snap = null;
  try {
    const club = await ownerClub(req.auth!.clubId);
    if (club) snap = await loadOwnerSnapshot(club);
  } catch {
    snap = null;
  }
  res.json({
    configured: true,
    headline: snapshotHeadline(snap, perms.readFinance),
    suggestions: ownerSuggestions(snap, perms.readFinance),
  });
});

aiRouter.post('/ai/chat', aiAccess, async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  if (!aiConfigured()) return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });

  const club = await ownerClub(req.auth!.clubId);
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });
  if (!takeQuota('owner', club.id, envLimit('AI_OWNER_DAILY_LIMIT', 100))) {
    return res.status(429).json({ error: 'AI_DAILY_LIMIT' });
  }

  try {
    const { reply, steps, tokens, actions } = await ownerAssistant({
      club, messages: parsed.data.messages, perms: permsOf(res), role: req.auth!.role,
      manager: { requester: { id: req.auth!.userId, role: req.auth!.role as UserRole } },
    });
    console.log(`[ai] owner chat steps=${steps} tokens=${tokens} actions=${actions.length}`);
    /* Нова пропозиція, що чекає рішення, — і власнику в Telegram (згруповано, якщо налаштовано). */
    queueActionAlert(club.id, req.auth!.role as UserRole, actions);
    /* actions — картки пропозицій під відповіддю: кабінет показує статус і кнопки. */
    res.json({ reply, actions });
  } catch (e) {
    fail(res, e);
  }
});

aiRouter.post('/ai/brief', aiAccess, async (req, res) => {
  const perms = permsOf(res);
  if (!aiConfigured()) return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });

  const club = await ownerClub(req.auth!.clubId);
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });

  const key = briefKey(club.id, perms);
  const cached = briefCache.get(key);
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
    const { reply, steps, tokens } = await ownerAssistant({ club, messages: [{ role: 'user', content: BRIEF_REQUEST }], perms, role: req.auth!.role });
    console.log(`[ai] owner brief steps=${steps} tokens=${tokens}`);
    briefCache.set(key, { at: Date.now(), reply });
    res.json({ reply, cached: false });
  } catch (e) {
    fail(res, e);
  }
});

/* ── Права ІІ і журнал дій: тільки власник ───────────────────────────────── */

aiRouter.get('/ai/policy', ownerOnly, async (req, res) => {
  const [policy, row] = await Promise.all([
    loadPolicy(req.auth!.clubId),
    prisma.aiAgentPolicy.findUnique({ where: { clubId: req.auth!.clubId }, select: { updatedAt: true } }),
  ]);
  res.json({ ...policy, updatedAt: row?.updatedAt ?? null });
});

aiRouter.put('/ai/policy', ownerOnly, async (req, res) => {
  const parsed = policyBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const { policy, updatedAt } = await savePolicy(req.auth!.clubId, parsed.data, req.auth!.userId);
  res.json({ ...policy, updatedAt });
});

const actionsQuery = z.object({
  status: z.enum(['PENDING', 'EXECUTED', 'REJECTED', 'FAILED', 'EXPIRED']).optional(),
});
const actionId = z.string().uuid();

aiRouter.get('/ai/actions', ownerOnly, async (req, res) => {
  const q = actionsQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const clubId = req.auth!.clubId;
  await expireStaleActions(clubId);
  const items = await prisma.aiAction.findMany({
    where: { clubId, ...(q.data.status ? { status: q.data.status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ items });
});

function actionFail(res: Response, e: unknown) {
  if (!(e instanceof AiActionError)) throw e;
  const status = e.code === 'AI_ACTION_NOT_FOUND' ? 404 : e.code === 'AI_ACTION_FORBIDDEN' ? 403 : 409;
  return res.status(status).json({ error: e.code });
}

for (const [verb, decide] of [['approve', approveAction], ['reject', rejectAction]] as const) {
  aiRouter.post(`/ai/actions/:id/${verb}`, ownerOnly, async (req, res) => {
    const id = actionId.safeParse(param(req, 'id'));
    if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });
    try {
      res.json({ action: await decide(id.data, { id: req.auth!.userId, clubId: req.auth!.clubId }) });
    } catch (e) {
      actionFail(res, e);
    }
  });
}

/* ── Файл-звіт ───────────────────────────────────────────────────────────────
   Файл не зберігається: в AiAction лежать лише параметри, а книга збирається тут,
   на поточних даних і за ПОТОЧНИМИ правами того, хто качає (не того, хто просив).
   Бачить дію свого клубу власник або той, хто її запросив; чужа й чужого клубу —
   однаково 404, щоб не підказувати, що такий id існує. */
aiRouter.get('/ai/actions/:id/file', aiAccess, async (req, res) => {
  const id = actionId.safeParse(param(req, 'id'));
  if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const { clubId, userId, role } = req.auth!;

  const action = await prisma.aiAction.findFirst({ where: { id: id.data, clubId, kind: 'report.xlsx' } });
  if (!action || (role !== 'OWNER' && action.requestedById !== userId)) return res.status(404).json({ error: 'NOT_FOUND' });
  if (action.status !== 'EXECUTED') return res.status(409).json({ error: 'AI_ACTION_NOT_READY' });
  const params = reportParamsSchema.safeParse(action.payload);
  if (!params.success) return res.status(422).json({ error: 'BAD_REPORT' });

  try {
    const { fileName, buffer } = await buildReportFile(clubId, params.data, permsOf(res));
    /* Журнал до відправки, як у решти вивантажень: файл може містити персональні дані. */
    const actor = await prisma.user.findFirst({ where: { id: userId, clubId }, select: { email: true } });
    await recordChanges(
      prisma,
      { clubId, entity: 'AiReportExport', entityId: action.id },
      { userId, email: actor?.email ?? '', role },
      [{ field: 'export', before: null, after: params.data }],
    );
    res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (e) {
    if (e instanceof ReportRefused) return res.status(403).json({ error: 'REPORT_FORBIDDEN', message: e.message });
    throw e;
  }
});
