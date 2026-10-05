import { DateTime } from 'luxon';

import { prisma } from './db';
import { calcCommissions } from './partnerCommission';
import { clubListPrice, loadClubMetrics, EMPTY_BUNDLE } from './platformMetrics';
import { partnerClubStatus } from '../routes/partner';
import type { SheetSpec } from './xlsx';

/**
 * Звітність оператора по партнерах. Гроші — копійки.
 * Винагорода рахується тільки через calcCommissions (одне джерело правди).
 */

const ZONE = 'Europe/Kyiv';

export type ReportInvoice = {
  id: string;
  issuedAt: Date;
  periodFrom: Date;
  periodTo: Date;
  amount: number;
  status: string;
  paidAt: Date | null;
  method: string | null;
  rate: number;
  commission: number;
  net: number;
  seller: { id: string; label: string } | null;
};

export type ReportClub = {
  id: string;
  name: string;
  city: string | null;
  status: string;
  attachedAt: Date | null;
  plan: { code: string; name: string } | null;
  priceMonthly: number;
  billingPeriod: string;
  paidUntil: Date | null;
  received: number;
  commission: number;
  net: number;
  invoices: ReportInvoice[];
};

type Totals = { received: number; commission: number; net: number; payoutsPaid: number; due: number };

export type BySeller = { sellerId: string | null; label: string | null; iban: string | null; received: number };

export type PartnersReport = {
  period: { from: string | null; to: string | null };
  totals: Totals & { clubs: number; activeClubs: number; bySeller: BySeller[] };
  partners: {
    id: string;
    name: string;
    company: string | null;
    rateFirstYear: number;
    rateAfter: number;
    totals: Totals;
    clubs: ReportClub[];
    payouts: { id: string; amount: number; paidAt: Date; note: string | null }[];
  }[];
  months: { month: string; received: number; commission: number; net: number; payoutsPaid: number }[];
};

export const REPORT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bounds(from?: string, to?: string) {
  const f = from ? DateTime.fromISO(from, { zone: ZONE }).startOf('day') : null;
  const t = to ? DateTime.fromISO(to, { zone: ZONE }).endOf('day') : null;
  return { from: f ? f.toJSDate() : null, to: t ? t.toJSDate() : null };
}

const monthOf = (d: Date) => DateTime.fromJSDate(d, { zone: ZONE }).toFormat('yyyy-MM');

