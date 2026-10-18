import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { sportsSchema } from '../../lib/sport';

import { prisma } from '../../lib/db';
import { KNOWN_PROVIDERS, providerFor, publicBase } from '../../lib/payments';
import { encryptSecret, paymentsSecretReady } from '../../lib/crypto';
import { requireAuth, requireStaff, requireRole } from './shared';
import { logoSrcOf } from '../public';
import { liqPayKeys } from '../../lib/payments/liqpay';
import { wayForPayKeys } from '../../lib/payments/wayforpay';
import { stripeKeys } from '../../lib/payments/stripe';
import { BACKDROP_STYLES } from '../../lib/backdrop';
import { Prisma } from '@prisma/client';
import { LEGAL_VERSION } from '../../lib/legal';
import { recordChanges } from '../../lib/changeLog';
import { analyticsThresholdsSchema, readAnalyticsThresholds } from '../../lib/analyticsThresholds';

export const clubRouter = Router();

/** Юридичні поля клубу для кабінету (GET і відповідь PATCH). */
function legalFields(club: {
  offerAcceptedAt: Date | null; offerVersion: string | null; legalName: string | null;
  legalCode: string | null; legalAddress: string | null; email: string | null;
  lateCancelFeePercent: number; refundDays: number; extraRules: string | null;
}) {
  return {
    offerAcceptedAt: club.offerAcceptedAt,
    offerVersion: club.offerVersion,
    legalVersion: LEGAL_VERSION,
    legalName: club.legalName,
    legalCode: club.legalCode,
    legalAddress: club.legalAddress,
    email: club.email,
    lateCancelFeePercent: club.lateCancelFeePercent,
    refundDays: club.refundDays,
    extraRules: club.extraRules,
  };
}

/* CLUB                                                                       */
/* -------------------------------------------------------------------------- */

clubRouter.get(
  '/club',
  requireAuth,
  async (req, res) => {
    const club =
      await prisma.club.findUnique({
        where: {
          id: req.auth!.clubId,
        },
        include: { partner: { select: { company: true, name: true } } },
      });

    if (!club) {
      return res.status(404).json({
        error: 'NOT_FOUND',
      });
    }

    res.json({
      shareStatsWithPartner: club.shareStatsWithPartner,
      hasPartner: Boolean(club.partnerId),
      partnerCompany: club.partner ? (club.partner.company ?? club.partner.name) : null,
      name: club.name,
      slug: club.slug,
      sports: club.sports,
      defaultSetsToWin: club.defaultSetsToWin,
      timezone: club.timezone,
      phone: club.phone,
      address: club.address,
      logoUrl: club.logoUrl,
      /* Кабінет показує ТОЙ САМИЙ логотип, що й віджет, тому адреса
         рахується спільною функцією. logoMode іде окремо: перемикач у
         майстрі має знати справжній стан, а не вгадувати його з того,
         порожня адреса чи ні. */
      logoSrc: logoSrcOf(club),
      logoMode: club.logoMode,
      hasLogoFile: Boolean(club.logoMime),
      brandColor:
        club.brandColor,
      cabinetBackdrop: club.cabinetBackdrop,
      pageBackdrop: club.pageBackdrop,
      telegramChatId:
        club.telegramChatId,
      slotMinutes:
        club.slotMinutes,
      leadTimeMinutes:
        club.leadTimeMinutes,
      cancelCutoffMinutes:
        club.cancelCutoffMinutes,
      horizonDays:
        club.horizonDays,
      autoConfirm:
        club.autoConfirm,
      prepayEnabled:
        club.prepayEnabled,
      prepayRequired:
        club.prepayRequired,

      /* Абонементи. Вимикач, а не наявність тарифів: клуб може завести
         тарифи заздалегідь і ввімкнути продаж із понеділка. */
      passesEnabled:
        club.passesEnabled,

      paymentProvider:
        club.paymentProvider,
      payHoldMinutes:
        club.payHoldMinutes,

      hasPaymentToken:
        Boolean(
          club.paymentTokenEnc,
        ),

      webhookUrl:
        `${publicBase()}/api/pay/webhook/${club.id}`,
      /* Власнику Stripe цю адресу треба вставити в Dashboard самому. */
      paymentWebhookUrl:
        `${publicBase()}/api/pay/webhook/${club.id}`,

      approvedAt:
        club.approvedAt,

      paidUntil:
        club.paidUntil,

      isActive:
        club.isActive,

      /* Податковий режим — тільки перегляд тут. Міняють його лише власник
         і бухгалтер через PATCH /api/admin/finance/tax-regime: модератор
         клуб веде, але режим оподаткування визначає той, хто рахує
         податок, а не той, хто веде зміну. Кабінет показує кнопку
         редагування лише a.editTaxRegime. */
      taxRegime:
        club.taxRegime,
      vatPayer:
        club.vatPayer,
      taxFixedMonthly:
        club.taxFixedMonthly,

      /* Цілі аналітики: бачить увесь персонал, міняє лише власник. */
      analyticsThresholds:
        readAnalyticsThresholds(club.analyticsThresholds),

      ...legalFields(club),
    });
  },
);

