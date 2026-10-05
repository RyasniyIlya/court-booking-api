import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/db';
import { requirePlatformAuth } from '../lib/platformAuth';
import {
  ACT_SELECT, actView, generateActs, parseQuarter, QUARTER_RE, renderActHtml, sendActHtml, transitionAct,
  type ActAction,
} from '../lib/partnerActs';
import {
  PARTNER_CONTRACT_SELECT, PARTNER_REQUISITES_SELECT, SELLER_SELECT, codeMatchesKind, contractView,
  partnerReadiness, partnerRequisitesPatchSchema, requisitesView, sellerCreateSchema, sellerPatchSchema,
} from '../lib/partnerRequisites';

/**
 * Оператор: наші реквізити (SellerProfile), договір і реквізити партнера,
 * квартальні акти, профіль отримувача на рахунку клубу.
 * Монтується в platformRouter ДО параметризованих маршрутів /partners/:id.
 */
export const paperworkRouter = Router();

const param = (v: string | string[]) => (Array.isArray(v) ? v[0] : v);
const uuid = z.string().uuid();
const isUnique = (e: unknown) => (e as { code?: string })?.code === 'P2002';

/* -------------------------------------------------------------------------- */
/* SellerProfile                                                              */
/* -------------------------------------------------------------------------- */

paperworkRouter.get('/sellers', requirePlatformAuth, async (_req, res) => {
  const rows = await prisma.sellerProfile.findMany({
    select: SELLER_SELECT,
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  res.json(rows);
});

paperworkRouter.post('/sellers', requirePlatformAuth, async (req, res) => {
  const parsed = sellerCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST', fields: parsed.error.issues.map((i) => i.path.join('.')) });
  const { isDefault, ...data } = parsed.data;

  const seller = await prisma.$transaction(async (tx) => {
    /* Перший профіль автоматично основний; інакше — лише за явним запитом. */
    const makeDefault = !!isDefault || (await tx.sellerProfile.count({ where: { isDefault: true, isActive: true } })) === 0;
    if (makeDefault) await tx.sellerProfile.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    return tx.sellerProfile.create({ data: { ...data, isDefault: makeDefault }, select: SELLER_SELECT });
  });
  res.status(201).json(seller);
});

paperworkRouter.patch('/sellers/:id', requirePlatformAuth, async (req, res) => {
  const id = param(req.params.id);
  const parsed = sellerPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST', fields: parsed.error.issues.map((i) => i.path.join('.')) });

  const existing = await prisma.sellerProfile.findUnique({ where: { id }, select: { id: true, kind: true, code: true, isDefault: true } });
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  const kind = parsed.data.kind ?? existing.kind;
  const code = parsed.data.code ?? existing.code;
  if (!codeMatchesKind(kind, code)) return res.status(400).json({ error: 'BAD_REQUEST', fields: ['code'] });
  if (parsed.data.isActive === false && existing.isDefault) {
    return res.status(409).json({ error: 'DEFAULT_SELLER' });
  }

  const seller = await prisma.sellerProfile.update({ where: { id }, data: parsed.data, select: SELLER_SELECT });
  res.json(seller);
});

paperworkRouter.post('/sellers/:id/default', requirePlatformAuth, async (req, res) => {
  const id = param(req.params.id);
  const existing = await prisma.sellerProfile.findUnique({ where: { id }, select: { id: true, isActive: true } });
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!existing.isActive) return res.status(409).json({ error: 'SELLER_INACTIVE' });

  const seller = await prisma.$transaction(async (tx) => {
    await tx.sellerProfile.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
    return tx.sellerProfile.update({ where: { id }, data: { isDefault: true }, select: SELLER_SELECT });
  });
  res.json(seller);
});

/* -------------------------------------------------------------------------- */
/* Договір і реквізити партнера                                               */
/* -------------------------------------------------------------------------- */

const contractSchema = z
  .object({
    contractMode: z.enum(['PUBLIC_OFFER', 'INDIVIDUAL']),
    contractNo: z.string().trim().min(1).max(60).optional(),
    contractDate: z.string().date().or(z.string().datetime({ offset: true })).optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.contractMode === 'INDIVIDUAL') {
      if (!d.contractNo) ctx.addIssue({ code: 'custom', path: ['contractNo'], message: 'REQUIRED' });
      if (!d.contractDate) ctx.addIssue({ code: 'custom', path: ['contractDate'], message: 'REQUIRED' });
    }
  });

const PARTNER_PAPER_SELECT = {
  id: true, ...PARTNER_REQUISITES_SELECT, ...PARTNER_CONTRACT_SELECT,
} as const;

function paperView(p: Parameters<typeof partnerReadiness>[0] & Parameters<typeof requisitesView>[0] & Parameters<typeof contractView>[0] & { id: string }) {
  return { id: p.id, requisites: requisitesView(p), contract: contractView(p), ...partnerReadiness(p) };
}

paperworkRouter.patch('/partners/:id/contract', requirePlatformAuth, async (req, res) => {
  const id = param(req.params.id);
  const parsed = contractSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const d = parsed.data;

  const existing = await prisma.partner.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  const data =
    d.contractMode === 'INDIVIDUAL'
      ? { contractMode: 'INDIVIDUAL' as const, contractNo: d.contractNo!, contractDate: new Date(d.contractDate!) }
      : { contractMode: 'PUBLIC_OFFER' as const, contractNo: null, contractDate: null };
  const partner = await prisma.partner.update({ where: { id }, data, select: PARTNER_PAPER_SELECT });
  res.json(paperView(partner));
});

