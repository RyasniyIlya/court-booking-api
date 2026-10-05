import { DateTime } from 'luxon';
import type { Response } from 'express';
import type { PrismaClient } from '@prisma/client';

import { prisma } from './db';
import { calcCommissions } from './partnerCommission';
import { escapeHtml } from './partnerOffer';
import {
  PARTNER_CONTRACT_SELECT, PARTNER_REQUISITES_SELECT, contractView, loadDefaultSeller,
  partnerReadiness, requisitesView, sellerSnapshot, type SellerSnapshot,
} from './partnerRequisites';

/**
 * Квартальні акти партнерів (docs/partner-paperwork-spec.md).
 * Сума = Σ винагород calcCommissions з paidAt у кварталі (Europe/Kyiv).
 */

const ZONE = 'Europe/Kyiv';
/** 1 000 грн у копійках — нижче переноситься за договором. */
export const ACT_MINIMUM = 100_000;

type Db = Pick<PrismaClient, 'partner' | 'partnerAct' | 'partnerPayout' | 'club' | 'sellerProfile' | '$transaction'>;

/* -------------------------------------------------------------------------- */
/* Квартал                                                                    */
/* -------------------------------------------------------------------------- */

export const QUARTER_RE = /^(\d{4})-Q([1-4])$/;

export function parseQuarter(q: string): { from: Date; to: Date; year: number; n: number } | null {
  const m = QUARTER_RE.exec(q);
  if (!m) return null;
  const year = Number(m[1]);
  const n = Number(m[2]);
  const from = DateTime.fromObject({ year, month: (n - 1) * 3 + 1, day: 1 }, { zone: ZONE }).startOf('day');
  return { from: from.toJSDate(), to: from.plus({ months: 3 }).toJSDate(), year, n };
}

export function quarterOf(d: Date): string {
  const k = DateTime.fromJSDate(d, { zone: ZONE });
  return `${k.year}-Q${k.quarter}`;
}

/* -------------------------------------------------------------------------- */
/* Вигляд акта                                                                */
/* -------------------------------------------------------------------------- */

export type ActLine = {
  clubId: string;
  clubName: string;
  invoiceId: string;
  paidAt: string;
  invoiceAmount: number;
  rate: number;
  commission: number;
};

type ActRow = {
  id: string;
  number: string;
  partnerId: string;
  periodFrom: Date;
  periodTo: Date;
  amount: number;
  lines: unknown;
  status: string;
  issuedAt: Date | null;
  signedAt: Date | null;
  paidAt: Date | null;
  partnerSnapshot?: unknown;
  partner?: { name: string; company: string | null } | null;
};

export const ACT_SELECT = {
  id: true, number: true, partnerId: true, periodFrom: true, periodTo: true, amount: true,
  lines: true, status: true, issuedAt: true, signedAt: true, paidAt: true,
  partnerSnapshot: true,
  partner: { select: { name: true, company: true } },
} as const;

export function actView(a: ActRow) {
  const snap = (a.partnerSnapshot ?? {}) as { legalName?: string | null };
  return {
    id: a.id,
    number: a.number,
    partnerId: a.partnerId,
    partnerName: a.partner ? a.partner.company || a.partner.name : snap.legalName ?? '',
    periodFrom: a.periodFrom,
    periodTo: a.periodTo,
    quarter: quarterOf(a.periodFrom),
    amount: a.amount,
    belowMinimum: a.amount < ACT_MINIMUM,
    status: a.status,
    issuedAt: a.issuedAt,
    signedAt: a.signedAt,
    paidAt: a.paidAt,
    lines: a.lines as ActLine[],
  };
}

/* -------------------------------------------------------------------------- */
/* Генерація                                                                  */
/* -------------------------------------------------------------------------- */

export type SkipReason = 'NOT_READY' | 'ZERO_AMOUNT' | 'ACT_EXISTS';

export type GenerateResult =
  | { error: 'BAD_QUARTER' | 'SELLER_NOT_CONFIGURED' | 'PARTNER_NOT_FOUND' }
  | { error: 'ACT_EXISTS' }
  | {
      created: ReturnType<typeof actView>[];
      skipped: { partnerId: string; name: string; reason: SkipReason }[];
    };

const isUnique = (e: unknown) => (e as { code?: string })?.code === 'P2002';

