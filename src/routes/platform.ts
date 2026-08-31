import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';

import { prisma } from '../lib/db';
import { JWT_SECRET } from '../lib/authSecret';
import { PLAN_SELECT } from '../lib/plans';
import { sendMessage } from '../lib/telegram';

export const platformRouter = Router();

/* -------------------------------------------------------------------------- */
/* AUTH                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Оператор платформи — не клуб. User завжди прив'язаний до clubId, тому
 * тут окремий, повністю відірваний від клубної моделі вхід: один акаунт
 * з .env, а не рядок у таблиці User.
 *
 * scope: 'platform' — явна мітка в токені, щоб клубний requireAuth (admin.ts)
 * і цей requirePlatformAuth не переплутали токени одне одного навіть
 * випадково: обидва підписані тим самим JWT_SECRET.
 */
type PlatformAuth = { scope: 'platform'; email: string };

declare global {
  namespace Express {
    interface Request {
      platformAuth?: PlatformAuth;
    }
  }
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS' },
});

function requirePlatformAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as Partial<PlatformAuth>;
    if (payload.scope !== 'platform' || typeof payload.email !== 'string') {
      return res.status(401).json({ error: 'INVALID_TOKEN' });
    }
    req.platformAuth = { scope: 'platform', email: payload.email };
    next();
  } catch {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
}

/**
 * POST /api/platform/login
 *
 * Один акаунт з .env (PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD_HASH).
 * Поки оператор один — заводити під це таблицю в базі зайве.
 */
platformRouter.post('/login', loginLimiter, async (req, res) => {
  const parsed = z
    .object({ email: z.string().email(), password: z.string().min(1) })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'BAD_REQUEST' });
  }

  const expectedEmail = process.env.PLATFORM_ADMIN_EMAIL;
  const expectedHash = process.env.PLATFORM_ADMIN_PASSWORD_HASH;

  if (!expectedEmail || !expectedHash) {
    return res.status(503).json({ error: 'PLATFORM_ADMIN_NOT_CONFIGURED' });
  }

  const email = parsed.data.email.trim().toLowerCase();

  if (email !== expectedEmail.trim().toLowerCase()) {
    // Той самий шлях, що й невірний пароль: не підказуємо, яка з двох речей
    // не збіглась.
    await bcrypt.compare(parsed.data.password, expectedHash);
    return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }

  const valid = await bcrypt.compare(parsed.data.password, expectedHash);
  if (!valid) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }

  const token = jwt.sign({ scope: 'platform', email }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

/* -------------------------------------------------------------------------- */
/* CLUBS                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/platform/clubs
 *
 * Усі клуби разом — те, що клубний кабінет принципово не може показати:
 * там кожен токен бачить лише свій clubId.
 */
platformRouter.get('/clubs', requirePlatformAuth, async (_req, res) => {
  const clubs = await prisma.club.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
      phone: true,
      address: true,
      isActive: true,
      approvedAt: true,
      trialEndsAt: true,
      paidUntil: true,
      billingPeriod: true,
      billingNote: true,
      planPrice: true,
      plan: { select: PLAN_SELECT },
      createdAt: true,
      users: {
        where: { role: 'OWNER' },
        select: { email: true },
        take: 1,
      },
      _count: { select: { bookings: true, courts: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json(
    clubs.map((c) => ({
      ...c,
      ownerEmail: c.users[0]?.email ?? null,
      users: undefined,
      bookingsCount: c._count.bookings,
      courtsCount: c._count.courts,
      _count: undefined,
    })),
  );
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  address: z.string().trim().max(200).nullable().optional(),

  /** true -> approvedAt = зараз, false -> approvedAt = null (повернути «чекає») */
  approved: z.boolean().optional(),

  isActive: z.boolean().optional(),

  /** ISO-дата або null — «оплачено до». Порожній рядок теж означає null. */
  paidUntil: z.string().nullable().optional(),

  /** ISO-дата або null — до коли діє пробний період без оплати. */
  trialEndsAt: z.string().nullable().optional(),

  billingPeriod: z.enum(['MONTH', 'QUARTER', 'YEAR']).optional(),
  billingNote: z.string().trim().max(500).nullable().optional(),

  /** uuid плану або null — зняти план (клуб лишається без обмежень) */
  planId: z.string().uuid().nullable().optional(),
  /**
   * Індивідуальна ціна, копійки. null — брати ціну з плану.
   * 0 дозволений: безкоштовне впровадження — реальна домовленість.
   */
  planPrice: z.number().int().min(0).max(100_000_00).nullable().optional(),
});

/**
 * PATCH /api/platform/clubs/:id
 *
 * Тут же живе схвалення реєстрації (approved: true) і призупинення клубу
 * (isActive: false) — раніше обидві дії робились руками через Prisma
 * Studio чи одноразовий скрипт.
 */
platformRouter.patch('/clubs/:id', requirePlatformAuth, async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'BAD_REQUEST' });
  }

  const { approved, paidUntil, trialEndsAt, ...rest } = parsed.data;

  const data: Record<string, unknown> = { ...rest };

  if (approved !== undefined) {
    data.approvedAt = approved ? new Date() : null;
  }

  if (paidUntil !== undefined) {
    data.paidUntil = paidUntil ? new Date(paidUntil) : null;
  }

  if (trialEndsAt !== undefined) {
    data.trialEndsAt = trialEndsAt ? new Date(trialEndsAt) : null;
  }

  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  try {
    const club = await prisma.club.update({
      where: { id },
      data,
      include: { plan: { select: PLAN_SELECT } },
    });
    res.json(club);
  } catch {
    res.status(404).json({ error: 'NOT_FOUND' });
  }
});