clubRouter.patch(
  '/club',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const parsed = z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .optional(),

        phone:
          z.string()
            .trim()
            .max(30)
            .nullable()
            .optional(),

        address:
          z.string()
            .trim()
            .max(200)
            .nullable()
            .optional(),

        logoUrl:
          z.string()
            .trim()
            .max(500)
            .regex(/^https:\/\/\S+$/)
            .nullable()
            .optional(),

        /* Що показувати: літери чи картинку. Окремо від самого файлу —
           клуб може лишити логотип завантаженим і тимчасово повернутись
           до монограми, не втрачаючи файл. */
        logoMode:
          z.enum([
            'MONOGRAM',
            'IMAGE',
          ])
            .optional(),

        telegramChatId:
          z.string()
            .trim()
            .max(60)
            .nullable()
            .optional(),

        brandColor:
          z.string()
            .trim()
            .regex(
              /^#[0-9A-Fa-f]{6}$/,
            )
            .nullable()
            .optional(),

        /* Фон — тільки з білого списку (enum і в базі, і тут). Значення
           потрапляє у верстку віджета й кабінету, тож довільний рядок
           сюди не пройде навіть до бази. */
        cabinetBackdrop:
          z.enum(BACKDROP_STYLES).optional(),

        pageBackdrop:
          z.enum(BACKDROP_STYLES).optional(),

        timezone:
          z.string()
            .trim()
            .max(64)
            /* IANA-зона має бути справжньою: з довільним рядком luxon дає Invalid DateTime, і розклад, зведення
               та ранкова сводка клубу ламаються мовчки. */
            .refine((tz) => DateTime.local().setZone(tz).isValid, 'invalid timezone')
            .optional(),

        /* Види спорту клубу (Падел/Теніс/Сквош). */
        sports: sportsSchema.optional(),

        /* Формат матчу за замовчуванням: до скількох виграних сетів. */
        defaultSetsToWin: z.number().int().min(1).max(3).optional(),

        slotMinutes:
          z.number()
            .int()
            .min(15)
            .max(180)
            .optional(),

        leadTimeMinutes:
          z.number()
            .int()
            .min(0)
            .max(1440)
            .optional(),

        /* Вікно самостійного скасування. Стеля доби: більше означало б
           «скасувати не можна взагалі», і чесніше сказати це словами,
           ніж числом, у яке гравець не вчитається. */
        cancelCutoffMinutes:
          z.number()
            .int()
            .min(0)
            .max(1440)
            .optional(),

        horizonDays:
          z.number()
            .int()
            .min(1)
            .max(90)
            .optional(),

        autoConfirm:
          z.boolean()
            .optional(),

        /* billingPeriod звідси прибраний навмисно. Період і план тепер
           задає оператор платформи (PATCH /api/platform/clubs/:id) після
           того, як домовився з клубом і отримав гроші. Кабінет їх тільки
           показує.

           Zod тут working у strip-режимі, тож поле просто відкидається:
           старий клієнт, який ще шле billingPeriod, отримає 200 і решту
           збережених полів, а не 400 на весь запит. */

        prepayEnabled:
          z.boolean()
            .optional(),

        prepayRequired:
          z.boolean()
            .optional(),

        /* Не в переліку платіжних полів нижче навмисно: абонемент — це
           готівка на ресепшені, наш еквайринг у ньому не бере участі,
           тож і третій рівень доступу для галочки ні до чого. */
        passesEnabled:
          z.boolean()
            .optional(),

        paymentProvider:
          z.enum(
            KNOWN_PROVIDERS,
          )
            .nullable()
            .optional(),

        payHoldMinutes:
          z.number()
            .int()
            .min(5)
            .max(60)
            .optional(),

        paymentToken:
          z.string()
            .trim()
            .min(10)
            .max(600)
            .nullable()
            .optional(),

        /* Юридичні реквізити для Правил клубу (docs/legal). */
        legalName: z.string().trim().max(200).nullable().optional(),
        legalCode: z.string().trim().max(20).nullable().optional(),
        legalAddress: z.string().trim().max(300).nullable().optional(),
        email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
        lateCancelFeePercent: z.number().int().min(0).max(50).optional(),
        refundDays: z.number().int().min(1).max(60).optional(),
        extraRules: z.string().trim().max(3000).nullable().optional(),

        /* null скидає до дефолтів веб-клієнта. */
        analyticsThresholds:
          analyticsThresholdsSchema
            .nullable()
            .optional(),
      })
      .safeParse(
        req.body,
      );

    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
      });
    }

    const {
      paymentToken,
      analyticsThresholds,
      ...rest
    } = parsed.data;

    // Цілі аналітики міняє тільки власник; модератор їх лише бачить.
    if (analyticsThresholds !== undefined && req.auth!.role !== 'OWNER') {
      return res.status(403).json({
        error: 'FORBIDDEN',
        requiredRole: ['OWNER'],
      });
    }

    // Порівнюємо зі СПРАВЖНІМИ значеннями в базі, а не з тим, чи поле
    // взагалі є в тілі запиту: майстер клубу (ClubSetupWizard) шле club
    // одним цільним обʼєктом і завжди включає ці поля, навіть коли їх
    // ніхто не чіпав — інакше рівень 3 вимагався б навіть для зміни
    // назви клубу через майстер.
    const current = await prisma.club.findUnique({
      where: { id: req.auth!.clubId },
      select: {
        prepayEnabled: true,
        prepayRequired: true,
        paymentProvider: true,
        payHoldMinutes: true,
        paymentTokenEnc: true,
      },
    });

    const paymentFieldsTouched =
      // Сам токен порівняти нема з чим (у базі він шифрований) — будь-яка
      // спроба його передати вважається зміною.
      paymentToken !== undefined ||
      (rest.prepayEnabled !== undefined && rest.prepayEnabled !== current?.prepayEnabled) ||
      (rest.prepayRequired !== undefined && rest.prepayRequired !== current?.prepayRequired) ||
      (rest.paymentProvider !== undefined && rest.paymentProvider !== current?.paymentProvider) ||
      (rest.payHoldMinutes !== undefined && rest.payHoldMinutes !== current?.payHoldMinutes);

    // Платіжну інтеграцію змінює тільки власник. Окремого рівня доступу
    // більше немає: роль акаунта є єдиним джерелом прав.
    if (paymentFieldsTouched && req.auth!.role !== 'OWNER') {
      return res.status(403).json({
        error: 'FORBIDDEN',
        requiredRole: ['OWNER'],
      });
    }

    const enabled = rest.prepayEnabled ?? current?.prepayEnabled;
    const provider = rest.paymentProvider !== undefined ? rest.paymentProvider : current?.paymentProvider;
    // Ці провайдери беруть набір ключів JSON-рядком; одинокий старий токен їм не підходить.
    const credentialCheck = { liqpay: liqPayKeys, wayforpay: wayForPayKeys, stripe: stripeKeys }[provider as string];
    if (credentialCheck && paymentToken) {
      try { credentialCheck(paymentToken); }
      catch { return res.status(400).json({ error: 'PAYMENT_CREDENTIALS_INVALID' }); }
    }
    // One credential set per club: keep it available to outstanding callbacks
    // and refunds. A provider switch is not an automatic per-payment fallback.
    const replacingCredentials = current?.paymentTokenEnc &&
      (provider !== current.paymentProvider || paymentToken !== undefined);
    if (replacingCredentials && await prisma.payment.count({
      where: { clubId: req.auth!.clubId, status: { in: ['PENDING', 'PAID'] } },
    })) return res.status(409).json({ error: 'PAYMENT_PROVIDER_IN_USE' });
    const hasToken = paymentToken !== undefined
      ? Boolean(paymentToken)
      : Boolean(current?.paymentTokenEnc) && provider === current?.paymentProvider;
    if (paymentFieldsTouched && enabled && (!provider || (provider !== 'mock' && !hasToken))) {
      return res.status(400).json({ error: 'PAYMENTS_NOT_CONFIGURED' });
    }

    /* Перевірки на billingPeriod тут більше немає: поле прибране зі схеми
       вище, тож дійти сюди воно не може. Період і план клубу задає тільки
       оператор платформи — і власник, і модератор їх лише бачать. */

    const data: Record<
      string,
      unknown
    > = {
      ...rest,
    };

    if (analyticsThresholds !== undefined) {
      data.analyticsThresholds = analyticsThresholds === null ? Prisma.DbNull : analyticsThresholds;
    }

    if (provider !== current?.paymentProvider && paymentToken === undefined) {
      data.paymentTokenEnc = null;
    }

    if (
      paymentToken !== undefined
    ) {
      if (
        paymentToken === null
      ) {
        data.paymentTokenEnc =
          null;
      } else {
        if (
          !paymentsSecretReady()
        ) {
          return res.status(503).json({
            error:
              'PAYMENTS_SECRET_MISSING',
          });
        }

        data.paymentTokenEnc =
          encryptSecret(
            paymentToken,
          );
      }
    }

    if (rest.timezone) {
      const current =
        await prisma.club.findUnique({
          where: {
            id: req.auth!.clubId,
          },
          select: {
            timezone: true,
          },
        });

      if (
        current &&
        current.timezone !==
          rest.timezone
      ) {
        const bookings =
          await prisma.booking.count({
            where: {
              clubId:
                req.auth!.clubId,
            },
          });

        if (bookings > 0) {
          return res.status(409).json({
            error:
              'TIMEZONE_LOCKED',
          });
        }
      }
    }

    const club =
      await prisma.club.update({
        where: {
          id: req.auth!.clubId,
        },
        data,
      });

    res.json({
      name: club.name,
      slug: club.slug,
      phone: club.phone,
      address:
        club.address,
      logoUrl:
        club.logoUrl,
      logoSrc: logoSrcOf(club),
      logoMode: club.logoMode,
      hasLogoFile: Boolean(club.logoMime),
      brandColor:
        club.brandColor,
      cabinetBackdrop: club.cabinetBackdrop,
      pageBackdrop: club.pageBackdrop,
      telegramChatId:
        club.telegramChatId,
      prepayEnabled:
        club.prepayEnabled,
      prepayRequired:
        club.prepayRequired,

      /* Абонементи. Вимикач, а не наявність тарифів: клуб може завести
         тарифи заздалегідь і ввімкнути продаж із понеділка. */
      passesEnabled:
        club.passesEnabled,

      paymentProvider:
        club.paymentProvider,
      payHoldMinutes:
        club.payHoldMinutes,
      hasPaymentToken:
        Boolean(
          club.paymentTokenEnc,
        ),
      webhookUrl:
        `${publicBase()}/api/pay/webhook/${club.id}`,
      paymentWebhookUrl:
        `${publicBase()}/api/pay/webhook/${club.id}`,
      analyticsThresholds:
        readAnalyticsThresholds(club.analyticsThresholds),
      ...legalFields(club),
    });
  },
);