async function nextNumber(db: Db, year: number, n: number): Promise<string> {
  const prefix = `А-${year}-Q${n}-`;
  const last = await db.partnerAct.findFirst({
    where: { number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  });
  const seq = last ? Number(last.number.slice(prefix.length)) || 0 : 0;
  return `${prefix}${String(seq + 1).padStart(4, '0')}`;
}

/**
 * Сформувати DRAFT-акти за квартал. Без partnerId — для всіх партнерів; не
 * готові, з нульовою сумою або з уже існуючим актом потрапляють у skipped.
 * З partnerId дубль — помилка ACT_EXISTS (409 у роуті).
 */
export async function generateActs(
  opts: { quarter: string; partnerId?: string; now?: Date },
  db: Db = prisma,
): Promise<GenerateResult> {
  const q = parseQuarter(opts.quarter);
  if (!q) return { error: 'BAD_QUARTER' };
  const seller = await loadDefaultSeller(db);
  if (!seller) return { error: 'SELLER_NOT_CONFIGURED' };
  const sellerSnap = sellerSnapshot(seller);

  const partners = await db.partner.findMany({
    where: opts.partnerId ? { id: opts.partnerId } : undefined,
    select: {
      id: true, name: true, company: true, rateFirstYear: true, rateAfter: true,
      ...PARTNER_REQUISITES_SELECT, ...PARTNER_CONTRACT_SELECT,
    },
    orderBy: { createdAt: 'asc' },
  });
  if (opts.partnerId && partners.length === 0) return { error: 'PARTNER_NOT_FOUND' };

  const created: ReturnType<typeof actView>[] = [];
  const skipped: { partnerId: string; name: string; reason: SkipReason }[] = [];

  for (const p of partners) {
    const name = p.company || p.name;
    if (!partnerReadiness(p).ready) { skipped.push({ partnerId: p.id, name, reason: 'NOT_READY' }); continue; }

    const existing = await db.partnerAct.findUnique({
      where: { partnerId_periodFrom: { partnerId: p.id, periodFrom: q.from } },
      select: { id: true, status: true, number: true },
    });
    if (existing && existing.status !== 'VOID') {
      if (opts.partnerId) return { error: 'ACT_EXISTS' };
      skipped.push({ partnerId: p.id, name, reason: 'ACT_EXISTS' });
      continue;
    }

    const clubs = await db.club.findMany({
      where: { partnerId: p.id },
      select: {
        id: true, name: true, partnerAttachedAt: true,
        invoices: { where: { status: 'PAID' }, select: { id: true, clubId: true, amount: true, status: true, paidAt: true } },
      },
    });
    const calc = calcCommissions(clubs, p);
    const names = new Map(clubs.map((c) => [c.id, c.name]));
    const rows = calc.rows
      .filter((r) => r.paidAt.getTime() >= q.from.getTime() && r.paidAt.getTime() < q.to.getTime())
      .sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime());
    const amount = rows.reduce((s, r) => s + r.commission, 0);
    if (amount <= 0) { skipped.push({ partnerId: p.id, name, reason: 'ZERO_AMOUNT' }); continue; }

    const lines: ActLine[] = rows.map((r) => ({
      clubId: r.clubId, clubName: names.get(r.clubId) ?? '', invoiceId: r.invoiceId,
      paidAt: r.paidAt.toISOString(), invoiceAmount: r.amount, rate: r.rate, commission: r.commission,
    }));
    const partnerSnap = {
      id: p.id, name: p.name, company: p.company,
      ...requisitesView(p),
      contract: contractView(p),
    };

    let act: ActRow | null = null;
    for (let attempt = 0; attempt < 5 && !act; attempt++) {
      try {
        /* VOID-акт того ж кварталу перевикористовуємо: унікальність
           (partnerId, periodFrom) не дає створити другий рядок. Номер лишається. */
        act = existing
          ? await db.partnerAct.update({
              where: { id: existing.id },
              data: {
                amount, lines, sellerSnapshot: sellerSnap, partnerSnapshot: partnerSnap,
                status: 'DRAFT', issuedAt: null, signedAt: null, paidAt: null, payoutId: null,
              },
              select: ACT_SELECT,
            })
          : await db.partnerAct.create({
              data: {
                partnerId: p.id,
                number: await nextNumber(db, q.year, q.n),
                periodFrom: q.from, periodTo: q.to, amount, lines,
                sellerSnapshot: sellerSnap, partnerSnapshot: partnerSnap,
              },
              select: ACT_SELECT,
            });
      } catch (e) {
        if (!isUnique(e) || existing) throw e;
        /* колізія номера при паралельному запуску — беремо наступний */
      }
    }
    if (!act) throw new Error('ACT_NUMBER_COLLISION');
    created.push(actView(act));
  }

  return { created, skipped };
}

