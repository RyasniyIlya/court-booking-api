import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { clubBilling, GRACE_DAYS, PERIOD_PRICE } from '../../lib/billing';
import { nextInvoiceNumbers, payToView, renderInvoiceHtml, sendInvoiceHtml } from '../../lib/clubInvoice';
import { loadDefaultSeller } from '../../lib/partnerRequisites';
import { nextPeriod, periodAmount } from '../../lib/subscription';
import { clubPrice, planFeatures, PLAN_SELECT } from '../../lib/plans';
import { courtMultiplier, courtPrice, isCustomQuote } from '../../lib/courtPricing';
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
          /* Без цього поля clubBilling бачить undefined і вважає, що пробного
             періоду немає взагалі: клуб на пробному читав би «не оплачено». */
          trialEndsAt: true,
          billingPeriod: true,
          isActive: true,
          createdAt: true,
          planPrice: true,
          name: true,
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

    /* Ціна залежить від кількості АКТИВНИХ кортів (lib/courtPricing.ts):
       кабінет має показати ту суму, яку клубу справді виставлять. */
    const activeCourts =
      await prisma.court.count({
        where: {
          clubId:
            req.auth!.clubId,
          isActive: true,
        },
      });

    /* Каталог планів — щоб кабінет показав усі тарифи, а не лише свій.
       Тільки активні: знятий з продажу план лишається у клуба, якому вже
       призначений (він приходить окремо в `plan`), але пропонувати його
       іншим нема сенсу. Порядок той самий, що й у платформи, інакше клуб
       і оператор бачили б різні списки. */
    const plans =
      await prisma.plan.findMany({
        where: {
          isActive: true,
        },

        orderBy: [
          { sortOrder: 'asc' },
          { tier: 'asc' },
        ],

        select: PLAN_SELECT,
      });

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
          number: true,
        },
      });

    /* Відкритий рахунок і реквізити для переказу. payTo: null — основний
       профіль отримувача не налаштований, кабінет покаже «зверніться до нас». */
    const openInvoice =
      await prisma.clubInvoice.findFirst({
        where: { clubId: req.auth!.clubId, status: 'ISSUED' },
        orderBy: { issuedAt: 'desc' },
        select: INVOICE_SELECT,
      });
    const seller = await loadDefaultSeller();
    const payTo = payToView(seller, openInvoice?.number ?? null, club.name);

    res.json({
      openInvoice,
      payTo,
      state: info.state,
      online: info.online,
      paidUntil:
        info.paidUntil,
      /* Пробний період окремими полями, а не підмішаний у paidUntil: клуб має
         бачити «пробний до 16.09», а не «оплачено до 16.09» за те, чого не
         платив. `until` — дата, від якої рахується daysLeft. */
      trialEndsAt:
        info.trialEndsAt,
      trial:
        info.trial,
      until:
        info.until,
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
      activeCourts,

      /* Поточна ціна за активні корти на поточному тарифі */
      courts: {
        active: activeCourts,
        monthlyPrice: clubPrice(club.plan, club.planPrice, activeCourts) ?? courtPrice(PERIOD_PRICE.MONTH, activeCourts),
      },

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
              price: clubPrice(club.plan, club.planPrice, activeCourts),
              /* Чи відрізняється від каталожної — кабінету знати корисно,
                 щоб не показувати «знижка» там, де її немає */
              customPrice: club.planPrice !== null,
            }
          : null,
      /* Каталог цілком. Ціну клубу сюди НЕ підставляємо: тут каталожна
         ціна, а індивідуальна домовленість видна в `plan.price` вище.
         Інакше власна знижка розповзлася б на чужі тарифи. */
      plans,

      features:
        planFeatures(club.plan),

      invoices,
    });
  },
);


const INVOICE_SELECT = {
  id: true,
  number: true,
  periodFrom: true,
  periodTo: true,
  amount: true,
  status: true,
  issuedAt: true,
  paidAt: true,
} as const;

const invoiceSchema = z.object({
  period: z.enum(['MONTH', 'QUARTER', 'YEAR']),
});

/**
 * POST /api/admin/billing/invoice  { period }
 *
 * Сума рахується на сервері тим самим шляхом, що й при зарахуванні оплати
 * оператором (periodAmount + nextPeriod), клієнт суму не передає. Один
 * відкритий рахунок на клуб: повтор віддає існуючий (200), новий — 201.
 */
