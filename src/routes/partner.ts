import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';

import { prisma } from '../lib/db';
import { comparePassword, hashPassword } from '../lib/passwordHash';
import { requirePartnerAuth, signPartnerToken } from '../lib/partnerAuth';
import { calcCommissions } from '../lib/partnerCommission';
import { clubBilling } from '../lib/billing';
import { publicWebBase } from '../lib/botBooking';
import {
  PARTNER_CONTRACT_SELECT, PARTNER_REQUISITES_SELECT, contractView, loadDefaultSeller, partnerReadiness,
  partnerRequisitesSchema, requisitesView,
} from '../lib/partnerRequisites';
import { PARTNER_OFFER_VERSION, buildOfferAcceptance, renderPartnerOffer } from '../lib/partnerOffer';
import { ACT_SELECT, actView, renderActHtml, sendActHtml, transitionAct } from '../lib/partnerActs';
import { buildPartnerAnalytics } from '../lib/partnerAnalytics';
import {
  COURT_USAGE_BLOCK_SELECT, COURT_USAGE_BOOKING_SELECT, COURT_USAGE_COURT_SELECT, buildCourtUsage, periodFrom,
} from '../lib/courtUsage';
import { buildPartnerFeed } from '../lib/partnerFeed';

export const partnerRouter = Router();

/* Фіктивний хеш для гілки «пошти немає» — вирівнює час відповіді. */
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword('dummy-password-for-timing', 12));

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS' },
});

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

/** Єдине місце, що знає, які поля партнера можна показувати. */
export const PARTNER_PROFILE_SELECT = {
  id: true, name: true, company: true, email: true, phone: true,
  refCode: true, rateFirstYear: true, rateAfter: true,
} as const;

/**
 * Білий список полів клубу для партнера. Тільки паспорт клубу й наші рахунки —
 * без include: { club: true }, без броней, гравців, виручки, каси, персоналу.
 */
export const PARTNER_CLUB_SELECT = {
  id: true,
  name: true,
  city: true,
  isActive: true,
  approvedAt: true,
  trialEndsAt: true,
  paidUntil: true,
  terminatedAt: true,
  createdAt: true,
  partnerAttachedAt: true,
  plan: { select: { name: true } },
  _count: { select: { courts: { where: { isActive: true } } } },
  invoices: {
    where: { status: 'PAID' as const },
    select: { id: true, clubId: true, amount: true, status: true, paidAt: true },
    orderBy: { paidAt: 'desc' as const },
  },
} as const;

export type PartnerClubStatus = 'LEAD' | 'TRIAL' | 'ACTIVE' | 'DEBT' | 'DISABLED';

export function partnerClubStatus(
  c: { isActive: boolean; approvedAt: Date | null; trialEndsAt: Date | null; paidUntil: Date | null; terminatedAt: Date | null; invoices: { paidAt: Date | null }[] },
  now = new Date(),
): PartnerClubStatus {
  if (!c.isActive || c.terminatedAt) return 'DISABLED';
  if (!c.approvedAt && !c.trialEndsAt && !c.paidUntil && c.invoices.length === 0) return 'LEAD';
  const b = clubBilling({ paidUntil: c.paidUntil, trialEndsAt: c.trialEndsAt, isActive: c.isActive }, now);
  if (b.state === 'grace' || b.state === 'blocked') return 'DEBT';
  if (b.trial) return 'TRIAL';
  return 'ACTIVE';
}

/* -------------------------------------------------------------------------- */
/* LOGIN                                                                      */
/* -------------------------------------------------------------------------- */

