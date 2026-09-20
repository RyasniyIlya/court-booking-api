import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { SKILL_LEVELS } from '../../lib/openMatch';
import { isSearchableTail } from '../../lib/phone';
import { getActivePass, getActivePasses } from '../../lib/customers';
import { requireAuth, requireStaff, requireRole, param } from './shared';
import { birthDateText, birthDateValue, dateOnly } from '../../lib/birthday';

export const customersRouter = Router();

/* CUSTOMERS                                                                  */
/* -------------------------------------------------------------------------- */

customersRouter.get(
  '/customers',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  async (req, res) => {
    const parsed = z
      .object({
        q: z
          .string()
          .trim()
          .min(2)
          .max(40),
      })
      .safeParse(
        req.query,
      );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          'BAD_REQUEST',
      });
    }

    const q =
      parsed.data.q;

    const digits =
      q.replace(
        /\D/g,
        '',
      );

    const where =
      digits.length >= 4 &&
      isSearchableTail(
        digits,
      )
        ? {
            clubId:
              req.auth!.clubId,
            phoneTail: {
              endsWith:
                digits.slice(
                  -7,
                ),
            },
          }
        : {
            clubId:
              req.auth!.clubId,
            name: {
              contains: q,
              mode:
                'insensitive' as const,
            },
          };

    const customers =
      await prisma.customer.findMany({
        where,
        take: 10,
        orderBy: {
          name:
            'asc',
        },
      });

    const passes =
      await getActivePasses(
        customers.map(
          (c) => c.id,
        ),
      );

    res.json(
      customers.map(
        (c) => ({
          id: c.id,
          name: c.name,
          phone: c.phone,
          isBlocked:
            c.isBlocked,
          note: c.note,
          birthDate: dateOnly(c.birthDate),
          discountPercent: c.discountPercent,
          bonusBalance: c.bonusBalance,
          pass:
            passes.get(
              c.id,
            ) ?? null,
        }),
      ),
    );
  },
);

/* -------------------------------------------------------------------------- */
/* PASSES                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Видати абонемент клієнту.
 *
 * Дві дороги в один бік. Звичайна — `planId`: модератор обирає тариф,
 * який власник виставив у налаштуваннях, і всі умови (скільки занять,
 * на скільки днів, почому) приїжджають звідти. Друга — умови руками:
 * вона була тут до появи тарифів і лишається для домовленостей, під які
 * заводити тариф безглуздо.
 *
 * `price` можна передати й разом із тарифом — це та сама домовлена ціна:
 * постійному клієнту зробили знижку, а окремий тариф «8 занять дешевше»
 * ніхто заводити не буде. Записується саме сплачене, а не прейскурант.
 */
