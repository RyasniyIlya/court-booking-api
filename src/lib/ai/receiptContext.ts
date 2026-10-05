import { prisma } from '../db';

/**
 * Адаптивний контекст для ШІ-перевірки квитанції: що очікуємо побачити,
 * хто отримувач і платник, як клуб платив раніше. Лише поля, що існують.
 */

export type ReceiptContext = {
  expected: {
    amount: number; // копійки
    number: string | null;
    periodFrom: string;
    periodTo: string;
    currency: 'UAH';
    issuedAt: string;
  };
  recipient: { legalName?: string; code?: string; iban?: string; bankName?: string } | null;
  otherSellers: Array<{ legalName?: string; iban: string; bankName?: string }>;
  payer: { legalName?: string; legalCode?: string; name?: string };
  history: Array<{ bank?: string; payerName?: string; amount?: number }>;
  rejected: Array<{ reason: string }>;
  bankHints: string[];
};

export const BANK_HINTS = [
  'Monobank: зверху сума та «Переказ на рахунок», нижче отримувач, IBAN, призначення; дата й час внизу.',
  'ПриватБанк: «Квитанція №…», блоки «Відправник/Отримувач», поле «Призначення платежу», сума з комісією окремим рядком.',
  'ПУМБ: «Платіжна інструкція», реквізити отримувача в таблиці, дата проведення у верхньому правому куті.',
  'Ощадбанк: «Квитанція про переказ», рядки «Отримувач», «IBAN отримувача», «Призначення», дата операції внизу.',
  'А-Банк: екран «Успішно», сума великим шрифтом, «Отримувач» і IBAN у деталях, дата під сумою.',
];

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function prune<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')) as T;
}

function historyItem(aiResult: unknown) {
  const ex = obj(obj(aiResult)?.extracted);
  if (!ex) return null;
  const amount = typeof ex.amount === 'number' ? ex.amount : undefined;
  const item = prune({ bank: str(ex.bank), payerName: str(ex.payerName), amount });
  return Object.keys(item).length ? item : null;
}

export async function buildReceiptContext(receiptId: string): Promise<ReceiptContext | null> {
  const r = await prisma.paymentReceipt.findUnique({
    where: { id: receiptId },
    select: {
      clubId: true,
      invoice: {
        select: {
          number: true, amount: true, periodFrom: true, periodTo: true, issuedAt: true, sellerId: true,
          seller: { select: { legalName: true, code: true, iban: true, bankName: true } },
        },
      },
      club: { select: { name: true, legalName: true, legalCode: true } },
    },
  });
  if (!r) return null;

  const [others, confirmed, rejected] = await Promise.all([
    prisma.sellerProfile.findMany({
      where: { isActive: true, ...(r.invoice.sellerId ? { id: { not: r.invoice.sellerId } } : {}) },
      select: { legalName: true, iban: true, bankName: true },
      take: 10,
    }),
    prisma.paymentReceipt.findMany({
      where: { clubId: r.clubId, status: 'CONFIRMED' },
      orderBy: { uploadedAt: 'desc' },
      take: 5,
      select: { aiResult: true },
    }),
    prisma.paymentReceipt.findMany({
      where: { clubId: r.clubId, status: 'REJECTED' },
      orderBy: { uploadedAt: 'desc' },
      take: 3,
      select: { rejectReason: true },
    }),
  ]);

  const inv = r.invoice;
  return {
    expected: {
      amount: inv.amount,
      number: inv.number ?? null,
      periodFrom: inv.periodFrom.toISOString().slice(0, 10),
      periodTo: inv.periodTo.toISOString().slice(0, 10),
      currency: 'UAH',
      issuedAt: inv.issuedAt.toISOString(),
    },
    recipient: inv.seller
      ? prune({
          legalName: str(inv.seller.legalName), code: str(inv.seller.code),
          iban: str(inv.seller.iban), bankName: str(inv.seller.bankName),
        })
      : null,
    otherSellers: others.map((o) =>
      prune({ legalName: str(o.legalName), iban: o.iban, bankName: str(o.bankName) }) as { iban: string },
    ),
    payer: prune({ legalName: str(r.club.legalName), legalCode: str(r.club.legalCode), name: str(r.club.name) }),
    history: confirmed.map((c) => historyItem(c.aiResult)).filter((x): x is NonNullable<typeof x> => !!x),
    rejected: rejected.filter((x) => x.rejectReason).map((x) => ({ reason: x.rejectReason as string })),
    bankHints: BANK_HINTS,
  };
}