partnerRouter.post('/login', loginLimiter, async (req, res) => {
  const parsed = z
    .object({ email: z.string().trim().email(), password: z.string().min(1).max(128) })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const email = parsed.data.email.toLowerCase();
  const partner = await prisma.partner.findUnique({ where: { email } });

  if (!partner || !partner.isActive) {
    await comparePassword(parsed.data.password, await getDummyHash());
    return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }

  const now = new Date();
  if (partner.pinLockedUntil && partner.pinLockedUntil > now) {
    return res.status(423).json({ error: 'PASSWORD_LOCKED' });
  }

  const valid = await comparePassword(parsed.data.password, partner.passwordHash);
  if (!valid) {
    const expired = partner.pinLockedUntil && partner.pinLockedUntil <= now;
    const fails = (expired ? 0 : partner.pinFails) + 1;
    await prisma.partner.update({
      where: { id: partner.id },
      data: { pinFails: fails, pinLockedUntil: fails >= MAX_FAILS ? new Date(now.getTime() + LOCK_MS) : null },
    });
    return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }

  if (partner.pinFails || partner.pinLockedUntil) {
    await prisma.partner.update({ where: { id: partner.id }, data: { pinFails: 0, pinLockedUntil: null } });
  }

  res.json({
    token: signPartnerToken(partner.id, partner.passwordHash),
    partner: {
      id: partner.id, name: partner.name, company: partner.company, email: partner.email,
      refCode: partner.refCode,
    },
  });
});

/* -------------------------------------------------------------------------- */
/* ME                                                                         */
/* -------------------------------------------------------------------------- */

const ME_SELECT = { ...PARTNER_PROFILE_SELECT, ...PARTNER_REQUISITES_SELECT, ...PARTNER_CONTRACT_SELECT } as const;

async function loadMe(partnerId: string) {
  return prisma.partner.findUnique({ where: { id: partnerId }, select: ME_SELECT });
}

/** Профіль + реквізити + договір + готовність. refLink — тільки коли партнер ready. */
function meView(p: NonNullable<Awaited<ReturnType<typeof loadMe>>>) {
  const { ready, missing } = partnerReadiness(p);
  const base = publicWebBase() ?? '';
  return {
    id: p.id, name: p.name, company: p.company, email: p.email, phone: p.phone,
    refCode: p.refCode, rateFirstYear: p.rateFirstYear, rateAfter: p.rateAfter,
    requisites: requisitesView(p),
    contract: contractView(p),
    ready,
    missing,
    refLink: ready ? `${base}/register?ref=${p.refCode}` : null,
  };
}

partnerRouter.get('/me', requirePartnerAuth, async (req, res) => {
  const partner = await loadMe(req.partnerAuth!.partnerId);
  if (!partner) return res.status(401).json({ error: 'UNAUTHORIZED' });
  res.json(meView(partner));
});

/* -------------------------------------------------------------------------- */
/* REQUISITES                                                                 */
/* -------------------------------------------------------------------------- */

partnerRouter.put('/requisites', requirePartnerAuth, async (req, res) => {
  const parsed = partnerRequisitesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'BAD_REQUEST', fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))] });
  }
  const d = parsed.data;
  await prisma.partner.update({
    where: { id: req.partnerAuth!.partnerId },
    data: {
      kind: d.kind, legalName: d.legalName, legalCode: d.legalCode, taxInfo: d.taxInfo ?? null,
      vatPayer: d.vatPayer ?? false, iban: d.iban, bankName: d.bankName ?? null,
      legalAddress: d.legalAddress ?? null, signerName: d.signerName, signerBasis: d.signerBasis ?? null,
      docsEmail: d.docsEmail, kvedConfirmed: d.kvedConfirmed ?? false, requisitesAt: new Date(),
    },
  });
  const me = await loadMe(req.partnerAuth!.partnerId);
  if (!me) return res.status(401).json({ error: 'UNAUTHORIZED' });
  res.json(meView(me));
});

/* -------------------------------------------------------------------------- */
/* OFFER                                                                      */
/* -------------------------------------------------------------------------- */

partnerRouter.get('/offer', requirePartnerAuth, async (req, res) => {
  const [seller, partner] = await Promise.all([
    loadDefaultSeller(),
    prisma.partner.findUnique({
      where: { id: req.partnerAuth!.partnerId },
      select: { ...PARTNER_REQUISITES_SELECT, offerAcceptedAt: true, offerVersion: true, contractMode: true },
    }),
  ]);
  if (!partner) return res.status(401).json({ error: 'UNAUTHORIZED' });
  if (!seller) return res.status(409).json({ error: 'SELLER_NOT_CONFIGURED' });
  res.json({
    version: PARTNER_OFFER_VERSION,
    html: renderPartnerOffer(seller, partner),
    accepted: !!partner.offerAcceptedAt && partner.offerVersion === PARTNER_OFFER_VERSION,
    individualContract: partner.contractMode === 'INDIVIDUAL',
  });
});

