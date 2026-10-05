import { DateTime } from 'luxon';
import type { Response } from 'express';

import { prisma } from './db';
import { escapeHtml } from './partnerOffer';
import type { SellerSnapshot } from './partnerRequisites';
import { PERIOD_LABEL } from './billing';

/**
 * Рахунки клубів на підписку: номер, призначення платежу, друкована форма.
 * Номер: К-{рік}-{порядковий 5 цифр}. Старі рядки без номера лишаються null.
 */

const ZONE = 'Europe/Kyiv';

type NumberDb = { clubInvoice: { findFirst: (args: never) => Promise<{ number: string | null } | null> } };

/**
 * Наступні `count` номерів за рік. Лічильник = максимум існуючого + 1: видалені
 * чи скасовані рахунки не дають повторів, а @unique ловить гонку.
 * Збій читання -> null-номери: гроші важливіші за номер (оператор не мусить
 * чекати на лічильник, щоб зарахувати оплату).
 */
export async function nextInvoiceNumbers(count: number, now: Date = new Date(), db: unknown = prisma): Promise<(string | null)[]> {
  const year = DateTime.fromJSDate(now, { zone: ZONE }).year;
  const prefix = `К-${year}-`;
  try {
    const last = await (db as NumberDb).clubInvoice.findFirst({
      where: { number: { startsWith: prefix } },
      orderBy: { number: 'desc' },
      select: { number: true },
    } as never);
    const n = last?.number ? Number.parseInt(last.number.slice(prefix.length), 10) : 0;
    const base = Number.isFinite(n) ? n : 0;
    return Array.from({ length: count }, (_, i) => `${prefix}${String(base + i + 1).padStart(5, '0')}`);
  } catch {
    return Array.from({ length: count }, () => null);
  }
}

export function paymentPurpose(number: string | null, clubName: string): string {
  return `Оплата підписки КОРТ, рахунок №${number ?? '—'}, ${clubName}, без ПДВ`;
}

/** Реквізити для переказу або null, якщо основний профіль не налаштований. */
export function payToView(
  seller: Pick<SellerSnapshot, 'legalName' | 'code' | 'iban' | 'bankName'> | null,
  number: string | null,
  clubName: string,
) {
  if (!seller) return null;
  return {
    legalName: seller.legalName,
    code: seller.code,
    iban: seller.iban,
    bankName: seller.bankName ?? null,
    purpose: paymentPurpose(number, clubName),
  };
}

const e = escapeHtml;
const uah = (kop: number) =>
  (kop / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (d: Date | string) => DateTime.fromJSDate(new Date(d), { zone: ZONE }).toFormat('dd.MM.yyyy');
const dash = (v: unknown) => (v ? e(v) : '—');

export function renderInvoiceHtml(inv: {
  number: string | null; issuedAt: Date; periodFrom: Date; periodTo: Date; amount: number; status: string;
}, club: { name: string; legalName?: string | null; legalCode?: string | null }, seller: Partial<SellerSnapshot> | null): string {
  const lastDay = new Date(inv.periodTo.getTime() - 1);
  const no = inv.number ?? '—';
  const purpose = paymentPurpose(inv.number, club.name);
  const months = Math.round((inv.periodTo.getTime() - inv.periodFrom.getTime()) / (30.44 * 86_400_000));
  const period = months === 1 ? 'MONTH' : months === 3 ? 'QUARTER' : months === 12 ? 'YEAR' : null;
  const service = `Підписка на сервіс КОРТ${period ? ` (${PERIOD_LABEL[period]})` : ''},${fmt(inv.periodFrom)} – ${fmt(lastDay)}`;
  const s = seller ?? {};
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Рахунок № ${e(no)}</title>
<style>
body{font:14px/1.45 Arial,Helvetica,sans-serif;color:#111;max-width:820px;margin:24px auto;padding:0 16px}
h1{font-size:20px;text-align:center;margin:0 0 4px}.c{text-align:center;color:#444;margin-bottom:18px}
table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #888;padding:4px 6px;vertical-align:top}
th{background:#f0f0f0}.r{text-align:right}
.void{color:#a00;text-align:center;font-weight:bold}.paid{color:#070;text-align:center;font-weight:bold}
@media print{body{margin:0}}
</style></head><body>
<h1>Рахунок на оплату № ${e(no)}</h1>
<div class="c">від ${fmt(inv.issuedAt)}</div>
${inv.status === 'VOID' ? '<div class="void">СКАСОВАНО</div>' : ''}${inv.status === 'PAID' ? '<div class="paid">ОПЛАЧЕНО</div>' : ''}
<p><b>Отримувач</b><br>${dash(s.legalName)}<br>Код: ${dash(s.code)}<br>${dash(s.taxInfo)}<br>${dash(s.address)}<br>IBAN: ${dash(s.iban)}, ${dash(s.bankName)}</p>
<p><b>Платник</b><br>${dash(club.legalName || club.name)}<br>Код: ${dash(club.legalCode)}</p>
<table><thead><tr><th>№</th><th>Послуга</th><th>Сума, грн</th></tr></thead><tbody>
<tr><td>1</td><td>${e(service)}</td><td class="r">${uah(inv.amount)}</td></tr>
<tr><td colspan="2" class="r"><b>Разом до сплати, грн</b></td><td class="r"><b>${uah(inv.amount)}</b></td></tr>
</tbody></table>
<p>Без ПДВ.</p>
<p><b>Призначення платежу:</b> ${e(purpose)}</p>
</body></html>`;
}

export function sendInvoiceHtml(res: Response, html: string) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.send(html);
}