customersRouter.post(
  '/customers/:id/passes',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const parsed = z
      .object({
        /* Тариф із налаштувань. Є він — решта умов необовʼязкова. */
        planId:
          z.string()
            .uuid()
            .optional(),

        type: z.enum([
          'PACKAGE',
          'UNLIMITED',
        ])
          .optional(),

        totalSessions:
          z.number()
            .int()
            .min(1)
            .max(200)
            .nullable()
            .optional(),

        validFrom:
          z.string()
            .datetime({
              offset: true,
            })
            .optional(),

        validUntil:
          z.string()
            .datetime({
              offset: true,
            })
            .optional(),

        price:
          z.number()
            .int()
            .min(0)
            .optional(),
      })
      .safeParse(
        req.body,
      );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          'BAD_REQUEST',
      });
    }

    const d =
      parsed.data;

    const customer =
      await prisma.customer.findFirst({
        where: {
          id: param(
            req,
            'id',
          ),

          clubId:
            req.auth!.clubId,
        },
      });

    if (!customer) {
      return res.status(404).json({
        error:
          'NOT_FOUND',
      });
    }

    /* Умови абонемента: з тарифу або з тіла запиту.
       Строк від тарифу рахується від ДНЯ ВИДАЧІ, а не від початку доби
       клубу: людина заплатила зараз і має ходити рівно стільки днів,
       скільки написано на тарифі. */
    let terms: {
      type: 'PACKAGE' | 'UNLIMITED';
      totalSessions: number | null;
      validFrom: Date;
      validUntil: Date;
      price: number;
    };

    if (d.planId) {
      const plan =
        await prisma.passPlan.findFirst({
          where: {
            id: d.planId,
            clubId:
              req.auth!.clubId,
          },
        });

      if (!plan) {
        return res.status(404).json({
          error:
            'PLAN_NOT_FOUND',
        });
      }

      /* Прибраний зі списку тариф видати не можна. Інакше стара вкладка,
         відкрита з учора, продавала б те, чого клуб більше не продає. */
      if (!plan.isActive) {
        return res.status(409).json({
          error:
            'PLAN_INACTIVE',
        });
      }

      const from = d.validFrom
        ? new Date(d.validFrom)
        : new Date();

      terms = {
        type: plan.type,
        totalSessions:
          plan.totalSessions,
        validFrom: from,
        validUntil:
          new Date(
            from.getTime() +
            plan.days * 86_400_000,
          ),
        // Домовлена ціна важливіша за прейскурант — але тільки якщо її
        // справді передали. Нуль — це теж рішення («подарували»).
        price:
          d.price ?? plan.price,
      };
    } else {
      if (
        !d.type ||
        !d.validFrom ||
        !d.validUntil
      ) {
        return res.status(400).json({
          error:
            'TERMS_REQUIRED',
        });
      }

      if (
        d.type ===
          'PACKAGE' &&
        !d.totalSessions
      ) {
        return res.status(400).json({
          error:
            'SESSIONS_REQUIRED',
        });
      }

      terms = {
        type: d.type,
        totalSessions:
          d.type === 'PACKAGE'
            ? d.totalSessions!
            : null,
        validFrom:
          new Date(d.validFrom),
        validUntil:
          new Date(d.validUntil),
        price: d.price ?? 0,
      };
    }

    if (
      terms.validUntil <=
      terms.validFrom
    ) {
      return res.status(400).json({
        error:
          'BAD_PERIOD',
      });
    }

    const pass =
      await prisma.pass.create({
        data: {
          clubId:
            req.auth!.clubId,

          customerId:
            customer.id,

          type:
            terms.type,

          totalSessions:
            terms.totalSessions,

          validFrom:
            terms.validFrom,

          validUntil:
            terms.validUntil,

          price:
            terms.price,
        },
      });

    res.status(201).json(
      pass,
    );
  },
);

/* -------------------------------------------------------------------------- */
/* USE PASS                                                                   */
/* -------------------------------------------------------------------------- */

customersRouter.post(
  '/bookings/:id/use-pass',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const booking =
      await prisma.booking.findFirst({
        where: {
          id: param(
            req,
            'id',
          ),

          clubId:
            req.auth!.clubId,
        },
      });

    if (
      !booking ||
      !booking.customerId
    ) {
      return res.status(404).json({
        error:
          'NOT_FOUND',
      });
    }

    const existing =
      await prisma.passUsage.findUnique({
        where: {
          bookingId:
            booking.id,
        },
      });

    if (
      existing &&
      !existing.revertedAt
    ) {
      return res.status(409).json({
        error:
          'ALREADY_USED',
      });
    }

    const balance =
      await getActivePass(
        booking.customerId,
        booking.startTime,
      );

    if (!balance) {
      return res.status(409).json({
        error:
          'NO_ACTIVE_PASS',
      });
    }

    await prisma.$transaction([
      prisma.pass.update({
        where: {
          id:
            balance.passId,
        },

        data: {
          usedSessions: {
            increment:
              1,
          },
        },
      }),

      prisma.passUsage.create({
        data: {
          passId:
            balance.passId,

          bookingId:
            booking.id,

          by:
            req.auth!.userId,
        },
      }),
    ]);

    res.json({
      ok: true,
      left:
        balance.left === null
          ? null
          : balance.left - 1,
    });
  },
);

customersRouter.delete(
  '/bookings/:id/use-pass',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const usage =
      await prisma.passUsage.findUnique({
        where: {
          bookingId:
            param(
              req,
              'id',
            ),
        },

        include: {
          pass: true,
        },
      });

    if (
      !usage ||
      usage.revertedAt ||
      usage.pass.clubId !==
        req.auth!.clubId
    ) {
      return res.status(404).json({
        error:
          'NOT_FOUND',
      });
    }

    await prisma.$transaction([
      prisma.pass.update({
        where: {
          id:
            usage.passId,
        },

        data: {
          usedSessions: {
            decrement:
              1,
          },
        },
      }),

      prisma.passUsage.update({
        where: {
          id:
            usage.id,
        },

        data: {
          revertedAt:
            new Date(),
        },
      }),
    ]);

    res.json({
      ok: true,
    });
  },
);


