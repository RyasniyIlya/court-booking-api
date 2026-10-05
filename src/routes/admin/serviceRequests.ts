import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { requireAuth, requireRole } from './shared';

export const serviceRequestsRouter = Router();

const SERVICE_REQUEST_KINDS = ['repair', 'surface', 'nets', 'lighting', 'other'] as const;

/* Валідація повідомлення: 5–2000 символів */
const messageSchema = z.string().min(5).max(2000);

const createServiceRequestSchema = z.object({
  kind: z.enum(SERVICE_REQUEST_KINDS),
  courtId: z.string().uuid().optional(),
  message: messageSchema,
  contactName: z.string().max(255).optional(),
  contactPhone: z.string().max(20).optional(),
});

type CreateServiceRequestInput = z.infer<typeof createServiceRequestSchema>;

/**
 * POST /api/admin/service-requests
 * Клуб створює заявку на сервіс. Тільки OWNER/ADMIN.
 * Тільки якщо club.partnerId встановлено, інакше 409 NO_PARTNER.
 */
serviceRequestsRouter.post(
  '/service-requests',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const parsed = createServiceRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'BAD_REQUEST' });
    }

    const club = await prisma.club.findUnique({
      where: { id: req.auth!.clubId },
      select: { id: true, partnerId: true },
    });

    if (!club) {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }

    if (!club.partnerId) {
      return res.status(409).json({ error: 'NO_PARTNER' });
    }

    /* Если courtId задан, перевіримо, що він належить цьому клубу */
    if (parsed.data.courtId) {
      const court = await prisma.court.findUnique({
        where: { id: parsed.data.courtId },
        select: { clubId: true },
      });

      if (!court || court.clubId !== req.auth!.clubId) {
        return res.status(404).json({ error: 'COURT_NOT_FOUND' });
      }
    }

    const serviceRequest = await prisma.serviceRequest.create({
      data: {
        clubId: club.id,
        partnerId: club.partnerId,
        kind: parsed.data.kind,
        message: parsed.data.message,
        courtId: parsed.data.courtId || null,
        contactName: parsed.data.contactName || null,
        contactPhone: parsed.data.contactPhone || null,
      },
      select: {
        id: true,
        kind: true,
        message: true,
        courtId: true,
        contactName: true,
        contactPhone: true,
        status: true,
        partnerNote: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json(serviceRequest);
  },
);

/**
 * GET /api/admin/service-requests
 * Отримати заявки свого клубу. Тільки OWNER/ADMIN.
 */
serviceRequestsRouter.get(
  '/service-requests',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const serviceRequests = await prisma.serviceRequest.findMany({
      where: {
        clubId: req.auth!.clubId,
      },
      select: {
        id: true,
        kind: true,
        message: true,
        courtId: true,
        contactName: true,
        contactPhone: true,
        status: true,
        partnerNote: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.json(serviceRequests);
  },
);