/**
 * PUT /api/admin/club/share-stats — згода власника показувати партнеру-будівельнику
 * агрегати кортів (години, %). Тільки OWNER; лише коли в клубу є партнер.
 */
clubRouter.put(
  '/club/share-stats',
  requireAuth,
  requireRole('OWNER'),
  async (req, res) => {
    const parsed = z.object({ share: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
    const clubId = req.auth!.clubId;
    const club = await prisma.club.findUnique({
      where: { id: clubId },
      select: { partnerId: true, shareStatsWithPartner: true },
    });
    if (!club) return res.status(404).json({ error: 'NOT_FOUND' });
    if (!club.partnerId) return res.status(409).json({ error: 'NO_PARTNER' });
    const share = parsed.data.share;
    if (club.shareStatsWithPartner !== share) {
      await prisma.club.update({ where: { id: clubId }, data: { shareStatsWithPartner: share, shareStatsChangedAt: new Date() } });
      const who = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { email: true, role: true } });
      await recordChanges(
        prisma,
        { clubId, entity: 'CLUB', entityId: clubId },
        { userId: req.auth!.userId, email: who?.email ?? '', role: who?.role ?? req.auth!.role },
        [{ field: 'shareStatsWithPartner', before: club.shareStatsWithPartner, after: share }],
      ).catch((e) => console.error('[change log] share-stats', e));
    }
    res.json({ shareStatsWithPartner: share });
  },
);

