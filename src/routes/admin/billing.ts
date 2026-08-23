import { Router } from 'express';

import { prisma } from '../../lib/db';
import { clubBilling, GRACE_DAYS, PERIOD_PRICE } from '../../lib/billing';
import { requireAuth, requireRole } from './shared';

export const billingRouter = Router();

/* BILLING                                                                    */
/* -------------------------------------------------------------------------- */

billingRouter.get(
  '/billing',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const club =
      await prisma.club.findUnique({
        where: {
          id: req.auth!.clubId,
        },
        select: {
          paidUntil: true,
          billingPeriod: true,
          isActive: true,
          createdAt: true,
        },
      });

    if (!club) {
      return res.status(404).json({
        error: 'NOT_FOUND',
      });
    }

    const info =
      clubBilling(club);

    const invoices =
      await prisma.clubInvoice.findMany({
        where: {
          clubId:
            req.auth!.clubId,
        },

        orderBy: {
          periodTo:
            'desc',
        },

        take: 24,

        select: {
          id: true,
          periodFrom: true,
          periodTo: true,
          amount: true,
          status: true,
          method: true,
          issuedAt: true,
          paidAt: true,
        },
      });

    res.json({
      state: info.state,
      online: info.online,
      paidUntil:
        info.paidUntil,
      daysLeft:
        info.daysLeft,
      graceLeft:
        info.graceLeft,
      graceDays:
        GRACE_DAYS,
      period:
        club.billingPeriod,
      prices:
        PERIOD_PRICE,
      since:
        club.createdAt,
      invoices,
    });
  },
);

