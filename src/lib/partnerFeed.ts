import { prisma } from './db';

export type PartnerFeedItem = {
  type: 'CLUB_ATTACHED' | 'INVOICE_PAID' | 'ACT_ISSUED' | 'ACT_PAID' | 'SERVICE_REQUEST' | 'LEAD_STAGE';
  at: Date;
  text: string;
  clubName?: string;
};

/**
 * Будує об'єднану стрічку подій партнера, відсортовану за часом (новіші першими).
 * Включає: клуб привʼязаний, рахунок оплачений, акт видано, акт оплачено,
 * заявка на сервіс, лід (зміна стадії).
 */
export async function buildPartnerFeed(
  partnerId: string,
  limit: number = 30,
): Promise<PartnerFeedItem[]> {
  const items: PartnerFeedItem[] = [];

  /* 1. Клуби привʼязані */
  const clubs = await prisma.club.findMany({
    where: {
      partnerId,
      partnerAttachedAt: { not: null },
    },
    select: {
      id: true,
      name: true,
      partnerAttachedAt: true,
    },
  });

  for (const club of clubs) {
    if (club.partnerAttachedAt) {
      items.push({
        type: 'CLUB_ATTACHED',
        at: club.partnerAttachedAt,
        text: `Клуб «${club.name}» привʼязаний до вас`,
        clubName: club.name,
      });
    }
  }

  /* 2. Оплачені рахунки клубів партнера */
  const invoices = await prisma.clubInvoice.findMany({
    where: {
      status: 'PAID',
      club: {
        partnerId,
      },
      paidAt: { not: null },
    },
    select: {
      id: true,
      paidAt: true,
      club: {
        select: {
          name: true,
        },
      },
    },
  });

  for (const invoice of invoices) {
    if (invoice.paidAt) {
      items.push({
        type: 'INVOICE_PAID',
        at: invoice.paidAt,
        text: `Клуб «${invoice.club.name}» оплатив підписку`,
        clubName: invoice.club.name,
      });
    }
  }

  /* 3. Видані акти */
  const actsIssued = await prisma.partnerAct.findMany({
    where: {
      partnerId,
      issuedAt: { not: null },
    },
    select: {
      id: true,
      issuedAt: true,
      number: true,
    },
  });

  for (const act of actsIssued) {
    if (act.issuedAt) {
      items.push({
        type: 'ACT_ISSUED',
        at: act.issuedAt,
        text: `Акт ${act.number} видано`,
      });
    }
  }

  /* 4. Оплачені акти */
  const actsPaid = await prisma.partnerAct.findMany({
    where: {
      partnerId,
      paidAt: { not: null },
    },
    select: {
      id: true,
      paidAt: true,
      number: true,
    },
  });

  for (const act of actsPaid) {
    if (act.paidAt) {
      items.push({
        type: 'ACT_PAID',
        at: act.paidAt,
        text: `Акт ${act.number} оплачено`,
      });
    }
  }

  /* 5. Заявки на сервіс */
  const serviceRequests = await prisma.serviceRequest.findMany({
    where: {
      partnerId,
    },
    select: {
      id: true,
      kind: true,
      createdAt: true,
      club: {
        select: {
          name: true,
        },
      },
    },
  });

  for (const sr of serviceRequests) {
    const kindText = {
      repair: 'ремонт',
      surface: 'заміна покриття',
      nets: 'заміна сіток',
      lighting: 'освітлення',
      other: 'інше',
    }[sr.kind] || sr.kind;

    items.push({
      type: 'SERVICE_REQUEST',
      at: sr.createdAt,
      text: `Клуб «${sr.club.name}» подав заявку на ${kindText}`,
      clubName: sr.club.name,
    });
  }

  /* 6. Зміни стадії лідів */
  const leads = await prisma.lead.findMany({
    where: {
      partnerId,
    },
    select: {
      id: true,
      stage: true,
      updatedAt: true,
      name: true,
    },
  });

  const stageTranslations: { [key: string]: string } = {
    NEW: 'новий лід',
    CHECKING: 'на перевірці',
    CONTACTED: 'контактував',
    QUALIFIED: 'кваліфіковано',
    DEMO: 'демо проведено',
    PROPOSAL: 'пропозиція відправлена',
    WON: 'перемога',
    LOST: 'втрачений',
    NOT_FIT: 'не підходить',
  };

  for (const lead of leads) {
    const stageText = stageTranslations[lead.stage] || lead.stage;

    items.push({
      type: 'LEAD_STAGE',
      at: lead.updatedAt,
      text: `${lead.name} — ${stageText}`,
    });
  }

  /* Сортуємо за часом (новіші першими) */
  items.sort((a, b) => b.at.getTime() - a.at.getTime());

  /* Обмежуємо кількість */
  return items.slice(0, limit);
}