billingRouter.post(
  '/billing/invoice',
  requireAuth,
  requireRole('OWNER'),
  async (req, res) => {
    const parsed = invoiceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const clubId = req.auth!.clubId;

    const existing = await prisma.clubInvoice.findFirst({
      where: { clubId, status: 'ISSUED' },
      orderBy: { issuedAt: 'desc' },
      select: INVOICE_SELECT,
    });
    if (existing) return res.status(200).json({ invoice: existing, created: false });

    const club = await prisma.club.findUnique({
      where: { id: clubId },
      select: {
        id: true,
        paidUntil: true,
        planPrice: true,
        plan: { select: PLAN_SELECT },
        _count: { select: { courts: { where: { isActive: true } } } },
      },
    });
    if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

    const { period } = parsed.data;
    const { from, to } = nextPeriod(club.paidUntil, period);
    const amount = periodAmount(club.plan, club.planPrice, period, club._count.courts);
    const seller = await loadDefaultSeller();
    const [number] = await nextInvoiceNumbers(1);

    const invoice = await prisma.clubInvoice.create({
      data: {
        clubId,
        periodFrom: from,
        periodTo: to,
        amount,
        status: 'ISSUED',
        ...(number ? { number } : {}),
        ...(seller ? { sellerId: seller.id } : {}),
      },
      select: INVOICE_SELECT,
    });

    res.status(201).json({ invoice, created: true });
  },
);

/** GET /api/admin/billing/invoice/:id/html — друкована форма (OWNER, ADMIN). */
billingRouter.get(
  '/billing/invoice/:id/html',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const row = await prisma.clubInvoice.findFirst({
      where: { id, clubId: req.auth!.clubId },
      select: {
        ...INVOICE_SELECT,
        club: { select: { name: true, legalName: true, legalCode: true } },
        seller: { select: { legalName: true, code: true, taxInfo: true, iban: true, bankName: true, address: true } },
      },
    });
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });

    sendInvoiceHtml(res, renderInvoiceHtml(row, row.club, row.seller));
  },
);

const pricePreviewSchema = z.object({
  courts: z.coerce.number().int().min(1).max(50),
  plan: z.string().optional(),
});

/**
 * GET /api/admin/billing/price-preview?courts=N&plan=code
 *
 * Показ калькулятора в кабінеті: скільки буде коштувати місяць при іншій
 * кількості кортів на поточному тарифі. Кортів від 1 до 50; план — дефолт
 * до плану клубу. Вертає розрахунок ціни по формулі courtPricing, без
 * округлення й множень на період. Індивідуальна ціна не множиться,
 * використовується як є.
 */
billingRouter.get(
  '/billing/price-preview',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const parsed = pricePreviewSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const clubId = req.auth!.clubId;
    const { courts, plan: planCode } = parsed.data;

    const club = await prisma.club.findUnique({
      where: { id: clubId },
      select: {
        plan: { select: PLAN_SELECT },
        planPrice: true,
        _count: { select: { courts: { where: { isActive: true } } } },
      },
    });

    if (!club) return res.status(404).json({ error: 'NOT_FOUND' });

    let selectedPlan = club.plan;
    if (planCode && planCode !== club.plan?.code) {
      selectedPlan = await prisma.plan.findUnique({
        where: { code: planCode },
        select: PLAN_SELECT,
      });
      if (!selectedPlan) return res.status(400).json({ error: 'PLAN_NOT_FOUND' });
    }

    /* Активні корти клубу сейчас */
    const currentCourts = club._count.courts;

    /* Базова ціна для обраного плану */
    const basePrice = selectedPlan?.price ?? PERIOD_PRICE.MONTH;

    /* Множник за кількість кортів */
    const multiplier = courtMultiplier(courts);

    /* Розрахована ціна за місяц */
    const monthlyPrice = club.planPrice !== null && club.planPrice !== undefined
      ? club.planPrice
      : courtPrice(basePrice, courts);

    res.json({
      courts,
      plan: selectedPlan
        ? {
            code: selectedPlan.code,
            name: selectedPlan.name,
          }
        : null,
      basePrice,
      multiplier,
      monthlyPrice,
      customQuote: isCustomQuote(courts),
      /* Індивідуальна ціна клубу (Club.planPrice) від кортів не залежить —
         кабінет має сказати це прямо, а не мовчки показати ту саму суму. */
      fixedPrice: club.planPrice !== null && club.planPrice !== undefined,
      current: {
        courts: currentCourts,
        monthlyPrice: club.planPrice !== null && club.planPrice !== undefined
          ? club.planPrice
          : courtPrice(basePrice, currentCourts),
      },
    });
  },
);