/**
 * POST /api/admin/club/accept-offer — власник приймає оферту й умови
 * обробки ПД. Фіксуємо дату й версію документів (lib/legal.ts).
 */
clubRouter.post(
  '/club/accept-offer',
  requireAuth,
  requireRole('OWNER'),
  async (req, res) => {
    const club = await prisma.club.update({
      where: { id: req.auth!.clubId },
      data: { offerAcceptedAt: new Date(), offerVersion: LEGAL_VERSION },
      select: { offerAcceptedAt: true, offerVersion: true },
    });
    res.json({ offerAcceptedAt: club.offerAcceptedAt, offerVersion: club.offerVersion, legalVersion: LEGAL_VERSION });
  },
);

/* PAYMENT TEST                                                               */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/admin/club/payment-test
 *
 * Перевірка еквайрингу до першої справжньої броні.
 *
 * Навіщо. Токен вводиться руками з кабінету банку, а помиляються в ньому
 * легко — зайвий пробіл, обрізаний хвіст, узятий не з того мерчанта.
 * Досі клуб дізнавався про це в найгіршу мить: перший гравець тисне
 * «Оплатити», бек не може виставити рахунок і віддає 502, слот
 * звільняється, а на екрані — «Оплата тимчасово недоступна». Тут те саме
 * робиться завчасно й тихо: виставляємо рахунок на 1 грн і одразу гасимо.
 *
 * Рахунок НЕ зберігається в Payment: там `bookingId` обов'язковий, та й
 * платіж без броні у звітності клубу — сміття. Це разова перевірка того,
 * що банк узагалі відповідає на цей токен.
 *
 * Рівень 3, як і сама прив'язка токена: перевірка ходить у банк від імені
 * клубу, і давати її тому, кому не можна міняти токен, немає підстав.
 */