partnerRouter.post('/offer/accept', requirePartnerAuth, async (req, res) => {
  const parsed = z.object({ version: z.string().min(1).max(40) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  if (parsed.data.version !== PARTNER_OFFER_VERSION) {
    return res.status(409).json({ error: 'OFFER_VERSION_CHANGED', version: PARTNER_OFFER_VERSION });
  }

  const partnerId = req.partnerAuth!.partnerId;
  const [seller, partner] = await Promise.all([
    loadDefaultSeller(),
    prisma.partner.findUnique({
      where: { id: partnerId },
      select: { id: true, ...PARTNER_REQUISITES_SELECT, ...PARTNER_CONTRACT_SELECT },
    }),
  ]);
  if (!partner) return res.status(401).json({ error: 'UNAUTHORIZED' });
  if (!seller) return res.status(409).json({ error: 'SELLER_NOT_CONFIGURED' });
  if (partner.contractMode === 'INDIVIDUAL') return res.status(409).json({ error: 'INDIVIDUAL_CONTRACT' });
  /* Оферта описує сторін за реквізитами: без них акцептувати нічого. Договір і КВЕД
     тут не перевіряємо — це те, що акцепт якраз закриває. */
  const reqMissing = partnerReadiness({ ...partner, contractMode: 'PUBLIC_OFFER', offerAcceptedAt: new Date(), kvedConfirmed: true }).missing;
  if (reqMissing.length) return res.status(409).json({ error: 'REQUISITES_REQUIRED', missing: reqMissing });

  /* Повторний акцепт тієї ж версії нічого не міняє: дата першого акцепту — доказ. */
  if (!(partner.offerAcceptedAt && partner.offerVersion === PARTNER_OFFER_VERSION)) {
    await prisma.partner.update({
      where: { id: partnerId },
      data: buildOfferAcceptance(
        {
          id: seller.id, kind: seller.kind, label: seller.label, legalName: seller.legalName, code: seller.code,
          taxInfo: seller.taxInfo, iban: seller.iban, bankName: seller.bankName, address: seller.address,
          signerName: seller.signerName, signerBasis: seller.signerBasis, email: seller.email, phone: seller.phone,
        },
        partner,
        req.ip ?? null,
      ),
    });
  }
  const me = await loadMe(partnerId);
  if (!me) return res.status(401).json({ error: 'UNAUTHORIZED' });
  res.json(meView(me));
});

/* -------------------------------------------------------------------------- */
/* ACTS                                                                       */
/* -------------------------------------------------------------------------- */

/** Партнер бачить тільки свої виставлені акти: DRAFT і VOID для нього не існують. */
const PARTNER_VISIBLE_ACT = ['ISSUED', 'SIGNED', 'PAID'] as const;
const uuidParam = z.string().uuid();

partnerRouter.get('/acts', requirePartnerAuth, async (req, res) => {
  const rows = await prisma.partnerAct.findMany({
    where: { partnerId: req.partnerAuth!.partnerId, status: { in: [...PARTNER_VISIBLE_ACT] } },
    select: ACT_SELECT,
    orderBy: { periodFrom: 'desc' },
  });
  res.json(rows.map(actView));
});

partnerRouter.get('/acts/:id/html', requirePartnerAuth, async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!uuidParam.safeParse(id).success) return res.status(404).json({ error: 'NOT_FOUND' });
  const row = await prisma.partnerAct.findFirst({
    where: { id, partnerId: req.partnerAuth!.partnerId, status: { in: [...PARTNER_VISIBLE_ACT] } },
    select: { number: true, periodFrom: true, periodTo: true, amount: true, lines: true, sellerSnapshot: true, partnerSnapshot: true, status: true },
  });
  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
  sendActHtml(res, renderActHtml(row));
});

partnerRouter.post('/acts/:id/sign', requirePartnerAuth, async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!uuidParam.safeParse(id).success) return res.status(404).json({ error: 'NOT_FOUND' });
  const r = await transitionAct(prisma, id, 'sign', { onlyPartnerId: req.partnerAuth!.partnerId });
  if ('error' in r) return res.status(r.error === 'NOT_FOUND' ? 404 : 409).json({ error: r.error });
  res.json(r.act);
});

