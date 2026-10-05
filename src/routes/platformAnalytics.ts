import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/db';
import { requirePlatformAuth } from '../lib/platformAuth';
import { clubListPrice, loadClubMetrics, EMPTY_BUNDLE } from '../lib/platformMetrics';
import { partnerClubStatus } from './partner';
import {
  bySeller, calcArr, calcMrr, churnByMonth, clubsByStatus, forecastNextQuarter, mrrByMonth,
  partnerChannel, receivedByMonth, trialConversion, type AClub,
} from '../lib/platformAnalytics';

/** Аналітика оператора. Формули — у lib/platformAnalytics.ts. */
export const platformAnalyticsRouter = Router();

platformAnalyticsRouter.use('/analytics', requirePlatformAuth);

platformAnalyticsRouter.get('/analytics', async (req, res) => {
  const parsed = z.coerce.number().int().min(1).max(36).default(12).safeParse(req.query.months);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const months = parsed.data;
  const now = new Date();

  const [rows, partners, leads] = await Promise.all([
    prisma.club.findMany({
      select: {
        id: true, isActive: true, approvedAt: true, trialEndsAt: true, paidUntil: true, terminatedAt: true,
        partnerId: true, partnerAttachedAt: true, planPrice: true, billingPeriod: true,
        plan: { select: { price: true, period: true } },
        invoices: {
          where: { status: 'PAID' },
          select: {
            id: true, amount: true, status: true, paidAt: true, periodFrom: true, periodTo: true,
            sellerId: true, seller: { select: { label: true } },
          },
        },
      },
    }),
    prisma.partner.findMany({ select: { id: true, name: true, rateFirstYear: true, rateAfter: true } }),
    prisma.lead.findMany({ where: { partnerId: { not: null } }, select: { stage: true, clubId: true } }),
  ]);

  const bundles = rows.length ? await loadClubMetrics(rows.map((c) => c.id), now) : new Map();

  const clubs: AClub[] = rows.map((c) => ({
    id: c.id,
    status: partnerClubStatus(c, now),
    priceMonthly: clubListPrice(c, (bundles.get(c.id) ?? EMPTY_BUNDLE).activeCourts).listPriceMonthly,
    trialEndsAt: c.trialEndsAt,
    partnerId: c.partnerId,
    partnerAttachedAt: c.partnerAttachedAt,
    invoices: c.invoices.map((i) => ({
      id: i.id, amount: i.amount, paidAt: i.paidAt, periodFrom: i.periodFrom, periodTo: i.periodTo,
      sellerId: i.sellerId, sellerLabel: i.seller?.label ?? null,
    })),
  }));

  const mrr = calcMrr(clubs);
  res.json({
    mrr,
    arr: calcArr(mrr),
    mrrByMonth: mrrByMonth(clubs, months, now),
    clubsByStatus: clubsByStatus(clubs),
    churn: churnByMonth(clubs, months, now),
    trialConversion: trialConversion(clubs, now),
    receivedByMonth: receivedByMonth(clubs, months, now),
    bySeller: bySeller(clubs, months, now),
    partnerChannel: partnerChannel(clubs, partners, leads, months, now),
    forecastNextQuarter: forecastNextQuarter(clubs, partners, now),
  });
});