/* -------------------------------------------------------------------------- */
/* PLANS                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Каталог планів. Веде оператор — клуб сюди не має доступу взагалі:
 * у кабінеті він бачить лише той план, який йому призначили.
 */
platformRouter.get('/plans', requirePlatformAuth, async (_req, res) => {
  const plans = await prisma.plan.findMany({
    orderBy: [{ sortOrder: 'asc' }, { tier: 'asc' }],
    include: { _count: { select: { clubs: true } } },
  });

  res.json(
    plans.map((p) => ({
      ...p,
      clubsCount: p._count.clubs,
      _count: undefined,
    })),
  );
});

const planBody = z.object({
  /** Ключ для коду. Латиниця, цифри й дефіс — на нього спираються seed і нотатки */
  code: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,31}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullable().optional(),
  /** Копійки. 0 дозволений — безкоштовний план теж план */
  price: z.number().int().min(0).max(100_000_00),
  period: z.enum(['MONTH', 'QUARTER', 'YEAR']).optional(),
  tier: z.number().int().min(1).max(9).optional(),
  featTrainers: z.boolean().optional(),
  featGroups: z.boolean().optional(),
  featAnalytics: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

platformRouter.post('/plans', requirePlatformAuth, async (req, res) => {
  const parsed = planBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'BAD_REQUEST' });
  }

  try {
    const plan = await prisma.plan.create({ data: parsed.data });
    res.status(201).json(plan);
  } catch {
    // Єдина реальна причина — зайнятий code (унікальний індекс)
    res.status(409).json({ error: 'CODE_TAKEN' });
  }
});

platformRouter.patch('/plans/:id', requirePlatformAuth, async (req, res) => {
  // code не міняється після створення: на нього спираються посилання
  // ззовні, а перейменування ключа мовчки розірвало б їх.
  const parsed = planBody.partial().omit({ code: true }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'BAD_REQUEST' });
  }

  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  try {
    const plan = await prisma.plan.update({ where: { id }, data: parsed.data });
    res.json(plan);
  } catch {
    res.status(404).json({ error: 'NOT_FOUND' });
  }
});

/**
 * Видалення плану. Клуби, яким він призначений, НЕ видаляються і не
 * ламаються — за зовнішнім ключем їм проставляється planId = null, тобто
 * вони лишаються без обмежень. Але це рішення оператора, а не побічний
 * ефект, тому попереджаємо кількістю в підтвердженні на клієнті.
 */
platformRouter.delete('/plans/:id', requirePlatformAuth, async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  try {
    await prisma.plan.delete({ where: { id } });
    res.status(204).end();
  } catch {
    res.status(404).json({ error: 'NOT_FOUND' });
  }
});

