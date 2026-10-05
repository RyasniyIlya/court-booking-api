import { z } from 'zod';

import { prisma } from './db';

/**
 * Реквізити партнера й наші (SellerProfile): валідація, готовність партнера,
 * вибірки. Одне місце правди для кабінету партнера й операторки
 * (docs/partner-paperwork-spec.md).
 */

/* -------------------------------------------------------------------------- */
/* Валідація                                                                  */
/* -------------------------------------------------------------------------- */

export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** UA + 27 цифр і контрольна сума mod-97 (ISO 13616). */
export function isValidUaIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^UA\d{27}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/** Побудувати валідний UA IBAN з 6-цифрового МФО і 19-цифрового рахунку (для демо-даних і тестів). */
export function makeUaIban(mfo: string, account: string): string {
  const bban = mfo.padStart(6, '0') + account.padStart(19, '0');
  /* 'UA00' → U=30, A=10, 00 → '301000' */
  const numeric = bban + '3010' + '00';
  let rem = 0;
  for (const d of numeric) rem = (rem * 10 + Number(d)) % 97;
  const check = String(98 - rem).padStart(2, '0');
  return `UA${check}${bban}`;
}

/** ФОП / фізособа — РНОКПП (10 цифр), ТОВ — ЄДРПОУ (8 цифр). */
export function codeMatchesKind(kind: 'FOP' | 'TOV' | 'INDIVIDUAL', code: string): boolean {
  return kind === 'TOV' ? /^\d{8}$/.test(code) : /^\d{10}$/.test(code);
}

const cleanStr = (max: number) =>
  z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));

const ibanField = z
  .string()
  .trim()
  .max(40)
  .transform(normalizeIban)
  .refine(isValidUaIban, { message: 'BAD_IBAN' });

const codeField = z.string().trim().regex(/^\d+$/, 'BAD_CODE');

/* -------------------------------------------------------------------------- */
/* Партнер                                                                    */
/* -------------------------------------------------------------------------- */

const partnerKindEnum = z.enum(['FOP', 'TOV']);

const requisitesShape = {
  kind: partnerKindEnum,
  legalName: z.string().trim().min(2).max(200),
  legalCode: codeField,
  taxInfo: cleanStr(300),
  vatPayer: z.boolean().optional(),
  iban: ibanField,
  bankName: cleanStr(200),
  legalAddress: cleanStr(300),
  signerName: z.string().trim().min(2).max(160),
  signerBasis: cleanStr(200),
  docsEmail: z.string().trim().toLowerCase().email().max(160),
  kvedConfirmed: z.boolean().optional(),
};

/** PUT /api/partner/requisites — повна форма. */
export const partnerRequisitesSchema = z
  .object(requisitesShape)
  .strict()
  .superRefine((d, ctx) => {
    if (!codeMatchesKind(d.kind, d.legalCode)) {
      ctx.addIssue({ code: 'custom', path: ['legalCode'], message: 'BAD_CODE' });
    }
  });

/** PATCH /api/platform/partners/:id/requisites — оператор правильно частково. */
export const partnerRequisitesPatchSchema = z.object(requisitesShape).partial().strict();

export type PartnerRequisitesInput = z.infer<typeof partnerRequisitesSchema>;

/* -------------------------------------------------------------------------- */
/* Вибірки й вигляд                                                           */
/* -------------------------------------------------------------------------- */

export const PARTNER_REQUISITES_SELECT = {
  kind: true, legalName: true, legalCode: true, taxInfo: true, vatPayer: true,
  iban: true, bankName: true, legalAddress: true, signerName: true, signerBasis: true,
  docsEmail: true, kvedConfirmed: true,
} as const;

export const PARTNER_CONTRACT_SELECT = {
  contractMode: true, offerAcceptedAt: true, offerVersion: true, contractNo: true, contractDate: true,
} as const;

type ReqFields = {
  kind: 'FOP' | 'TOV' | null;
  legalName: string | null;
  legalCode: string | null;
  taxInfo: string | null;
  vatPayer: boolean;
  iban: string | null;
  bankName: string | null;
  legalAddress: string | null;
  signerName: string | null;
  signerBasis: string | null;
  docsEmail: string | null;
  kvedConfirmed: boolean;
};

type ContractFields = {
  contractMode: 'PUBLIC_OFFER' | 'INDIVIDUAL' | null;
  offerAcceptedAt: Date | null;
  offerVersion: string | null;
  contractNo: string | null;
  contractDate: Date | null;
};

export function requisitesView(p: ReqFields) {
  return {
    kind: p.kind, legalName: p.legalName, legalCode: p.legalCode, taxInfo: p.taxInfo,
    vatPayer: !!p.vatPayer, iban: p.iban, bankName: p.bankName, legalAddress: p.legalAddress,
    signerName: p.signerName, signerBasis: p.signerBasis, docsEmail: p.docsEmail,
    kvedConfirmed: !!p.kvedConfirmed,
  };
}

