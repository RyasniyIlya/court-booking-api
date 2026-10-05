import { DateTime } from 'luxon';

import { GRACE_DAYS } from './billing';
import { calcCommissions, commissionRate } from './partnerCommission';

/**
 * Аналітика оператора: одна чиста функція на метрику, без бази й годинника
 * (now параметром). Гроші — копійки. Маршрут лише завантажує дані й викликає ці
 * функції; прогноз = поточний стан, без «магії».
 */

const ZONE = 'Europe/Kyiv';

export type ClubStatusKey = 'trial' | 'active' | 'debt' | 'disabled';
/** Статус клубу з partnerClubStatus; LEAD (ще не клієнт) у метриках не рахується */
export type RawStatus = 'LEAD' | 'TRIAL' | 'ACTIVE' | 'DEBT' | 'DISABLED';

export type AInvoice = {
  id: string;
  amount: number;
  paidAt: Date | null;
  periodFrom: Date;
  periodTo: Date;
  sellerId: string | null;
  sellerLabel: string | null;
};

export type AClub = {
  id: string;
  status: RawStatus;
  /** Прайс на місяць за активні корти, копійки (clubListPrice.listPriceMonthly) */
  priceMonthly: number;
  trialEndsAt: Date | null;
  partnerId: string | null;
  partnerAttachedAt: Date | null;
  /** Лише PAID-рахунки */
  invoices: AInvoice[];
};

export type APartner = { id: string; name: string; rateFirstYear: number; rateAfter: number };
export type ALead = { stage: string; clubId: string | null };

const monthKey = (d: Date) => DateTime.fromJSDate(d, { zone: ZONE }).toFormat('yyyy-MM');

/** Місяці вікна, від старого до поточного: [{key, start, end}] (end — виключна межа) */
export function monthWindow(months: number, now: Date) {
  const cur = DateTime.fromJSDate(now, { zone: ZONE }).startOf('month');
  const out: { key: string; start: Date; end: Date }[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const s = cur.minus({ months: i });
    out.push({ key: s.toFormat('yyyy-MM'), start: s.toJSDate(), end: s.plus({ months: 1 }).toJSDate() });
  }
  return out;
}

/**
 * Скільки місяців «купив» рахунок: ≥11 міс → рік (ціна = 10 місячних, як
 * PERIOD_MONTHS), ≥2.5 → квартал (3), інакше місяць (1).
 */
function invoiceMonths(inv: AInvoice): number {
  const span = (inv.periodTo.getTime() - inv.periodFrom.getTime()) / (30.4375 * 86_400_000);
  if (span >= 11) return 10;
  if (span >= 2.5) return 3;
  return 1;
}

const monthlyOf = (inv: AInvoice) => Math.round(inv.amount / invoiceMonths(inv));

/** Клуб «платить» на момент t: є PAID-рахунок, чий період (+ пільга) накриває t */
function coveringInvoice(club: AClub, t: Date): AInvoice | null {
  const graceMs = GRACE_DAYS * 86_400_000;
  for (const inv of club.invoices) {
    if (inv.periodFrom.getTime() <= t.getTime() && t.getTime() < inv.periodTo.getTime() + graceMs) return inv;
  }
  return null;
}

/** MRR зараз = сума місячного прайсу клубів зі статусом ACTIVE (пробні й борг не рахуємо) */
export function calcMrr(clubs: AClub[]): number {
  return clubs.reduce((s, c) => s + (c.status === 'ACTIVE' ? c.priceMonthly : 0), 0);
}

/** ARR = MRR × 12 */
export const calcArr = (mrr: number): number => mrr * 12;

/**
 * Динаміка MRR: на кінець кожного місяця — сума (сума рахунку ÷ місяців періоду)
 * по клубах, чий оплачений період (+ пільга) накриває цю мить. Поточний місяць —
 * на `now`, а не на кінець місяця.
 */
export function mrrByMonth(clubs: AClub[], months: number, now: Date): { month: string; mrr: number }[] {
  return monthWindow(months, now).map((m) => {
    const at = new Date(Math.min(m.end.getTime() - 1, now.getTime()));
    let mrr = 0;
    for (const c of clubs) {
      const inv = coveringInvoice(c, at);
      if (inv) mrr += monthlyOf(inv);
    }
    return { month: m.key, mrr };
  });
}

