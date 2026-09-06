import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { KNOWN_PROVIDERS, providerFor, publicBase } from '../../lib/payments';
import { encryptSecret, paymentsSecretReady } from '../../lib/crypto';
import { requireAuth, requireStaff, requireLevel } from './shared';
import { logoSrcOf } from '../public';

export const clubRouter = Router();

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
      });

    if (!club) {
      return res.status(404).json({
        error: 'NOT_FOUND',
      });
    }

    res.json({
      name: club.name,
      slug: club.slug,
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

      approvedAt:
        club.approvedAt,

      paidUntil:
        club.paidUntil,

      isActive:
        club.isActive,
    });
  },
);

clubRouter.patch(
  '/club',
  requireAuth,
  requireStaff,
  requireLevel(2),
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

        timezone:
          z.string()
            .trim()
            .max(64)
            .optional(),

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
            .max(400)
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
      ...rest
    } = parsed.data;

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

    // Платіжна інтеграція — гроші клубу йдуть повз нас напряму на його
    // еквайринг, тому переприв'язати токен має право тільки LEVEL 3.
    if (paymentFieldsTouched && req.auth!.level < 3) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        requiredLevel: 3,
        currentLevel: req.auth!.level,
      });
    }

    const enabled = rest.prepayEnabled ?? current?.prepayEnabled;
    const provider = rest.paymentProvider !== undefined ? rest.paymentProvider : current?.paymentProvider;
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
    });
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
  requireStaff,
  requireLevel(3),
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
