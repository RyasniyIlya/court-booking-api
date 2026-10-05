import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/db';
import { requirePlatformAuth } from '../lib/platformAuth';
import { grantSubscription } from '../lib/grantSubscription';
import { sendReceiptFile } from '../lib/receiptFile';
import { scheduleReceiptCheck } from '../lib/receiptCheck';

/** Черга квитанцій оператора. Монтується в platformRouter (/api/platform). */
export const receiptsRouter = Router();

const idOf = (v: string | string[]) => (Array.isArray(v) ? v[0] : v);

const LIST_SELECT = {
  id: true,
  clubId: true,
  invoiceId: true,
  mime: true,
  size: true,
  uploadedAt: true,
  aiStatus: true,
  aiResult: true,
  aiCheckedAt: true,
  status: true,
  reviewedBy: true,
  reviewedAt: true,
  rejectReason: true,
  club: { select: { name: true } },
  invoice: { select: { number: true, amount: true, periodFrom: true, periodTo: true, issuedAt: true, status: true, seller: { select: { legalName: true, iban: true } } } },
} as const;

const statusSchema = z.enum(['PENDING', 'CONFIRMED', 'REJECTED']);

receiptsRouter.get('/receipts', requirePlatformAuth, async (req, res) => {
  const q = req.query.status === undefined ? undefined : statusSchema.safeParse(req.query.status);
  if (q && !q.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const receipts = await prisma.paymentReceipt.findMany({
    where: q?.success ? { status: q.data } : {},
    orderBy: { uploadedAt: 'asc' },
    take: 200,
    select: LIST_SELECT,
  });
  res.json({ receipts });
});

receiptsRouter.get('/receipts/:id/file', requirePlatformAuth, async (req, res) => {
  const row = await prisma.paymentReceipt.findUnique({
    where: { id: idOf(req.params.id) },
    select: { mime: true, fileData: true },
  });
  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
  sendReceiptFile(res, row.mime, row.fileData);
});

receiptsRouter.post('/receipts/:id/recheck', requirePlatformAuth, async (req, res) => {
  const id = idOf(req.params.id);
  const row = await prisma.paymentReceipt.findUnique({ where: { id }, select: { id: true } });
  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
  await prisma.paymentReceipt.update({ where: { id }, data: { aiStatus: 'PENDING' } });
  await scheduleReceiptCheck(id);
  res.status(202).json({ ok: true });
});

const confirmSchema =z.object({
  paidAt: z.string().date().optional(),
});

receiptsRouter.post('/receipts/:id/confirm', requirePlatformAuth, async (req, res) => {
  const parsed = confirmSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const id = idOf(req.params.id);
  const receipt = await prisma.paymentReceipt.findUnique({
    where: { id },
    select: { id: true, clubId: true, invoiceId: true, status: true, invoice: { select: { status: true } } },
  });
  if (!receipt) return res.status(404).json({ error: 'NOT_FOUND' });
  if (receipt.invoice.status !== 'ISSUED') return res.status(409).json({ error: 'INVOICE_NOT_OPEN' });

  // Atomic claim: спроба встановити статус CONFIRMED тільки якщо поточний статус PENDING
  const claimed = await prisma.paymentReceipt.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'CONFIRMED', reviewedBy: req.platformAuth?.email ?? null, reviewedAt: new Date() },
  });

  if (claimed.count === 0) {
    return res.status(409).json({ error: 'ALREADY_REVIEWED' });
  }

  /* Той самий шлях, що й ручна видача підписки: рахунок -> PAID, paidUntil. */
  try {
    const result = await grantSubscription({
      clubId: receipt.clubId,
      invoiceId: receipt.invoiceId,
      method: 'transfer',
      note: 'За квитанцією',
      paidAt: parsed.data.paidAt ? new Date(`${parsed.data.paidAt}T12:00:00.000Z`) : new Date(),
      actorEmail: req.platformAuth?.email,
    });
    if (!result) return res.status(404).json({ error: 'NOT_FOUND' });

    res.json({ ok: true, invoice: result.invoice, club: result.club });
  } catch (e) {
    // Revert the status back to PENDING if grantSubscription fails
    await prisma.paymentReceipt.update({
      where: { id },
      data: { status: 'PENDING', reviewedBy: null, reviewedAt: null },
    });
    throw e;
  }
});

const rejectSchema = z.object({ reason: z.string().trim().min(1).max(500) });

receiptsRouter.post('/receipts/:id/reject', requirePlatformAuth, async (req, res) => {
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const id = idOf(req.params.id);

  // Atomic update: only update if status is PENDING
  const updated = await prisma.paymentReceipt.updateMany({
    where: { id, status: 'PENDING' },
    data: {
      status: 'REJECTED',
      rejectReason: parsed.data.reason,
      reviewedBy: req.platformAuth?.email ?? null,
      reviewedAt: new Date(),
    },
  });

  if (updated.count === 0) {
    // Check if receipt exists at all
    const receipt = await prisma.paymentReceipt.findUnique({ where: { id }, select: { id: true } });
    if (!receipt) return res.status(404).json({ error: 'NOT_FOUND' });
    return res.status(409).json({ error: 'ALREADY_REVIEWED' });
  }

  res.json({ ok: true });
});