/** Клуби по статусах; LEAD пропускаємо */
export function clubsByStatus(clubs: AClub[]): Record<ClubStatusKey, number> {
  const out: Record<ClubStatusKey, number> = { trial: 0, active: 0, debt: 0, disabled: 0 };
  for (const c of clubs) {
    if (c.status === 'LEAD') continue;
    out[c.status.toLowerCase() as ClubStatusKey] += 1;
  }
  return out;
}

/**
 * Відтік за місяць: base = клуби, що платили на початок місяця (накриті
 * оплаченим періодом з пільгою); lost = з них ті, що на кінець місяця вже не
 * накриті (не продовжили). rate = lost / base (0..1), base = 0 → 0.
 */
export function churnByMonth(
  clubs: AClub[],
  months: number,
  now: Date,
): { month: string; lost: number; base: number; rate: number }[] {
  return monthWindow(months, now).map((m) => {
    const endAt = new Date(Math.min(m.end.getTime() - 1, now.getTime()));
    let base = 0;
    let lost = 0;
    for (const c of clubs) {
      if (!coveringInvoice(c, m.start)) continue;
      base += 1;
      if (!coveringInvoice(c, endAt)) lost += 1;
    }
    return { month: m.key, lost, base, rate: base > 0 ? lost / base : 0 };
  });
}

/**
 * Конверсія пробний → платний: trials = клуби, яким давали пробний і він уже
 * скінчився (або вони вже платили); converted = з них мають хоч один PAID-рахунок.
 */
export function trialConversion(clubs: AClub[], now: Date): { trials: number; converted: number; rate: number } {
  let trials = 0;
  let converted = 0;
  for (const c of clubs) {
    if (!c.trialEndsAt) continue;
    const paid = c.invoices.length > 0;
    if (c.trialEndsAt.getTime() > now.getTime() && !paid) continue;
    trials += 1;
    if (paid) converted += 1;
  }
  return { trials, converted, rate: trials > 0 ? converted / trials : 0 };
}

/** Надходження по місяцях: сума PAID-рахунків за місяцем paidAt (Київ) */
export function receivedByMonth(clubs: AClub[], months: number, now: Date): { month: string; received: number }[] {
  const win = monthWindow(months, now);
  const sums = new Map(win.map((m) => [m.key, 0]));
  for (const c of clubs) {
    for (const inv of c.invoices) {
      if (!inv.paidAt) continue;
      const k = monthKey(inv.paidAt);
      if (sums.has(k)) sums.set(k, (sums.get(k) ?? 0) + inv.amount);
    }
  }
  return win.map((m) => ({ month: m.key, received: sums.get(m.key) ?? 0 }));
}

/** Надходження по рахунках отримувача за вікно; без профілю — sellerId null */
export function bySeller(
  clubs: AClub[],
  months: number,
  now: Date,
): { sellerId: string | null; label: string; received: number }[] {
  const from = monthWindow(months, now)[0].start.getTime();
  const map = new Map<string, { sellerId: string | null; label: string; received: number }>();
  for (const c of clubs) {
    for (const inv of c.invoices) {
      if (!inv.paidAt || inv.paidAt.getTime() < from) continue;
      const key = inv.sellerId ?? '';
      const e = map.get(key) ?? { sellerId: inv.sellerId, label: inv.sellerLabel ?? 'Без профілю', received: 0 };
      e.received += inv.amount;
      map.set(key, e);
    }
  }
  return [...map.values()].sort((a, b) => b.received - a.received);
}

export type PartnerChannel = {
  mrrShare: number;
  partnerRevenue: number;
  commission: number;
  commissionPct: number;
  topPartners: { id: string; name: string; clubs: number; mrr: number; commission: number }[];
  leadFunnel: { leads: number; demo: number; trial: number; paying: number };
};

const DEMO_STAGES = new Set(['DEMO', 'PROPOSAL', 'WON']);

