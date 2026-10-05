import { DateTime } from 'luxon';
import { prisma } from './db';
import { calcCommissions, type CommissionRates } from './partnerCommission';
import { clubListPrice, loadClubMetrics } from './platformMetrics';
import { PERIOD_MONTHS, type Period } from './subscription';
import { partnerClubStatus } from '../routes/partner';

/**
 * Аналітика партнера: винагороди, прогноз, воронка рекомендацій.
 * Гроші у копійках. Зони часу: Europe/Kyiv для групування по місяцях.
 */

export type EarningsByMonth = {
  month: string; // YYYY-MM
  commission: number;
};

export type Totals = {
  accrued: number;
  paid: number;
  due: number;
};

export type Forecast = {
  nextQuarter: number;
  next12Months: number;
};

export type Funnel = {
  leads: number;
  demo: number;
  trial: number;
  paying: number;
};

export type PartnerAnalytics = {
  earningsByMonth: EarningsByMonth[];
  totals: Totals;
  forecast: Forecast;
  funnel: Funnel;
};

/**
 * Последні 12 місяців комісій, згруповані по місяцях (Europe/Kyiv).
 * Беремо дані з calcCommissions rows, групуємо по місяцю paidAt.
 */
export function groupEarningsByMonth(rows: { paidAt: Date; commission: number }[]): EarningsByMonth[] {
  const byMonth = new Map<string, number>();

  for (const row of rows) {
    const dt = DateTime.fromJSDate(row.paidAt, { zone: 'Europe/Kyiv' });
    const month = dt.toFormat('yyyy-MM');
    byMonth.set(month, (byMonth.get(month) ?? 0) + row.commission);
  }

  const months: EarningsByMonth[] = [];
  for (let i = 11; i >= 0; i--) {
    const dt = DateTime.now().setZone('Europe/Kyiv').minus({ months: i });
    const month = dt.toFormat('yyyy-MM');
    months.push({ month, commission: byMonth.get(month) ?? 0 });
  }

  return months;
}

/**
 * Прогноз на наступний квартал і 12 місяців.
 * Тільки для клубів зі статусом ACTIVE (платячих) — виключає TRIAL, DEBT.
 * Для кожного клубу: ціна × ставка × кількість місяців.
 * Ставка змінюється через 12 місяців від attachedAt.
 */
export async function buildForecast(
  partnerId: string,
  rates: CommissionRates,
  now: Date = new Date(),
): Promise<Forecast> {
  const clubs = await prisma.club.findMany({
    where: { partnerId, isActive: true },
    select: {
      id: true,
      isActive: true,
      partnerAttachedAt: true,
      approvedAt: true,
      trialEndsAt: true,
      paidUntil: true,
      terminatedAt: true,
      plan: { select: { price: true, period: true } },
      planPrice: true,
      billingPeriod: true,
      courts: { where: { isActive: true }, select: { id: true } },
      invoices: {
        where: { status: 'PAID' as const },
        select: { paidAt: true },
      },
    },
  });

  // Фільтруємо тільки клубів зі статусом ACTIVE (платячих партнерам)
  const activeClubs = clubs.filter((c) => partnerClubStatus(c, now) === 'ACTIVE');

  if (activeClubs.length === 0) return { nextQuarter: 0, next12Months: 0 };

  const metrics = await loadClubMetrics(activeClubs.map((c) => c.id), now);

  let nextQuarter = 0;
  let next12Months = 0;

  for (const club of activeClubs) {
    const bundle = metrics.get(club.id);
    if (!bundle) continue;

    const price = clubListPrice(
      {
        plan: club.plan,
        planPrice: club.planPrice,
        billingPeriod: club.billingPeriod,
      },
      bundle.activeCourts,
    );

    const period = price.period as Period;
    const monthlyPrice = price.listPriceMonthly;
    const attachedAt = club.partnerAttachedAt;

    if (!attachedAt) continue;

    // Прогноз: 3 місяці для квартала, 12 для року
    const rateSwitch = DateTime.fromJSDate(attachedAt, { zone: 'utc' })
      .plus({ months: 12 })
      .toJSDate();

    for (let i = 0; i < 12; i++) {
      const monthStart = DateTime.fromJSDate(now, { zone: 'Europe/Kyiv' })
        .plus({ months: i + 1 })
        .startOf('month')
        .toJSDate();

      const rate = monthStart.getTime() < rateSwitch.getTime() ? rates.rateFirstYear : rates.rateAfter;
      const commission = Math.round((monthlyPrice * rate) / 100);

      if (i < 3) nextQuarter += commission;
      next12Months += commission;
    }
  }

  return { nextQuarter, next12Months };
}

/**
 * Воронка рекомендацій партнера:
 * - leads: всього лідів
 * - demo: лід на етапі DEMO/PROPOSAL/WON
 * - trial: клубів у статусі TRIAL
 * - paying: клубів у статусі ACTIVE або DEBT
 */
export async function buildFunnel(partnerId: string): Promise<Funnel> {
  const [leads, clubs] = await Promise.all([
    prisma.lead.findMany({
      where: { partnerId },
      select: { id: true, stage: true },
    }),
    prisma.club.findMany({
      where: { partnerId, isActive: true },
      select: {
        id: true,
        isActive: true,
        approvedAt: true,
        trialEndsAt: true,
        paidUntil: true,
        terminatedAt: true,
        invoices: {
          where: { status: 'PAID' as const },
          select: { paidAt: true },
        },
      },
    }),
  ]);

  const now = new Date();
  const demo = leads.filter((l) => ['DEMO', 'PROPOSAL', 'WON'].includes(l.stage)).length;
  const { trial, paying } = clubs.reduce(
    (acc, club) => {
      const status = partnerClubStatus(club, now);
      if (status === 'TRIAL') acc.trial += 1;
      if (status === 'ACTIVE' || status === 'DEBT') acc.paying += 1;
      return acc;
    },
    { trial: 0, paying: 0 },
  );

  return {
    leads: leads.length,
    demo,
    trial,
    paying,
  };
}

/**
 * Повна аналітика партнера.
 */
export async function buildPartnerAnalytics(partnerId: string, now: Date = new Date()): Promise<PartnerAnalytics | null> {
  const [rates, clubs, payouts] = await Promise.all([
    prisma.partner.findUnique({
      where: { id: partnerId },
      select: { rateFirstYear: true, rateAfter: true },
    }),
    prisma.club.findMany({
      where: { partnerId },
      select: {
        id: true,
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
    }),
  ]);

  if (!rates) return null;

  // Комісії за останні 12 місяців
  const from12Months = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const allCalc = calcCommissions(clubs, rates, payouts);
  const last12 = allCalc.rows.filter((r) => r.paidAt.getTime() >= from12Months.getTime());

  const [earningsByMonth, forecast, funnel] = await Promise.all([
    Promise.resolve(groupEarningsByMonth(last12)),
    buildForecast(partnerId, rates, now),
    buildFunnel(partnerId),
  ]);

  return {
    earningsByMonth,
    totals: { accrued: allCalc.accrued, paid: allCalc.paid, due: allCalc.due },
    forecast,
    funnel,
  };
}