/* -------------------------------------------------------------------------- */
/* ВІДНОВЛЕННЯ ПАРОЛЯ                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Пароль клубу прочитати не можна — у базі bcrypt-хеш. Тому «відновлення»
 * тут завжди означає «задати новий», і єдине питання — хто підтвердив, що
 * на тому кінці справді власник.
 *
 * Підтверджує оператор, голосом: заявка з бота дає імʼя в Telegram і клуб,
 * далі дзвінок. Автоматично не робимо нічого — жодна перевірка, доступна
 * боту, не відрізняє власника від того, хто знає його пошту.
 */

/**
 * GET /api/platform/resets
 *
 * Черга заявок. За замовчуванням лише нові: закриті цікавлять як журнал,
 * а не як робочий список, і мішати їх в одну стрічку означало б ховати
 * свіжу заявку під торішніми.
 */
platformRouter.get('/resets', requirePlatformAuth, async (req, res) => {
  const all = req.query.all === '1';

  const rows = await prisma.passwordReset.findMany({
    where: all ? {} : { status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    take: all ? 200 : 100,
    select: {
      id: true,
      email: true,
      tgName: true,
      status: true,
      createdAt: true,
      resolvedAt: true,
      resolvedBy: true,
      club: { select: { id: true, name: true, slug: true, phone: true } },
      user: { select: { role: true } },
    },
  });

  res.json(rows);
});

/**
 * POST /api/platform/clubs/:id/owner-password
 *
 * Задати новий пароль власникові клубу. Межі 8..128 — ті самі, що й у
 * формі реєстрації (routes/admin/auth.ts): пароль, з яким потім не
 * вийде увійти, гірший за відсутність кнопки.
 *
 * resetId необовʼязковий: оператор може міняти пароль і без заявки (клуб
 * подзвонив, а бота не має взагалі). Але якщо заявка є — закриваємо її
 * тією ж транзакцією, інакше вона висітиме в черзі вже виконаною.
 */
platformRouter.post('/clubs/:id/owner-password', requirePlatformAuth, async (req, res) => {
  const clubId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = z
    .object({
      password: z.string().min(8).max(128),
      resetId: z.string().uuid().optional(),
    })
    .safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  /* Пароль отримує саме власник. Модератора чи тренера, що загубив
     пароль, заводить наново сам клуб — це його кухня, не наша. */
  const owner = await prisma.user.findFirst({
    where: { clubId, role: 'OWNER' },
    select: { id: true, email: true, tgChatId: true },
  });

  if (!owner) return res.status(404).json({ error: 'NOT_FOUND' });

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: owner.id }, data: { passwordHash } });

    if (parsed.data.resetId) {
      /* updateMany, а не update: заявку могли закрити секунду тому з
         іншої вкладки, і падати через це нема сенсу — пароль уже новий. */
      await tx.passwordReset.updateMany({
        where: { id: parsed.data.resetId, status: 'PENDING' },
        data: {
          status: 'DONE',
          resolvedAt: new Date(),
          resolvedBy: req.platformAuth?.email ?? null,
        },
      });
    }
  });

  /* Повідомити власника, що пароль змінили. Не заради зручності: якщо
     заявку подав не він, це єдиний сигнал, що доступ до кабінету щойно
     перевидали. Сам пароль у чат не йде — його диктує оператор. */
  if (owner.tgChatId) {
    await sendMessage(
      owner.tgChatId,
      [
        '🔑 Пароль вашого кабінету змінено оператором.',
        '',
        '<i>Якщо ви цього не просили — негайно звʼяжіться з нами.</i>',
      ].join('\n'),
    ).catch(() => {
      /* Бот міг бути вимкнений або чат заблокований. Пароль уже змінено,
         і валити відповідь оператору через це не можна. */
    });
  }

  res.json({ ok: true, email: owner.email });
});

/**
 * POST /api/platform/resets/:id/reject
 *
 * Заявка не підтвердилась дзвінком. Прибираємо з черги, але лишаємо в
 * журналі: кілька відхилених заявок на один клуб — це вже сигнал.
 */
platformRouter.post('/resets/:id/reject', requirePlatformAuth, async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const r = await prisma.passwordReset.updateMany({
    where: { id, status: 'PENDING' },
    data: {
      status: 'REJECTED',
      resolvedAt: new Date(),
      resolvedBy: req.platformAuth?.email ?? null,
    },
  });

  if (r.count === 0) return res.status(404).json({ error: 'NOT_FOUND' });
  res.status(204).end();
});
