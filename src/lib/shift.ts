import { DateTime } from 'luxon';
import { escapeReport } from './botAnalytics';

/**
 * Закриття зміни — вечірня звірка каси.
 *
 * Джерело правди — журнал розрахунків (BookingLedgerEntry): кожна
 * готівка й кожен термінал, які модератор записав за зміну. Зміна — це
 * все, що потрапило в журнал після попереднього закриття. Не «календарний
 * день»: зміна, що закінчилась о пів на першу ночі, інакше розпадалась би
 * на дві половинки, і жодна не сходилась би з касою.
 *
 * Онлайн-оплати сюди не входять: вони йдуть на рахунок клубу повз
 * ресепшен, і перерахувати їх у шухляді неможливо.
 */

export type LedgerLike = {
  kind: string;
  method: string;
  amount: number;
  account: string;
};

export type ShiftTotals = {
  cash: number;
  card: number;
  transfer: number;
  bonus: number;
};

/** Скільки мало бути: оплати мінус повернення, окремо по способах. */
export function shiftTotals(entries: LedgerLike[]): ShiftTotals {
  const t: ShiftTotals = { cash: 0, card: 0, transfer: 0, bonus: 0 };
  const key: Record<string, keyof ShiftTotals> = {
    CASH: 'cash', CARD: 'card', TRANSFER: 'transfer', BONUS: 'bonus',
  };

  for (const e of entries) {
    const k = key[e.method];
    if (!k) continue;
    t[k] += e.kind === 'REFUND' ? -e.amount : e.amount;
  }

  return t;
}

/**
 * Розбивка по касах клубу («Каса 1», «Термінал на ресепшені»). Потрібна,
 * коли розбіжність є: одразу видно, в якій із шухляд шукати.
 */
export function shiftByAccount(entries: LedgerLike[]) {
  const map = new Map<string, { account: string; method: string; net: number; count: number }>();

  for (const e of entries) {
    const id = `${e.method}:${e.account}`;
    const row = map.get(id) ?? { account: e.account, method: e.method, net: 0, count: 0 };
    row.net += e.kind === 'REFUND' ? -e.amount : e.amount;
    row.count += 1;
    map.set(id, row);
  }

  return [...map.values()].sort((a, b) => b.net - a.net);
}

/**
 * Звідки рахується зміна.
 *
 * Після першого закриття — від нього. До першого — від початку
 * сьогоднішнього дня клубу: інакше найперша зміна клубу, який веде журнал
 * третій місяць, тягнула б у «очікується» всю готівку за квартал.
 */
export function shiftStart(lastClosedAt: Date | null, timezone: string, now: DateTime = DateTime.now()): Date {
  if (lastClosedAt) return lastClosedAt;
  return now.setZone(timezone).startOf('day').toJSDate();
}

/** Коментар обовʼязковий, коли каса не зійшлась: «чому» — це і є звіт. */
export function needsNote(diffCash: number, diffCard: number, note: string) {
  return (diffCash !== 0 || diffCard !== 0) && note.trim().length < 3;
}

const hrn = (kop: number) => `${(kop / 100).toLocaleString('uk-UA', { maximumFractionDigits: 2 })} грн`;
const signed = (kop: number) => (kop > 0 ? `+${hrn(kop)}` : kop < 0 ? `−${hrn(-kop)}` : '0 грн');

export type ShiftCloseLike = {
  openedAt: Date;
  closedAt: Date;
  expectedCash: number;
  countedCash: number;
  expectedCard: number;
  countedCard: number;
  transferNet: number;
  bonusNet: number;
  entriesCount: number;
  note: string;
  actorName: string | null;
  actorEmail: string;
};

/** Повідомлення власнику в Telegram. HTML-режим, тому все чуже екрануємо. */
export function shiftText(clubName: string, s: ShiftCloseLike, timezone: string): string {
  const t = (d: Date) => DateTime.fromJSDate(d).setZone(timezone).toFormat('dd.MM HH:mm');
  const dCash = s.countedCash - s.expectedCash;
  const dCard = s.countedCard - s.expectedCard;
  const clean = dCash === 0 && dCard === 0;
  const who = escapeReport(s.actorName?.trim() || s.actorEmail);

  const line = (label: string, expected: number, counted: number) => {
    const diff = counted - expected;
    return diff === 0
      ? `${label}: ${hrn(counted)} ✓`
      : `${label}: ${hrn(counted)} замість ${hrn(expected)} (<b>${signed(diff)}</b>)`;
  };

  const rows = [
    `${clean ? '✅' : '⚠️'} <b>Зміну закрито · ${escapeReport(clubName)}</b>`,
    `${t(s.openedAt)} → ${t(s.closedAt)} · ${who}`,
    '',
    line('💵 Готівка', s.expectedCash, s.countedCash),
    line('💳 Термінал', s.expectedCard, s.countedCard),
  ];

  if (s.transferNet !== 0) rows.push(`🏦 Переказ: ${hrn(s.transferNet)}`);
  if (s.bonusNet !== 0) rows.push(`🎁 Бонусами: ${hrn(s.bonusNet)}`);
  rows.push(`Операцій у журналі: ${s.entriesCount}`);
  if (!clean) rows.push('', `Розбіжність: <b>${signed(dCash + dCard)}</b>`);
  if (s.note.trim()) rows.push('', `📝 ${escapeReport(s.note.trim())}`);

  return rows.join('\n');
}
