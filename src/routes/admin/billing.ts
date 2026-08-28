import { Router } from 'express';

import { prisma } from '../../lib/db';
import { clubBilling, GRACE_DAYS, PERIOD_PRICE } from '../../lib/billing';
import { clubPrice, planFeatures, PLAN_SELECT } from '../../lib/plans';
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
          planPrice: true,
          plan: { select: PLAN_SELECT },
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

      /* План клуб тільки ДИВИТЬСЯ. Обирає й призначає оператор платформи
         після оплати, тому жодного PATCH на план з боку кабінету немає —
         ні тут, ні в club.ts. Раніше власник перемикав період оплати сам,
         але це не вмикало нічого, крім суми на кнопці: реальний доступ
         рахує paidUntil, а тепер ще й план. Перемикач, який ні на що не
         впливає, гірший за його відсутність — він обіцяє контроль, якого
         немає.

         plan: null — клуб без призначеного плану. Це не помилка й не
         обмеження: так виглядають усі клуби, заведені до появи планів
         (див. src/lib/plans.ts). */
      plan:
        club.plan
          ? {
              ...club.plan,
              /* Ціна саме для цього клубу: індивідуальна б'є ціну плану */
              price: clubPrice(club.plan, club.planPrice),
              /* Чи відрізняється від каталожної — кабінету знати корисно,
                 щоб не показувати «знижка» там, де її немає */
              customPrice: club.planPrice !== null,
            }
          : null,
      features:
        planFeatures(club.plan),

      invoices,
    });
  },
);