clubRouter.post(
  '/club/payment-test',
  requireAuth,
  requireRole('OWNER'),
  async (req, res) => {
    const club = await prisma.club.findUnique({
      where: { id: req.auth!.clubId },
      select: {
        id: true,
        name: true,
        paymentProvider: true,
        paymentTokenEnc: true,
      },
    });

    if (!club) {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }

    const provider = providerFor(club);

    if (!provider) {
      // Причин рівно три, і клубу треба знати яку саме: провайдер не
      // обраний, токен не введений, або токен не розшифрувався (змінили
      // PAYMENTS_SECRET). Розрізняє їх providerFor, але назовні різниця
      // одна: платити зараз неможливо.
      return res.status(400).json({
        error: 'PAYMENTS_NOT_CONFIGURED',
        hasProvider: Boolean(club.paymentProvider),
        hasToken: Boolean(club.paymentTokenEnc),
      });
    }

    try {
      if (provider.testConnection) {
        await provider.testConnection();
        return res.json({ ok: true, provider: provider.name });
      }
      const invoice = await provider.createInvoice({
        amountKop: 100,
        reference: `test-${club.id}`,
        destination: `${club.name}: перевірка еквайрингу`,
        redirectUrl: `${publicBase()}/api/pay/done`,
        webHookUrl: `${publicBase()}/api/pay/webhook/${club.id}`,
        ttlSeconds: 300,
      });

      // Гасимо одразу: рахунок нікому не показувався і висіти в кабінеті
      // банку йому нема чого. Якщо не вийшло — не біда, він протухне сам
      // за п'ять хвилин, а перевірку ми вже провели.
      void provider
        .cancelUnpaid(invoice.providerRef)
        .catch((e) => console.warn('[pay] test cancel', (e as Error).message));

      return res.json({
        ok: true,
        provider: provider.name,
      });
    } catch (e) {
      console.error('[pay] перевірка токена не пройшла', e);

      return res.status(502).json({
        error: 'PAYMENT_TEST_FAILED',
        provider: provider.name,
      });
    }
  },
);