paperworkRouter.patch('/partners/:id/requisites', requirePlatformAuth, async (req, res) => {
  const id = param(req.params.id);
  const parsed = partnerRequisitesPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST', fields: parsed.error.issues.map((i) => i.path.join('.')) });

  const existing = await prisma.partner.findUnique({ where: { id }, select: { id: true, kind: true, legalCode: true } });
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  const kind = parsed.data.kind ?? existing.kind;
  const code = parsed.data.legalCode ?? existing.legalCode;
  if (kind && code && !codeMatchesKind(kind, code)) {
    return res.status(400).json({ error: 'BAD_REQUEST', fields: ['legalCode'] });
  }

  const partner = await prisma.partner.update({
    where: { id },
    data: { ...parsed.data, requisitesAt: new Date() },
    select: PARTNER_PAPER_SELECT,
  });
  res.json(paperView(partner));
});

/* -------------------------------------------------------------------------- */
/* Профіль отримувача на рахунку клубу                                        */
/* -------------------------------------------------------------------------- */

paperworkRouter.patch('/invoices/:id/seller', requirePlatformAuth, async (req, res) => {
  const id = param(req.params.id);
  const parsed = z.object({ sellerId: uuid.nullable() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const { sellerId } = parsed.data;

  const invoice = await prisma.clubInvoice.findUnique({ where: { id }, select: { id: true } });
  if (!invoice) return res.status(404).json({ error: 'NOT_FOUND' });

  let seller: { id: string; label: string } | null = null;
  if (sellerId) {
    seller = await prisma.sellerProfile.findUnique({ where: { id: sellerId }, select: { id: true, label: true } });
    if (!seller) return res.status(404).json({ error: 'SELLER_NOT_FOUND' });
  }
  await prisma.clubInvoice.update({ where: { id }, data: { sellerId } });
  res.json({ ok: true, invoiceId: id, seller: seller ? { id: seller.id, label: seller.label } : null });
});

/* -------------------------------------------------------------------------- */
/* Акти. Статичні маршрути (/generate) — ДО /:id                              */
/* -------------------------------------------------------------------------- */

const listQuery = z.object({
  status: z.enum(['DRAFT', 'ISSUED', 'SIGNED', 'PAID', 'VOID']).optional(),
  partnerId: uuid.optional(),
  quarter: z.string().regex(QUARTER_RE).optional(),
});

paperworkRouter.get('/partner-acts', requirePlatformAuth, async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const { status, partnerId, quarter } = parsed.data;
  const q = quarter ? parseQuarter(quarter) : null;

  const rows = await prisma.partnerAct.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(partnerId ? { partnerId } : {}),
      ...(q ? { periodFrom: q.from } : {}),
    },
    select: ACT_SELECT,
    orderBy: [{ periodFrom: 'desc' }, { number: 'desc' }],
  });
  res.json(rows.map(actView));
});

paperworkRouter.post('/partner-acts/generate', requirePlatformAuth, async (req, res) => {
  const parsed = z
    .object({ quarter: z.string().regex(QUARTER_RE), partnerId: uuid.optional() })
    .strict()
    .safeParse(req.body);
  if (!parsed.success || !parseQuarter(parsed.data.quarter)) return res.status(400).json({ error: 'BAD_REQUEST' });

  let result;
  try {
    result = await generateActs(parsed.data, prisma);
  } catch (e) {
    if (isUnique(e)) return res.status(409).json({ error: 'ACT_EXISTS' });
    throw e;
  }
  if ('error' in result) {
    const code = result.error === 'PARTNER_NOT_FOUND' ? 404 : result.error === 'BAD_QUARTER' ? 400 : 409;
    return res.status(code).json({ error: result.error });
  }
  res.json(result);
});

async function act(req: import('express').Request, res: import('express').Response, action: ActAction, opts: { paidAt?: Date } = {}) {
  const id = param(req.params.id);
  if (!uuid.safeParse(id).success) return res.status(404).json({ error: 'NOT_FOUND' });
  const r = await transitionAct(prisma, id, action, opts);
  if ('error' in r) return res.status(r.error === 'NOT_FOUND' ? 404 : 409).json({ error: r.error });
  res.json(r.act);
}

paperworkRouter.post('/partner-acts/:id/issue', requirePlatformAuth, (req, res) => act(req, res, 'issue'));
paperworkRouter.post('/partner-acts/:id/sign', requirePlatformAuth, (req, res) => act(req, res, 'sign'));
paperworkRouter.post('/partner-acts/:id/void', requirePlatformAuth, (req, res) => act(req, res, 'void'));

paperworkRouter.post('/partner-acts/:id/pay', requirePlatformAuth, async (req, res) => {
  const parsed = z
    .object({ paidAt: z.string().datetime({ offset: true }).or(z.string().date()).optional() })
    .strict()
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  await act(req, res, 'pay', { paidAt: parsed.data.paidAt ? new Date(parsed.data.paidAt) : undefined });
});

paperworkRouter.get('/partner-acts/:id/html', requirePlatformAuth, async (req, res) => {
  const id = param(req.params.id);
  if (!uuid.safeParse(id).success) return res.status(404).json({ error: 'NOT_FOUND' });
  const row = await prisma.partnerAct.findUnique({
    where: { id },
    select: { number: true, periodFrom: true, periodTo: true, amount: true, lines: true, sellerSnapshot: true, partnerSnapshot: true, status: true },
  });
  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
  sendActHtml(res, renderActHtml(row));
});

