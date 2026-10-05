import { prisma } from './db';
import { PLAN_SELECT } from './plans';
import { PERIOD_LABEL } from './billing';
import { fmtDate, fmtUah, systemNote } from './platformJournal';
import { nextPeriod, periodAmount } from './subscription';
import { nextInvoiceNumbers } from './clubInvoice';
import { defaultSellerId } from './partnerRequisites';
import { sendMessage } from './telegram';
import { telegramHtml } from './telegramHtml';

export type GrantInput = {
  clubId: string;
  period?: 'MONTH' | 'QUARTER' | 'YEAR';
  /** Копійки. Не задано — сума рахунку (якщо є invoiceId) або прайс. */
  amount?: number;
  method?: string | null;
  note?: string | null;
  paidAt?: Date;
  actorEmail?: string;
  /** Закрити саме цей ISSUED-рахунок (квитанція): його період і сума лишаються. */
  invoiceId?: string;
};

/**
 * Спільний шлях «гроші дійшли»: оператор видає підписку вручну АБО підтверджує
 * квитанцію. Рахунок (відкритий ISSUED закривається, а не дублюється) і
 * Club.paidUntil рухаються в одній транзакції. null — клуб не знайдено.
 */
export async function grantSubscription(input: GrantInput) {
  const club = await prisma.club.findUnique({
    where: { id: input.clubId },
    select: {
      id: true,
      name: true,
      paidUntil: true,
      billingPeriod: true,
      planPrice: true,
      plan: { select: PLAN_SELECT },
      users: { where: { role: 'OWNER' }, select: { tgChatId: true }, take: 1 },
      /* Ціна залежить від кількості АКТИВНИХ кортів. */
      _count: { select: { courts: { where: { isActive: true } } } },
    },
  });

  if (!club) return null;

  let target: { id: string; periodFrom: Date; periodTo: Date; amount: number } | null = null;
  if (input.invoiceId) {
    target = await prisma.clubInvoice.findFirst({
      where: { id: input.invoiceId, clubId: club.id, status: 'ISSUED' },
      select: { id: true, periodFrom: true, periodTo: true, amount: true },
    });
  }

  const period = input.period ?? club.plan?.period ?? club.billingPeriod;
  const { from, to } = target
    ? { from: target.periodFrom, to: target.periodTo }
    : nextPeriod(club.paidUntil, period);
  const amount =
    input.amount ?? target?.amount ?? periodAmount(club.plan, club.planPrice, period, club._count.courts);

  const sellerId = await defaultSellerId();

  /* Клуб уже виставив рахунок — закриваємо саме його, а не плодимо дубль.
     Збій пошуку не валить зарахування: гірше за дубль тільки втрачена оплата. */
  const open =
    target ??
    (await (async () => {
      try {
        return await prisma.clubInvoice.findFirst({
          where: { clubId: club.id, status: 'ISSUED' },
          orderBy: { issuedAt: 'desc' },
          select: { id: true },
        });
      } catch {
        return null;
      }
    })());
  const [number] = open ? [null] : await nextInvoiceNumbers(1);

  const paidData = {
    periodFrom: from,
    periodTo: to,
    amount,
    status: 'PAID' as const,
    paidAt: input.paidAt ?? new Date(),
    method: input.method || null,
    note: input.note || null,
  };

  const [invoice, updated] = await prisma.$transaction([
    open
      ? prisma.clubInvoice.update({ where: { id: open.id }, data: paidData })
      : prisma.clubInvoice.create({
          data: {
            ...(sellerId ? { sellerId } : {}),
            ...(number ? { number } : {}),
            clubId: club.id,
            ...paidData,
          },
        }),
    prisma.club.update({
      where: { id: club.id },
      /* billingPeriod підтягується за виданим періодом. */
      data: { paidUntil: to, billingPeriod: period },
      include: { plan: { select: PLAN_SELECT } },
    }),
    prisma.crmActivity.create(
      systemNote(
        club.id,
        `Зараховано оплату: ${PERIOD_LABEL[period]} · ${fmtUah(amount)}, до ${fmtDate(to)}`,
        input.actorEmail,
      ),
    ),
  ]);

  const tgChatId = club.users[0]?.tgChatId;
  if (tgChatId) {
    await sendMessage(
      tgChatId,
      `✅ Оплату зараховано. Обслуговування ${telegramHtml(club.name)} діє до ${to.toLocaleDateString('uk-UA')}.`,
    ).catch(() => {
      /* Бот вимкнений або чат заблокований: гроші вже зараховані. */
    });
  }

  return { club: updated, invoice };
}
