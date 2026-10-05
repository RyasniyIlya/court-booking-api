import { Router, raw } from 'express';
import { createHash } from 'node:crypto';

import { prisma } from '../../lib/db';
import { RECEIPT_MAX_BYTES, RECEIPT_MIMES, sendReceiptFile, sniffReceipt } from '../../lib/receiptFile';
import { scheduleReceiptCheck } from '../../lib/receiptCheck';
import { requireAuth, requireRole } from './shared';

export const receiptsRouter = Router();

/** Без fileData: байти віддає лише окремий маршрут файлу. */
const RECEIPT_VIEW = {
  id: true,
  invoiceId: true,
  mime: true,
  size: true,
  uploadedAt: true,
  status: true,
  reviewedAt: true,
  rejectReason: true,
} as const;

const idOf = (v: string | string[]) => (Array.isArray(v) ? v[0] : v);

/**
 * POST /api/admin/billing/invoice/:id/receipt — сире тіло (як логотип).
 * Тип — за magic bytes, ≤ 5 МБ, рахунок свого клубу в статусі ISSUED.
 */
receiptsRouter.post(
  '/billing/invoice/:id/receipt',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  raw({ type: '*/*', limit: RECEIPT_MAX_BYTES }),
  async (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: 'EMPTY_FILE' });
    }

    const mime = sniffReceipt(body);
    if (!mime) {
      return res.status(415).json({ error: 'UNSUPPORTED_TYPE', allowed: [...RECEIPT_MIMES] });
    }

    const clubId = req.auth!.clubId;
    const invoice = await prisma.clubInvoice.findFirst({
      where: { id: idOf(req.params.id), clubId },
      select: { id: true, status: true },
    });
    if (!invoice) return res.status(404).json({ error: 'NOT_FOUND' });
    if (invoice.status !== 'ISSUED') return res.status(409).json({ error: 'INVOICE_NOT_OPEN' });

    const sha256 = createHash('sha256').update(body).digest('hex');
    const dup = await prisma.paymentReceipt.findUnique({ where: { sha256 }, select: { id: true } });
    if (dup) return res.status(409).json({ error: 'RECEIPT_DUPLICATE' });

    let receipt;
    try {
      receipt = await prisma.paymentReceipt.create({
        data: {
          clubId,
          invoiceId: invoice.id,
          fileData: body,
          mime,
          size: body.length,
          sha256,
          uploadedBy: req.auth!.userId,
        },
        select: RECEIPT_VIEW,
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        return res.status(409).json({ error: 'RECEIPT_DUPLICATE' });
      }
      throw e;
    }

    await scheduleReceiptCheck(receipt.id);

    res.status(201).json({ receipt });
  },
);

/** GET /api/admin/billing/receipts — квитанції клубу без байтів файлу. */
receiptsRouter.get(
  '/billing/receipts',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const receipts = await prisma.paymentReceipt.findMany({
      where: { clubId: req.auth!.clubId },
      orderBy: { uploadedAt: 'desc' },
      take: 50,
      select: RECEIPT_VIEW,
    });
    res.json({ receipts });
  },
);

/** GET /api/admin/billing/receipts/:id/file */
receiptsRouter.get(
  '/billing/receipts/:id/file',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const row = await prisma.paymentReceipt.findFirst({
      where: { id: idOf(req.params.id), clubId: req.auth!.clubId },
      select: { mime: true, fileData: true },
    });
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    sendReceiptFile(res, row.mime, row.fileData);
  },
);
