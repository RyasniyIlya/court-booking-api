import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { KNOWN_PROVIDERS, publicBase } from '../../lib/payments';
import { encryptSecret, paymentsSecretReady } from '../../lib/crypto';
import { requireAuth, requireLevel } from './shared';

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
      brandColor:
        club.brandColor,
      telegramChatId:
        club.telegramChatId,
      slotMinutes:
        club.slotMinutes,
      leadTimeMinutes:
        club.leadTimeMinutes,
      horizonDays:
        club.horizonDays,
      autoConfirm:
        club.autoConfirm,
      prepayEnabled:
        club.prepayEnabled,
      prepayRequired:
        club.prepayRequired,
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

        horizonDays:
          z.number()
            .int()
            .min(1)
            .max(90)
            .optional(),

        autoConfirm:
          z.boolean()
            .optional(),

        billingPeriod:
          z.enum([
            'MONTH',
            'QUARTER',
            'YEAR',
          ])
            .optional(),

        prepayEnabled:
          z.boolean()
            .optional(),

        prepayRequired:
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
      brandColor:
        club.brandColor,
      telegramChatId:
        club.telegramChatId,
      prepayEnabled:
        club.prepayEnabled,
      prepayRequired:
        club.prepayRequired,
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