export async function buildPartnersReport(
  q: { from?: string; to?: string; partnerId?: string },
  now: Date = new Date(),
): Promise<PartnersReport> {
  const b = bounds(q.from, q.to);
  const inPeriod = (d: Date | null) => {
    if (!d) return false;
    if (b.from && d.getTime() < b.from.getTime()) return false;
    if (b.to && d.getTime() > b.to.getTime()) return false;
    return true;
  };

  const partners = await prisma.partner.findMany({
    where: q.partnerId ? { id: q.partnerId } : undefined,
    select: { id: true, name: true, company: true, rateFirstYear: true, rateAfter: true },
    orderBy: { createdAt: 'asc' },
  });
  const ids = partners.map((p) => p.id);

  const [clubs, payouts] = ids.length
    ? await Promise.all([
        prisma.club.findMany({
          where: { partnerId: { in: ids } },
          select: {
            id: true,
            name: true,
            city: true,
            partnerId: true,
            partnerAttachedAt: true,
            isActive: true,
            approvedAt: true,
            trialEndsAt: true,
            paidUntil: true,
            terminatedAt: true,
            billingPeriod: true,
            planPrice: true,
            plan: { select: { code: true, name: true, price: true, period: true } },
            invoices: {
              select: {
                id: true, clubId: true, amount: true, status: true, paidAt: true,
                issuedAt: true, periodFrom: true, periodTo: true, method: true,
                seller: { select: { id: true, label: true, iban: true } },
              },
              orderBy: { issuedAt: 'asc' },
            },
          },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.partnerPayout.findMany({
          where: { partnerId: { in: ids } },
          select: { id: true, partnerId: true, amount: true, paidAt: true, note: true },
          orderBy: { paidAt: 'desc' },
        }),
      ])
    : [[], []];

  const bundles = clubs.length ? await loadClubMetrics(clubs.map((c) => c.id), now) : new Map();

  const monthMap = new Map<string, { received: number; commission: number; payoutsPaid: number }>();
  const bump = (m: string, k: 'received' | 'commission' | 'payoutsPaid', v: number) => {
    const e = monthMap.get(m) ?? { received: 0, commission: 0, payoutsPaid: 0 };
    e[k] += v;
    monthMap.set(m, e);
  };

  const out: PartnersReport['partners'] = [];
  let clubsCount = 0;
  let activeClubs = 0;
  const sellerMap = new Map<string, BySeller>();

  for (const p of partners) {
    const pClubs = clubs.filter((c) => c.partnerId === p.id);
    const pPayouts = payouts.filter((x) => x.partnerId === p.id);
    /* Весь час — звідси due, яке не залежить від фільтра періоду */
    const calc = calcCommissions(
      pClubs.map((c) => ({ id: c.id, partnerAttachedAt: c.partnerAttachedAt, invoices: c.invoices })),
      p,
      pPayouts,
    );
    const rowByInvoice = new Map(calc.rows.map((r) => [r.invoiceId, r]));

    const repClubs: ReportClub[] = pClubs.map((c) => {
      const bundle = bundles.get(c.id) ?? EMPTY_BUNDLE;
      const price = clubListPrice(c, bundle.activeCourts);
      const status = partnerClubStatus(c, now);
      clubsCount += 1;
      if (status === 'ACTIVE') activeClubs += 1;

      const invoices: ReportInvoice[] = [];
      for (const inv of c.invoices) {
        const paid = inv.status === 'PAID';
        if (!inPeriod(paid ? inv.paidAt : inv.issuedAt)) continue;
        const row = paid ? rowByInvoice.get(inv.id) : undefined;
        const commission = row?.commission ?? 0;
        invoices.push({
          id: inv.id,
          issuedAt: inv.issuedAt,
          periodFrom: inv.periodFrom,
          periodTo: inv.periodTo,
          amount: inv.amount,
          status: inv.status,
          paidAt: inv.paidAt,
          method: inv.method,
          rate: row?.rate ?? 0,
          commission,
          net: paid ? inv.amount - commission : 0,
          seller: inv.seller ? { id: inv.seller.id, label: inv.seller.label } : null,
        });
        if (paid && inv.paidAt) {
          bump(monthOf(inv.paidAt), 'received', inv.amount);
          bump(monthOf(inv.paidAt), 'commission', commission);
          const key = inv.seller?.id ?? '';
          const bs = sellerMap.get(key) ?? { sellerId: inv.seller?.id ?? null, label: inv.seller?.label ?? null, iban: inv.seller?.iban ?? null, received: 0 };
          bs.received += inv.amount;
          sellerMap.set(key, bs);
        }
      }
      const received = invoices.reduce((s, i) => s + (i.status === 'PAID' ? i.amount : 0), 0);
      const commission = invoices.reduce((s, i) => s + i.commission, 0);
      return {
        id: c.id,
        name: c.name,
        city: c.city,
        status,
        attachedAt: c.partnerAttachedAt,
        plan: c.plan ? { code: c.plan.code, name: c.plan.name } : null,
        priceMonthly: price.listPriceMonthly,
        billingPeriod: c.billingPeriod,
        paidUntil: c.paidUntil,
        received,
        commission,
        net: received - commission,
        invoices,
      };
    });

    const periodPayouts = pPayouts.filter((x) => inPeriod(x.paidAt));
    for (const x of periodPayouts) bump(monthOf(x.paidAt), 'payoutsPaid', x.amount);

    const received = repClubs.reduce((s, c) => s + c.received, 0);
    const commission = repClubs.reduce((s, c) => s + c.commission, 0);
    out.push({
      id: p.id,
      name: p.name,
      company: p.company,
      rateFirstYear: p.rateFirstYear,
      rateAfter: p.rateAfter,
      totals: {
        received,
        commission,
        net: received - commission,
        payoutsPaid: periodPayouts.reduce((s, x) => s + x.amount, 0),
        due: calc.due,
      },
      clubs: repClubs,
      payouts: periodPayouts.map((x) => ({ id: x.id, amount: x.amount, paidAt: x.paidAt, note: x.note })),
    });
  }

  const sum = (k: keyof Totals) => out.reduce((s, p) => s + p.totals[k], 0);
  const months = [...monthMap.entries()]
    .sort(([a], [z]) => a.localeCompare(z))
    .map(([month, v]) => ({ month, ...v, net: v.received - v.commission }));

  return {
    period: { from: q.from ?? null, to: q.to ?? null },
    totals: {
      received: sum('received'),
      commission: sum('commission'),
      net: sum('net'),
      payoutsPaid: sum('payoutsPaid'),
      due: sum('due'),
      clubs: clubsCount,
      activeClubs,
      bySeller: [...sellerMap.values()].sort((a, b) => b.received - a.received),
    },
    partners: out,
    months,
  };
}

const uah = (kop: number) => kop / 100;

export function partnersReportSheets(r: PartnersReport): SheetSpec[] {
  const pName = (p: { name: string; company: string | null }) => p.company || p.name;
  const clubRows: (string | number | Date | null)[][] = [];
  const payRows: (string | number | Date | null)[][] = [];
  for (const p of r.partners) {
    for (const c of p.clubs) {
      clubRows.push([
        pName(p), c.name, c.city, c.status, c.attachedAt, c.plan?.name ?? null,
        uah(c.priceMonthly), c.paidUntil, uah(c.received), uah(c.commission), uah(c.net),
      ]);
      for (const i of c.invoices) {
        payRows.push([
          pName(p), c.name, c.plan?.name ?? null, `${i.periodFrom.toISOString().slice(0, 10)} – ${i.periodTo.toISOString().slice(0, 10)}`,
          uah(i.amount), i.status, i.paidAt, i.method, i.rate, uah(i.commission), uah(i.net), i.seller?.label ?? null,
        ]);
      }
    }
  }
  return [
    {
      name: 'Зведення',
      headers: ['Партнер', 'Клубів', 'Надійшло, грн', 'Винагорода, грн', 'Лишилось нам, грн', 'Виплачено, грн', 'До виплати, грн'],
      rows: r.partners.map((p) => [pName(p), p.clubs.length, uah(p.totals.received), uah(p.totals.commission), uah(p.totals.net), uah(p.totals.payoutsPaid), uah(p.totals.due)]),
      widths: [28, 8, 16, 16, 18, 16, 16],
    },
    {
      name: 'Клуби',
      headers: ['Партнер', 'Клуб', 'Місто', 'Статус', 'Привʼязано', 'Тариф', 'Ціна/міс, грн', 'Оплачено до', 'Надійшло, грн', 'Винагорода, грн', 'Нам, грн'],
      rows: clubRows,
      widths: [24, 26, 16, 12, 14, 18, 14, 14, 14, 16, 14],
    },
    {
      name: 'Платежі',
      headers: ['Партнер', 'Клуб', 'Тариф', 'Період', 'Сума, грн', 'Статус', 'Дата оплати', 'Спосіб', 'Ставка, %', 'Винагорода, грн', 'Нам, грн', 'Отримувач'],
      rows: payRows,
      widths: [24, 26, 18, 24, 14, 10, 14, 12, 10, 16, 14, 24],
    },
    {
      name: 'Виплати',
      headers: ['Партнер', 'Дата', 'Сума, грн', 'Примітка'],
      rows: r.partners.flatMap((p) => p.payouts.map((x) => [pName(p), x.paidAt, uah(x.amount), x.note])),
      widths: [28, 14, 14, 40],
    },
    {
      name: 'Отримувачі',
      headers: ['Отримувач', 'IBAN', 'Надійшло, грн'],
      rows: r.totals.bySeller.map((x) => [x.label ?? 'Не вказано', x.iban, uah(x.received)]),
      widths: [28, 34, 16],
    },
    {
      name: 'По місяцях',
      headers: ['Місяць', 'Надійшло, грн', 'Винагорода, грн', 'Нам, грн', 'Виплачено, грн'],
      rows: r.months.map((m) => [m.month, uah(m.received), uah(m.commission), uah(m.net), uah(m.payoutsPaid)]),
      widths: [12, 16, 16, 16, 16],
    },
  ];
}