/**
 * PATCH /api/admin/customers/:id — картка клієнта: мітки, замітка, чорний список.
 *
 * До цього ці три поля існували в схемі, але змінити їх не було чим:
 * `note` і `isBlocked` заповнювались хіба що руками в базі. Мітки без
 * такого роуту були б так само мертві.
 *
 * Рівень 2, як і решта змін у кабінеті: «боржник» на картці — це те, що
 * побачить наступна зміна адміністраторів, і ставити його з відкритого
 * ноутбука на ресепшені без авторизації не варто.
 */
customersRouter.patch(
  '/customers/:id',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const parsed = z
      .object({
        /* Мітки приходять цілим списком, а не по одній: так у кабінеті
           не потрібні окремі «додати» й «прибрати», а гонка двох вкладок
           закінчується останнім збереженням, а не половиною списку. */
        /* Порожні рядки тут НЕ відхиляються: кабінет надсилає список
           цілком, і випадковий пробіл у полі не має валити збереження
           решти міток. Чистка нижче — вона ж прибирає дублі. */
        tags: z
          .array(z.string().max(40))
          .max(20)
          .optional(),
        note: z.string().trim().max(1000).nullable().optional(),
        isBlocked: z.boolean().optional(),
        requiresPrepay: z.boolean().optional(),
        birthDate: birthDateText.nullable().optional(),
        discountPercent: z.number().int().min(0).max(90).optional(),
        /* Ігровий рівень: його питають на ресепшені один раз, а далі він
           вирішує, кого кликати у відкриті ігри. nullable — рівень можна
           й зняти, якщо поставили навмання. */
        skillLevel: z.enum(SKILL_LEVELS).nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const d = parsed.data;
    if (d.tags === undefined && d.note === undefined && d.isBlocked === undefined && d.requiresPrepay === undefined && d.birthDate === undefined && d.discountPercent === undefined && d.skillLevel === undefined) {
      return res.status(400).json({ error: 'NOTHING_TO_UPDATE' });
    }

    // Дублі й порожні мітки прибираємо тут, а не просимо кабінет стежити
    const tags = d.tags
      ? [...new Set(d.tags.map((t) => t.trim()).filter(Boolean))]
      : undefined;

    const { count } = await prisma.customer.updateMany({
      // clubId у where, а не окремою перевіркою: чужу картку не видно й не змінити
      where: { id: id.data, clubId: req.auth!.clubId },
      data: {
        ...(tags ? { tags } : {}),
        ...(d.note !== undefined ? { note: d.note } : {}),
        ...(d.isBlocked !== undefined ? { isBlocked: d.isBlocked } : {}),
        ...(d.requiresPrepay !== undefined ? { requiresPrepay: d.requiresPrepay } : {}),
        ...(d.birthDate !== undefined ? { birthDate: d.birthDate ? birthDateValue(d.birthDate) : null } : {}),
        ...(d.discountPercent !== undefined ? { discountPercent: d.discountPercent } : {}),
        ...(d.skillLevel !== undefined ? { skillLevel: d.skillLevel } : {}),
      },
    });
    if (count === 0) return res.status(404).json({ error: 'NOT_FOUND' });

    const customer = await prisma.customer.findUnique({
      where: { id: id.data },
      select: { id: true, name: true, phone: true, tags: true, note: true, isBlocked: true, requiresPrepay: true,
        birthDate: true, discountPercent: true, bonusBalance: true, skillLevel: true },
    });
    res.json(customer && { ...customer, birthDate: dateOnly(customer.birthDate) });
  },
);

customersRouter.post('/customers/:id/rewards', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().safeParse(param(req, 'id'));
  const parsed = z.object({
    amount: z.number().int().positive().max(100_000_000),
    reason: z.string().trim().min(3).max(300),
  }).safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const result = await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({ where: { id: id.data, clubId: req.auth!.clubId } });
    if (!customer) return null;
    const actor = await tx.user.findFirst({ where: { id: req.auth!.userId, clubId: req.auth!.clubId } });
    if (!actor) return null;
    const reward = await tx.customerReward.create({ data: {
      clubId: req.auth!.clubId, customerId: customer.id, amount: parsed.data.amount,
      reason: parsed.data.reason, actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
    } });
    const updated = await tx.customer.update({
      where: { id: customer.id }, data: { bonusBalance: { increment: parsed.data.amount } },
    });
    return { reward, bonusBalance: updated.bonusBalance };
  });
  if (!result) return res.status(404).json({ error: 'NOT_FOUND' });
  res.status(201).json(result);
});