/* -------------------------------------------------------------------------- */
/* CLUBS                                                                      */
/* -------------------------------------------------------------------------- */

async function loadRates(partnerId: string) {
  return prisma.partner.findUnique({
    where: { id: partnerId },
    select: { rateFirstYear: true, rateAfter: true },
  });
}

partnerRouter.get('/clubs', requirePartnerAuth, async (req, res) => {
  const partnerId = req.partnerAuth!.partnerId;
  const [rates, clubs] = await Promise.all([
    loadRates(partnerId),
    prisma.club.findMany({
      where: { partnerId },
      select: PARTNER_CLUB_SELECT,
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  if (!rates) return res.status(401).json({ error: 'UNAUTHORIZED' });

  const calc = calcCommissions(clubs.map((c) => ({ id: c.id, partnerAttachedAt: c.partnerAttachedAt, invoices: c.invoices })), rates);
  const rowByInvoice = new Map(calc.rows.map((r) => [r.invoiceId, r]));
  const now = new Date();

  res.json(
    clubs.map((c) => ({
      id: c.id,
      name: c.name,
      city: c.city,
      activeCourts: c._count.courts,
      status: partnerClubStatus(c, now),
      plan: c.plan?.name ?? null,
      connectedAt: c.partnerAttachedAt,
      commissionTotal: calc.byClub[c.id] ?? 0,
      invoices: c.invoices.map((i) => ({
        id: i.id,
        paidAt: i.paidAt,
        amount: i.amount,
        commission: rowByInvoice.get(i.id)?.commission ?? 0,
      })),
    })),
  );
});

/* -------------------------------------------------------------------------- */
/* COMMISSIONS                                                                */
/* -------------------------------------------------------------------------- */

/** Спільна збірка для партнера й оператора: ті самі цифри в обох кабінетах. */
export async function buildPartnerCommissions(partnerId: string) {
  const [rates, clubs, payouts] = await Promise.all([
    loadRates(partnerId),
    prisma.club.findMany({
      where: { partnerId },
      select: {
        id: true,
        name: true,
        partnerAttachedAt: true,
        invoices: {
          where: { status: 'PAID' },
          select: { id: true, clubId: true, amount: true, status: true, paidAt: true },
        },
      },
    }),
    prisma.partnerPayout.findMany({
      where: { partnerId },
      select: { id: true, amount: true, paidAt: true, note: true },
      orderBy: { paidAt: 'desc' },
    }),
  ]);
  if (!rates) return null;

  const calc = calcCommissions(clubs, rates, payouts);
  const names = new Map(clubs.map((c) => [c.id, c.name]));
  return {
    rows: calc.rows.map((r) => ({
      invoiceId: r.invoiceId,
      clubId: r.clubId,
      clubName: names.get(r.clubId) ?? '',
      paidAt: r.paidAt,
      amount: r.amount,
      rate: r.rate,
      commission: r.commission,
    })),
    totals: { accrued: calc.accrued, paid: calc.paid, due: calc.due },
    payouts,
  };
}

partnerRouter.get('/commissions', requirePartnerAuth, async (req, res) => {
  const result = await buildPartnerCommissions(req.partnerAuth!.partnerId);
  if (!result) return res.status(401).json({ error: 'UNAUTHORIZED' });
  res.json(result);
});

/* -------------------------------------------------------------------------- */
/* ANALYTICS                                                                  */
/* -------------------------------------------------------------------------- */

partnerRouter.get('/analytics', requirePartnerAuth, async (req, res) => {
  const result = await buildPartnerAnalytics(req.partnerAuth!.partnerId);
  if (!result) return res.status(401).json({ error: 'UNAUTHORIZED' });
  res.json(result);
});

/* -------------------------------------------------------------------------- */
/* COURTS STATS (тільки агрегати й тільки зі згодою клубу)                    */
/* -------------------------------------------------------------------------- */

partnerRouter.get('/courts-stats', requirePartnerAuth, async (req, res) => {
  const parsed = z.coerce.number().int().min(1).max(24).safeParse(req.query.months ?? 3);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const months = parsed.data;

  const clubs = await prisma.club.findMany({
    where: { partnerId: req.partnerAuth!.partnerId },
    select: {
      id: true, name: true, timezone: true, createdAt: true, shareStatsWithPartner: true,
      hours: { select: { weekday: true, openMinute: true, closeMinute: true, isClosed: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const now = new Date();
  const out = [];
  for (const c of clubs) {
    if (!c.shareStatsWithPartner) {
      out.push({ clubId: c.id, name: c.name, shared: false as const });
      continue;
    }
    const from = periodFrom(now, months, c.timezone, c.createdAt);
    const [courts, bookings, blocks] = await Promise.all([
      prisma.court.findMany({ where: { clubId: c.id, isActive: true }, select: COURT_USAGE_COURT_SELECT, orderBy: { name: 'asc' } }),
      prisma.booking.findMany({ where: { clubId: c.id, status: 'CONFIRMED', endTime: { lte: now } }, select: COURT_USAGE_BOOKING_SELECT }),
      prisma.block.findMany({ where: { clubId: c.id, startTime: { lt: now }, endTime: { gt: from } }, select: COURT_USAGE_BLOCK_SELECT }),
    ]);
    out.push({
      clubId: c.id, name: c.name, shared: true as const,
      courts: buildCourtUsage({ courts, bookings, blocks, hours: c.hours, timezone: c.timezone, from, now }),
    });
  }
  res.json({ months, clubs: out });
});

/* -------------------------------------------------------------------------- */
/* LEADS                                                                     */
/* -------------------------------------------------------------------------- */

const LEAD_SELECT = {
  id: true, name: true, city: true, phone: true, contactName: true,
  courtsCount: true, stage: true, createdAt: true,
} as const;

partnerRouter.get('/leads', requirePartnerAuth, async (req, res) => {
  const leads = await prisma.lead.findMany({
    where: { partnerId: req.partnerAuth!.partnerId },
    select: LEAD_SELECT,
    orderBy: { createdAt: 'desc' },
  });
  res.json(leads);
});

const optStr = (max: number) => z.string().trim().max(max).optional().transform((v) => v || undefined);

const leadSchema = z.object({
  name: z.string().trim().min(2).max(160),
  city: optStr(80),
  phone: optStr(30),
  contactName: optStr(120),
  courtsCount: z.number().int().min(1).max(200).optional(),
  openingDate: optStr(40),
  note: optStr(1000),
});

partnerRouter.post('/leads', requirePartnerAuth, async (req, res) => {
  const parsed = leadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const d = parsed.data;

  /* Дублікат за телефоном: хто саме вже веде цей лід — не розкриваємо. */
  if (d.phone) {
    const exists = await prisma.lead.findFirst({ where: { phone: d.phone }, select: { id: true } });
    if (exists) return res.status(409).json({ error: 'LEAD_EXISTS' });
  }

  const noteParts = [d.openingDate ? `Планована дата відкриття: ${d.openingDate}` : null, d.note ?? null].filter(Boolean);

  const lead = await prisma.lead.create({
    data: {
      name: d.name,
      city: d.city ?? null,
      phone: d.phone ?? null,
      contactName: d.contactName ?? null,
      courtsCount: d.courtsCount ?? null,
      note: noteParts.length ? noteParts.join('\n') : null,
      source: 'partner',
      stage: 'NEW',
      partnerId: req.partnerAuth!.partnerId,
    },
    select: LEAD_SELECT,
  });
  res.status(201).json(lead);
});

/* -------------------------------------------------------------------------- */
/* PASSWORD                                                                   */
/* -------------------------------------------------------------------------- */

partnerRouter.post('/password', requirePartnerAuth, async (req, res) => {
  const parsed = z
    .object({ current: z.string().min(1).max(128), next: z.string().min(8).max(128) })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const partnerId = req.partnerAuth!.partnerId;
  const partner = await prisma.partner.findUnique({
    where: { id: partnerId },
    select: { passwordHash: true, pinFails: true, pinLockedUntil: true },
  });
  if (!partner) return res.status(401).json({ error: 'UNAUTHORIZED' });

  const now = new Date();
  if (partner.pinLockedUntil && partner.pinLockedUntil > now) {
    return res.status(423).json({ error: 'PASSWORD_LOCKED' });
  }
  if (!(await comparePassword(parsed.data.current, partner.passwordHash))) {
    const expired = partner.pinLockedUntil && partner.pinLockedUntil <= now;
    const fails = (expired ? 0 : partner.pinFails) + 1;
    await prisma.partner.update({
      where: { id: partnerId },
      data: { pinFails: fails, pinLockedUntil: fails >= MAX_FAILS ? new Date(now.getTime() + LOCK_MS) : null },
    });
    return res.status(403).json({ error: 'INVALID_PASSWORD' });
  }

  const passwordHash = await hashPassword(parsed.data.next, 12);
  await prisma.partner.update({ where: { id: partnerId }, data: { passwordHash, pinFails: 0, pinLockedUntil: null } });
  /* Старі токени гаснуть (credentialVersion від хешу) — віддаємо свіжий. */
  res.json({ ok: true, token: signPartnerToken(partnerId, passwordHash) });
});

/* -------------------------------------------------------------------------- */
/* SERVICE REQUESTS                                                           */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/partner/service-requests
 * Отримати заявки на сервіс для цього партнера.
 * Включає: club name, court name, contact fields.
 */
partnerRouter.get(
  '/service-requests',
  requirePartnerAuth,
  async (req, res) => {
    const partnerId = req.partnerAuth!.partnerId;

    const serviceRequests = await prisma.serviceRequest.findMany({
      where: {
        partnerId,
      },
      select: {
        id: true,
        kind: true,
        message: true,
        contactName: true,
        contactPhone: true,
        status: true,
        partnerNote: true,
        createdAt: true,
        updatedAt: true,
        club: {
          select: {
            id: true,
            name: true,
          },
        },
        court: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.json(serviceRequests);
  },
);

/**
 * PATCH /api/partner/service-requests/:id
 * Оновити статус і нотатку заявки. Тільки свої заявки.
 */
partnerRouter.patch(
  '/service-requests/:id',
  requirePartnerAuth,
  async (req, res) => {
    const partnerId = req.partnerAuth!.partnerId;
    const id = req.params.id as string;

    const parsed = z
      .object({
        status: z.enum(['NEW', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
        partnerNote: z.string().max(1000).optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: 'BAD_REQUEST' });
    }

    const serviceRequest = await prisma.serviceRequest.findUnique({
      where: { id },
      select: { partnerId: true },
    });

    if (!serviceRequest) {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }

    /* Перевіримо, що це заявка цього партнера */
    if (serviceRequest.partnerId !== partnerId) {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }

    const updated = await prisma.serviceRequest.update({
      where: { id },
      data: {
        ...(parsed.data.status && { status: parsed.data.status }),
        ...(parsed.data.partnerNote !== undefined && { partnerNote: parsed.data.partnerNote }),
      },
      select: {
        id: true,
        kind: true,
        message: true,
        contactName: true,
        contactPhone: true,
        status: true,
        partnerNote: true,
        createdAt: true,
        updatedAt: true,
        club: {
          select: {
            id: true,
            name: true,
          },
        },
        court: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    res.json(updated);
  },
);

/* -------------------------------------------------------------------------- */
/* EVENT FEED                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/partner/feed?limit=30
 * Стрічка подій партнера: CLUB_ATTACHED, INVOICE_PAID, ACT_ISSUED, ACT_PAID, SERVICE_REQUEST, LEAD_STAGE
 * Найновіші першими.
 */
partnerRouter.get(
  '/feed',
  requirePartnerAuth,
  async (req, res) => {
    const partnerId = req.partnerAuth!.partnerId;
    let limitQuery: string = '30';
    if (typeof req.query.limit === 'string') {
      limitQuery = req.query.limit;
    } else if (Array.isArray(req.query.limit) && req.query.limit.length > 0 && typeof req.query.limit[0] === 'string') {
      limitQuery = req.query.limit[0];
    }
    const limit = Math.min(parseInt(limitQuery) || 30, 100);

    const feed = await buildPartnerFeed(partnerId, limit);

    res.json(feed);
  },
);