/**
 * Канал партнерів.
 * mrrShare = MRR партнерських клубів / MRR (0..1).
 * partnerRevenue = PAID-рахунки партнерських клубів за вікно; commission =
 * calcCommissions по тих самих клубах, рядки з paidAt у вікні;
 * commissionPct = commission / partnerRevenue × 100 (1 знак).
 * topPartners — топ-5 за MRR своїх клубів (commission за вікно).
 * leadFunnel (ліди з partnerId): leads — усі; demo — етап DEMO/PROPOSAL/WON;
 * trial — лід привʼязано до клубу; paying — привʼязаний клуб має PAID-рахунок.
 */
export function partnerChannel(
  clubs: AClub[],
  partners: APartner[],
  leads: ALead[],
  months: number,
  now: Date,
): PartnerChannel {
  const from = monthWindow(months, now)[0].start.getTime();
  const mrr = calcMrr(clubs);
  const byId = new Map(clubs.map((c) => [c.id, c]));
  let partnerMrr = 0;
  let partnerRevenue = 0;
  let commission = 0;
  const top: PartnerChannel['topPartners'] = [];

  for (const p of partners) {
    const pc = clubs.filter((c) => c.partnerId === p.id);
    if (pc.length === 0) continue;
    const calc = calcCommissions(
      pc.map((c) => ({
        id: c.id,
        partnerAttachedAt: c.partnerAttachedAt,
        invoices: c.invoices.map((i) => ({ id: i.id, clubId: c.id, amount: i.amount, status: 'PAID', paidAt: i.paidAt })),
      })),
      p,
    );
    const rows = calc.rows.filter((r) => r.paidAt.getTime() >= from);
    const pCommission = rows.reduce((s, r) => s + r.commission, 0);
    const pMrr = pc.reduce((s, c) => s + (c.status === 'ACTIVE' ? c.priceMonthly : 0), 0);
    partnerMrr += pMrr;
    commission += pCommission;
    partnerRevenue += rows.reduce((s, r) => s + r.amount, 0);
    top.push({ id: p.id, name: p.name, clubs: pc.length, mrr: pMrr, commission: pCommission });
  }
  top.sort((a, b) => b.mrr - a.mrr || b.commission - a.commission);

  const funnel = { leads: leads.length, demo: 0, trial: 0, paying: 0 };
  for (const l of leads) {
    if (DEMO_STAGES.has(l.stage)) funnel.demo += 1;
    const club = l.clubId ? byId.get(l.clubId) : undefined;
    if (club) {
      funnel.trial += 1;
      if (club.invoices.length > 0) funnel.paying += 1;
    }
  }

  return {
    mrrShare: mrr > 0 ? partnerMrr / mrr : 0,
    partnerRevenue,
    commission,
    commissionPct: partnerRevenue > 0 ? Math.round((commission / partnerRevenue) * 1000) / 10 : 0,
    topPartners: top.slice(0, 5),
    leadFunnel: funnel,
  };
}

/**
 * Прогноз наступного кварталу = поточний стан:
 * received = активні клуби × їх поточний місячний прайс × 3;
 * partnerPayouts = для кожного партнерського активного клубу — 3 місячні
 * платежі на датах now+1, +2, +3 міс.; ставка партнера на ту дату
 * (commissionRate: після 12 міс. від привʼязки — rateAfter), округлення як у
 * calcCommissions по кожному платежу.
 */
export function forecastNextQuarter(
  clubs: AClub[],
  partners: APartner[],
  now: Date,
): { received: number; partnerPayouts: number } {
  const pById = new Map(partners.map((p) => [p.id, p]));
  let received = 0;
  let payouts = 0;
  for (const c of clubs) {
    if (c.status !== 'ACTIVE') continue;
    received += c.priceMonthly * 3;
    const p = c.partnerId ? pById.get(c.partnerId) : undefined;
    if (!p || !c.partnerAttachedAt) continue;
    for (let k = 1; k <= 3; k += 1) {
      const at = DateTime.fromJSDate(now, { zone: 'utc' }).plus({ months: k }).toJSDate();
      payouts += Math.round((c.priceMonthly * commissionRate(c.partnerAttachedAt, at, p)) / 100);
    }
  }
  return { received, partnerPayouts: payouts };
}