/* -------------------------------------------------------------------------- */
/* Статуси                                                                    */
/* -------------------------------------------------------------------------- */

export type ActAction = 'issue' | 'sign' | 'void' | 'pay';

const FROM: Record<ActAction, string[]> = {
  issue: ['DRAFT'],
  sign: ['ISSUED'],
  void: ['DRAFT', 'ISSUED'],
  pay: ['SIGNED'],
};

export type TransitionResult =
  | { error: 'NOT_FOUND' | 'BAD_STATUS' }
  | { act: ReturnType<typeof actView> };

/**
 * Перехід статусу. `onlyPartnerId` — партнер діє тільки зі своїм актом, а
 * DRAFT/VOID для нього неіснуючі (NOT_FOUND).
 */
export async function transitionAct(
  db: Db,
  id: string,
  action: ActAction,
  opts: { paidAt?: Date; onlyPartnerId?: string; now?: Date; by?: string } = {},
): Promise<TransitionResult> {
  const now = opts.now ?? new Date();
  const cur = await db.partnerAct.findUnique({
    where: { id },
    select: { id: true, partnerId: true, number: true, amount: true, status: true },
  });
  if (!cur) return { error: 'NOT_FOUND' };
  if (opts.onlyPartnerId && (cur.partnerId !== opts.onlyPartnerId || cur.status === 'DRAFT' || cur.status === 'VOID')) {
    return { error: 'NOT_FOUND' };
  }
  if (!FROM[action].includes(cur.status)) return { error: 'BAD_STATUS' };

  if (action === 'pay') {
    const paidAt = opts.paidAt ?? now;
    const ok = await db.$transaction(async (tx) => {
      /* Захист від подвійного кліку: статус перевіряється атомарно. */
      const claimed = await tx.partnerAct.updateMany({
        where: { id, status: 'SIGNED' },
        data: { status: 'PAID', paidAt },
      });
      if (claimed.count === 0) return false;
      const payout = await tx.partnerPayout.create({
        data: { partnerId: cur.partnerId, amount: cur.amount, paidAt, note: `Акт №${cur.number}` },
        select: { id: true },
      });
      await tx.partnerAct.update({ where: { id }, data: { payoutId: payout.id } });
      return true;
    });
    if (!ok) return { error: 'BAD_STATUS' };
  } else {
    const data =
      action === 'issue' ? { status: 'ISSUED' as const, issuedAt: now }
      : action === 'sign' ? { status: 'SIGNED' as const, signedAt: now }
      : { status: 'VOID' as const };
    const claimed = await db.partnerAct.updateMany({ where: { id, status: { in: FROM[action] as never[] } }, data });
    if (claimed.count === 0) return { error: 'BAD_STATUS' };
  }

  const act = await db.partnerAct.findUnique({ where: { id }, select: ACT_SELECT });
  if (!act) return { error: 'NOT_FOUND' };
  return { act: actView(act) };
}

/* -------------------------------------------------------------------------- */
/* Друкована форма                                                            */
/* -------------------------------------------------------------------------- */