export function contractView(p: ContractFields) {
  return {
    mode: p.contractMode ?? null,
    offerAcceptedAt: p.offerAcceptedAt ?? null,
    offerVersion: p.offerVersion ?? null,
    contractNo: p.contractNo ?? null,
    contractDate: p.contractDate ?? null,
  };
}

export type MissingCode =
  | 'kind' | 'legalName' | 'legalCode' | 'iban' | 'signerName' | 'docsEmail' | 'kvedConfirmed' | 'contract';

/**
 * Готовність партнера: реквізити + підстава (акцептована оферта або
 * індивідуальний договір). `missing` — коди для людських підписів у вебі.
 */
export function partnerReadiness(p: Partial<ReqFields> & Partial<ContractFields>): { ready: boolean; missing: MissingCode[] } {
  const missing: MissingCode[] = [];
  if (!p.kind) missing.push('kind');
  if (!p.legalName?.trim()) missing.push('legalName');
  if (!p.legalCode?.trim() || (p.kind && !codeMatchesKind(p.kind, p.legalCode))) missing.push('legalCode');
  if (!p.iban || !isValidUaIban(p.iban)) missing.push('iban');
  if (!p.signerName?.trim()) missing.push('signerName');
  if (!p.docsEmail?.trim()) missing.push('docsEmail');
  if (!p.kvedConfirmed) missing.push('kvedConfirmed');
  const contractOk =
    p.contractMode === 'PUBLIC_OFFER'
      ? !!p.offerAcceptedAt
      : p.contractMode === 'INDIVIDUAL'
        ? !!p.contractNo?.trim() && !!p.contractDate
        : false;
  if (!contractOk) missing.push('contract');
  return { ready: missing.length === 0, missing };
}

/* -------------------------------------------------------------------------- */
/* Наші реквізити (SellerProfile)                                             */
/* -------------------------------------------------------------------------- */

const sellerKindEnum = z.enum(['FOP', 'TOV', 'INDIVIDUAL']);

const sellerShape = {
  kind: sellerKindEnum,
  label: z.string().trim().min(2).max(120),
  legalName: z.string().trim().min(2).max(200),
  code: codeField,
  taxInfo: cleanStr(300),
  iban: ibanField,
  bankName: cleanStr(200),
  address: cleanStr(300),
  signerName: cleanStr(160),
  signerBasis: cleanStr(200),
  email: z.string().trim().toLowerCase().email().max(160).nullable().optional().transform((v) => v || null),
  phone: cleanStr(40),
};

export const sellerCreateSchema = z
  .object({ ...sellerShape, isDefault: z.boolean().optional() })
  .strict()
  .superRefine((d, ctx) => {
    if (!codeMatchesKind(d.kind, d.code)) ctx.addIssue({ code: 'custom', path: ['code'], message: 'BAD_CODE' });
  });

export const sellerPatchSchema = z
  .object({ ...sellerShape, isActive: z.boolean().optional() })
  .partial()
  .strict();

export const SELLER_SELECT = {
  id: true, kind: true, label: true, legalName: true, code: true, taxInfo: true, iban: true,
  bankName: true, address: true, signerName: true, signerBasis: true, email: true, phone: true,
  isDefault: true, isActive: true, createdAt: true,
} as const;

export type SellerSnapshot = {
  id: string; kind: string; label: string; legalName: string; code: string; taxInfo: string | null;
  iban: string; bankName: string | null; address: string | null; signerName: string | null;
  signerBasis: string | null; email: string | null; phone: string | null;
};

export function sellerSnapshot(s: SellerSnapshot): SellerSnapshot {
  return {
    id: s.id, kind: s.kind, label: s.label, legalName: s.legalName, code: s.code, taxInfo: s.taxInfo ?? null,
    iban: s.iban, bankName: s.bankName ?? null, address: s.address ?? null, signerName: s.signerName ?? null,
    signerBasis: s.signerBasis ?? null, email: s.email ?? null, phone: s.phone ?? null,
  };
}

/** Основний активний профіль отримувача або null. */
export async function loadDefaultSeller(db: Pick<typeof prisma, 'sellerProfile'> = prisma) {
  return db.sellerProfile.findFirst({
    where: { isDefault: true, isActive: true },
    select: SELLER_SELECT,
  });
}

/**
 * id основного профілю для нового рахунку клубу. Збій читання не повинен
 * валити зарахування оплати: тоді рахунок лишається без профілю
 * (оператор призначить пізніше).
 */
export async function defaultSellerId(): Promise<string | null> {
  try {
    return (await prisma.sellerProfile.findFirst({ where: { isDefault: true, isActive: true }, select: { id: true } }))?.id ?? null;
  } catch {
    return null;
  }
}
