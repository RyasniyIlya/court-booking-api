import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { getActivePass } from '../../lib/customers';
import { requireAuth, requireStaff, requireLevel, param } from './shared';

/**
 * Абонементи клубу: тарифи й видача.
 *
 * Розділені навмисно. ТАРИФ виставляє власник у налаштуваннях — це рішення
 * про ціну, і міняється воно раз на сезон. ВИДАЧА — щоденна робота
 * ресепшена: людина заплатила, модератор натиснув. Поки те й те лежало в
 * одному місці, кожна видача була введенням дат і сум руками, тобто
 * помилкою на ресепшені раз на тиждень.
 *
 * Сама видача (POST /customers/:id/passes) лишилась у customers.ts — вона
 * там була до появи тарифів і продовжує приймати ручні умови. Тут те,
 * чого не було: тарифи, список абонементів клієнта і зняття.
 */
export const passesRouter = Router();

/* -------------------------------------------------------------------------- */
/* ТАРИФИ                                                                     */
/* -------------------------------------------------------------------------- */

/** Тариф назовні. Ціна — копійки, як і всюди в кабінеті. */
const planOut = (p: {
  id: string; name: string; type: string; totalSessions: number | null;
  days: number; price: number; isActive: boolean; sortOrder: number;
}) => ({
  id: p.id,
  name: p.name,
  type: p.type,
  totalSessions: p.totalSessions,
  days: p.days,
  price: p.price,
  isActive: p.isActive,
  sortOrder: p.sortOrder,
});

passesRouter.get('/pass-plans', requireAuth, async (req, res) => {
  const plans = await prisma.passPlan.findMany({
    where: { clubId: req.auth!.clubId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  res.json(plans.map(planOut));
});

const planSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(['PACKAGE', 'UNLIMITED']),
  totalSessions: z.number().int().min(1).max(200).nullable().optional(),
  days: z.number().int().min(1).max(730),
  price: z.number().int().min(0).max(10_000_000).default(0),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

type PlanInput = z.infer<typeof planSchema>;

/** PACKAGE без кількості занять — це безліміт, який назвали пакетом. */
function badPlan(d: Pick<PlanInput, 'type' | 'totalSessions'>) {
  return d.type === 'PACKAGE' && !d.totalSessions;
}

passesRouter.post(
  '/pass-plans',
  requireAuth,
  requireStaff,
  requireLevel(2),
  async (req, res) => {
    const parsed = planSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
    if (badPlan(parsed.data)) return res.status(400).json({ error: 'SESSIONS_REQUIRED' });

    const d = parsed.data;
    const plan = await prisma.passPlan.create({
      data: {
        clubId: req.auth!.clubId,
        name: d.name,
        type: d.type,
        totalSessions: d.type === 'PACKAGE' ? d.totalSessions! : null,
        days: d.days,
        price: d.price,
        isActive: d.isActive ?? true,
        sortOrder: d.sortOrder ?? 0,
      },
    });

    res.status(201).json(planOut(plan));
  },
);

passesRouter.patch(
  '/pass-plans/:id',
  requireAuth,
  requireStaff,
  requireLevel(2),
  async (req, res) => {
    const parsed = planSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const plan = await prisma.passPlan.findFirst({
      where: { id: param(req, 'id'), clubId: req.auth!.clubId },
    });
    if (!plan) return res.status(404).json({ error: 'NOT_FOUND' });

    const next = { ...plan, ...parsed.data };
    if (badPlan(next)) return res.status(400).json({ error: 'SESSIONS_REQUIRED' });

    const updated = await prisma.passPlan.update({
      where: { id: plan.id },
      data: {
        ...parsed.data,
        /* Безліміт не має кількості занять за визначенням. Якщо тариф
           перевели з пакета в безліміт, старе число треба прибрати —
           інакше воно тихо приїде в наступний виданий абонемент. */
        totalSessions: next.type === 'UNLIMITED' ? null : next.totalSessions,
      },
    });

    res.json(planOut(updated));
  },
);

/* Тариф видаляється назавжди, і це безпечно: виданий абонемент на нього
   не посилається — він зберіг свої умови в момент продажу. */
passesRouter.delete(
  '/pass-plans/:id',
  requireAuth,
  requireStaff,
  requireLevel(2),
  async (req, res) => {
    const plan = await prisma.passPlan.findFirst({
      where: { id: param(req, 'id'), clubId: req.auth!.clubId },
    });
    if (!plan) return res.status(404).json({ error: 'NOT_FOUND' });

    await prisma.passPlan.delete({ where: { id: plan.id } });
    res.json({ ok: true });
  },
);

/* -------------------------------------------------------------------------- */
/* АБОНЕМЕНТИ КЛІЄНТА                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Усі абонементи однієї людини: чинний, прострочені й зняті.
 *
 * Історія віддається разом із чинним, а не окремим роутом: питання «а коли
 * він купував минулий?» виникає рівно тоді, коли дивляться на поточний, і
 * другий клік заради нього нікому не потрібен.
 */
passesRouter.get(
  '/customers/:id/passes',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const customer = await prisma.customer.findFirst({
      where: { id: param(req, 'id'), clubId: req.auth!.clubId },
      select: { id: true },
    });
    if (!customer) return res.status(404).json({ error: 'NOT_FOUND' });

    const [passes, active] = await Promise.all([
      prisma.pass.findMany({
        where: { customerId: customer.id },
        orderBy: { validUntil: 'desc' },
        take: 30,
      }),
      getActivePass(customer.id),
    ]);

    res.json({
      /* Чинний — окремим полем, хоч він і в списку. Рахує його той самий
         getActivePass, що бачить віджет гравця: «скільки лишилось» не
         повинно розходитись між ресепшеном і телефоном клієнта. */
      active: active && {
        passId: active.passId,
        type: active.type,
        left: active.left,
        total: active.total,
        validUntil: active.validUntil.toISOString(),
        daysLeft: active.daysLeft,
        label: active.label,
      },
      history: passes.map((p) => ({
        id: p.id,
        type: p.type,
        totalSessions: p.totalSessions,
        usedSessions: p.usedSessions,
        validFrom: p.validFrom.toISOString(),
        validUntil: p.validUntil.toISOString(),
        price: p.price,
        revokedAt: p.revokedAt?.toISOString() ?? null,
      })),
    });
  },
);

/**
 * Зняти абонемент.
 *
 * Помітка, а не видалення рядка. Абонемент — це отримані гроші: списані з
 * нього заняття лежать у PassUsage і лишаються в історії клієнта, а сума
 * має далі потрапляти у звіти. Видалення рядка стерло б і те, і те.
 *
 * Головна причина, чому кнопка взагалі потрібна: помилились на ресепшені —
 * видали не тому або не той тариф. Поки зняття не було, єдиним виходом
 * лишалось чекати, поки абонемент сам згорить.
 */
passesRouter.post(
  '/passes/:id/revoke',
  requireAuth,
  requireStaff,
  requireLevel(2),
  async (req, res) => {
    const pass = await prisma.pass.findFirst({
      where: { id: param(req, 'id'), clubId: req.auth!.clubId },
    });
    if (!pass) return res.status(404).json({ error: 'NOT_FOUND' });
    if (pass.revokedAt) return res.status(409).json({ error: 'ALREADY_REVOKED' });

    const updated = await prisma.pass.update({
      where: { id: pass.id },
      data: { revokedAt: new Date() },
    });

    res.json({ id: updated.id, revokedAt: updated.revokedAt!.toISOString() });
  },
);