const uah = (kop: number) =>
  (kop / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (d: Date | string) => DateTime.fromJSDate(new Date(d), { zone: ZONE }).toFormat('dd.MM.yyyy');
const e = escapeHtml;
const dash = (v: unknown) => (v ? e(v) : '—');

type PartnerSnap = {
  legalName?: string | null; legalCode?: string | null; taxInfo?: string | null; vatPayer?: boolean;
  iban?: string | null; bankName?: string | null; legalAddress?: string | null;
  signerName?: string | null; signerBasis?: string | null; docsEmail?: string | null;
  contract?: {
    mode?: string | null; offerAcceptedAt?: string | Date | null; offerVersion?: string | null;
    contractNo?: string | null; contractDate?: string | Date | null;
  };
};

export function renderActHtml(act: {
  number: string; periodFrom: Date; periodTo: Date; amount: number; lines: unknown;
  sellerSnapshot: unknown; partnerSnapshot: unknown; status: string;
}): string {
  const s = (act.sellerSnapshot ?? {}) as Partial<SellerSnapshot>;
  const p = (act.partnerSnapshot ?? {}) as PartnerSnap;
  const lines = (Array.isArray(act.lines) ? act.lines : []) as ActLine[];
  const lastDay = new Date(act.periodTo.getTime() - 1);
  const quarter = quarterOf(act.periodFrom);
  const c = p.contract ?? {};
  const basis =
    c.mode === 'INDIVIDUAL'
      ? `індивідуального договору № ${e(c.contractNo ?? '—')} від ${c.contractDate ? fmt(c.contractDate) : '—'}`
      : `публічного партнерського договору (версія ${e(c.offerVersion ?? '—')}, акцептовано ${c.offerAcceptedAt ? fmt(c.offerAcceptedAt) : '—'})`;
  const vat = p.vatPayer ? 'ПДВ нараховано згідно з податковим статусом Виконавця' : 'Без ПДВ';

  const rows = lines
    .map(
      (l, i) => `<tr><td>${i + 1}</td><td>${e(l.clubName)}</td><td class="n">${e(l.invoiceId.slice(0, 8))}</td>` +
        `<td>${fmt(l.paidAt)}</td><td class="r">${uah(l.invoiceAmount)}</td><td class="r">${e(l.rate)}%</td>` +
        `<td class="r">${uah(l.commission)}</td></tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Акт № ${e(act.number)}</title>
<style>
body{font:14px/1.45 Arial,Helvetica,sans-serif;color:#111;max-width:820px;margin:24px auto;padding:0 16px}
h1{font-size:20px;text-align:center;margin:0 0 4px}.c{text-align:center;color:#444;margin-bottom:18px}
table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #888;padding:4px 6px;vertical-align:top}
th{background:#f0f0f0}.r{text-align:right}.n{font-family:monospace}
.parties{display:flex;gap:24px;flex-wrap:wrap}.parties>div{flex:1;min-width:280px}
.sign{display:flex;gap:24px;margin-top:36px}.sign>div{flex:1;border-top:1px solid #111;padding-top:4px}
.draft{color:#a00;text-align:center;font-weight:bold}
@media print{body{margin:0}}
</style></head><body>
<h1>Акт наданих послуг № ${e(act.number)}</h1>
<div class="c">від ${fmt(lastDay)} за ${e(quarter)} (${fmt(act.periodFrom)} – ${fmt(lastDay)})</div>
${act.status === 'DRAFT' ? '<div class="draft">ЧЕРНЕТКА</div>' : ''}
<p>до ${basis}.</p>
<div class="parties">
<div><b>Замовник</b><br>${dash(s.legalName)}<br>Код: ${dash(s.code)}<br>${dash(s.taxInfo)}<br>${dash(s.address)}<br>IBAN: ${dash(s.iban)}, ${dash(s.bankName)}</div>
<div><b>Виконавець (Партнер)</b><br>${dash(p.legalName)}<br>Код: ${dash(p.legalCode)}<br>${dash(p.taxInfo)}<br>${dash(p.legalAddress)}<br>IBAN: ${dash(p.iban)}, ${dash(p.bankName)}</div>
</div>
<p>Виконавець надав, а Замовник прийняв послуги із залучення клієнтів (клубів) за ${e(quarter)}. Перелік оплат Залучених клубів і розрахунок винагороди:</p>
<table><thead><tr><th>№</th><th>Клуб</th><th>Рахунок</th><th>Дата оплати</th><th>Сума оплати, грн</th><th>Ставка</th><th>Винагорода, грн</th></tr></thead>
<tbody>
${rows}
<tr><td colspan="6" class="r"><b>Разом винагорода, грн</b></td><td class="r"><b>${uah(act.amount)}</b></td></tr>
</tbody></table>
<p>Вартість послуг: <b>${uah(act.amount)} грн</b>. ${e(vat)}. Сторони претензій одна до одної не мають.</p>
<div class="sign"><div>Замовник: ${dash(s.signerName)}</div><div>Виконавець: ${dash(p.signerName)}</div></div>
</body></html>`;
}

/** Друкована форма віддається як окремий документ: жодних скриптів і зовнішніх ресурсів. */
export function sendActHtml(res: Response, html: string) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.send(html);
}
