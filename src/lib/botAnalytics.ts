import { DateTime } from 'luxon';
import { prisma } from './db';
import { planFeatures } from './plans';
import { buildLoadProfile } from './loadProfile';
import { courtValueOf, loadPassSessionValues } from './serviceValue';

export const escapeReport = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const money = (kop: number) => `${(kop / 100).toLocaleString('uk-UA', { maximumFractionDigits: 2 })} грн`;

export function analyticsRange(input: string, timezone: string, now: DateTime = DateTime.now()) {
  const local = now.setZone(timezone);
  const key = input || 'today';
  const anchor = key === 'yesterday' ? local.minus({ days: 1 })
    : /^\d{4}-\d{2}-\d{2}$/.test(key) ? DateTime.fromISO(key, { zone: timezone }) : local;
  if (!['today', 'yesterday', 'week', 'month'].includes(key) && !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  if (!anchor.isValid || anchor.startOf('day') > local.startOf('day')) return null;
  const from = anchor.startOf(key === 'week' ? 'week' : key === 'month' ? 'month' : 'day');
  const end = anchor.plus({ days: 1 }).startOf('day');
  // Historical days are complete; current reports stop at generation time.
  const to = end < local ? end : local;
  return { from: from.toJSDate(), to: to.toJSDate(), label: `${from.toFormat('dd.MM.yyyy HH:mm')} — ${to.toFormat('dd.MM.yyyy HH:mm')}` };
}

export type CourtAnalytics = {
  name: string; confirmed: number; pending: number; cancelled: number; expired: number;
  amount: number; paid: number; paymentPending: number; refunded: number;
  bookedHours: number; freeHours: number; occupancy: number | null;
};

/** Blocks are paginated as complete HTML units, never split inside a tag. */
export function analyticsMessages(clubName: string, range: string, timezone: string, rows: CourtAnalytics[], generated: string) {
  const total = rows.reduce((a, r) => ({ confirmed: a.confirmed + r.confirmed, amount: a.amount + r.amount, pending: a.pending + r.pending, cancelled: a.cancelled + r.cancelled }), { confirmed: 0, amount: 0, pending: 0, cancelled: 0 });
  const header = `📊 <b>Аналітика клубу · ${escapeReport(clubName.slice(0, 120))}</b>\n${escapeReport(range)}\n<i>${escapeReport(timezone)}</i>`;
  const blocks = rows.map(r => [
    `🔸 <b>[ ${escapeReport(r.name.slice(0, 100))} ]</b>`,
    `— Підтверджені броні: <b>${r.confirmed} шт</b>`,
    `— Виручка корту (без тренера й прокату): <b>${money(r.amount)}</b>`,
    `— Очікують: <b>${r.pending}</b> · скасовано: <b>${r.cancelled}</b> · прострочено: <b>${r.expired}</b>`,
    `<blockquote>Завантаження: <b>${r.occupancy == null ? 'немає доступних годин' : `${r.occupancy.toFixed(1)}%`}</b>\n∘ Зайнято: <b>${r.bookedHours.toFixed(1)} год</b>\n∘ Вільно: <b>${r.freeHours.toFixed(1)} год</b>\n∘ Онлайн: оплачено <b>${r.paid}</b> · очікують <b>${r.paymentPending}</b> · повернено <b>${r.refunded}</b></blockquote>`,
  ].join('\n'));
  blocks.push([
    '———————————————',
    `🔹 <b>Усього по клубу</b>`,
    `Підтверджено: <b>${total.confirmed} броней</b>`,
    `Виручка корту (без тренера й прокату): <b>${money(total.amount)}</b>`,
    `Очікують: <b>${total.pending}</b> · скасовано: <b>${total.cancelled}</b>`,
    rows.length ? '' : 'За цей період кортів і записів немає.',
    '',
    '<i>Суми — виручка корту підтверджених броней (без тренера й прокату; заняття з абонемента — за вартістю заняття), не банківська виписка. Групові місця не додаються до ціни броні повторно. Онлайн-статуси враховують платежі броней і місць, це кількість, не гривні.</i>',
    '<i>Броні — за датою початку, години — за перетином із періодом. Блокування виключено; застосовано поточний графік роботи. Неявки не вимірюються.</i>',
    `\nЗнімок: ${escapeReport(generated)}. Повторний запит створить нове повідомлення; пізні зміни статусів можуть змінити цифри.`,
    '\nПерегляд: /analytics today · /analytics yesterday\n/analytics week · /analytics month\nЗа дату: <code>/analytics 2026-09-01</code>',
  ].join('\n'));
  const pages: string[] = []; let page = header;
  for (const block of blocks) {
    if (page.length + block.length + 2 > 3500) { pages.push(page); page = header; }
    page += '\n\n' + block;
  }
  pages.push(page);
  return pages.map((p, i) => `${p}\n\n<i>${i + 1} / ${pages.length}</i>`);
}

export type ClubCourtReport = { clubName: string; timezone: string; label: string; generated: string; rows: CourtAnalytics[] };

/**
 * Дані звіту по кортах без перевірки тарифу — для нейроаналітика власника
 * (`ownerAssistant`), де роут уже пройшов `requireFeature('ai')`. Друга
 * перевірка `featAnalytics` тут не потрібна: `ai` й `analytics` різні
 * прапорці, і мовчазний неспівпад між ними всередині чату виглядав би як
 * помилка, а не як межа тарифу. `null` — клуб не знайдено/неактивний або
 * період невалідний; текст про це формує викликач.
 */
export async function courtAnalytics(clubId: string, input: string): Promise<ClubCourtReport | null> {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: {
    name: true, timezone: true, createdAt: true, isActive: true,
    hours: { select: { weekday: true, openMinute: true, closeMinute: true, isClosed: true } },
  } });
  if (!club?.isActive) return null;
  const now = DateTime.now().setZone(club.timezone);
  const range = analyticsRange(input, club.timezone, now);
  if (!range) return null;
  const { from, to } = range;
  const [courts, bookings, blocks] = await Promise.all([
    prisma.court.findMany({ where: { clubId }, select: { id: true, name: true, isActive: true } }),
    prisma.booking.findMany({ where: { clubId, startTime: { lt: to }, endTime: { gt: from } }, select: {
      id: true, courtId: true, startTime: true, endTime: true, status: true, priceTotal: true,
      rentalTotal: true, trainerPrice: true, capacity: true, customer: { select: { discountPercent: true } },
      payment: { select: { status: true } }, seats: { select: { payment: { select: { status: true } } } },
    } }),
    prisma.block.findMany({ where: { clubId, startTime: { lt: to }, endTime: { gt: from } }, select: { courtId: true, startTime: true, endTime: true } }),
  ]);
  /* Виручка корту: без тренера/прокату, абонемент — за вартістю заняття. */
  const passValues = await loadPassSessionValues(prisma, bookings.map(b => b.id));
  const valued = bookings.map(b => ({ ...b, courtValue: courtValueOf({ ...b, discountPercent: b.customer?.discountPercent }, passValues.get(b.id)) }));
  const rows = courts.filter(c => c.isActive || valued.some(b => b.courtId === c.id)).map(c => {
    const own = valued.filter(b => b.courtId === c.id);
    const starts = own.filter(b => b.startTime >= from);
    const confirmed = starts.filter(b => b.status === 'CONFIRMED');
    const totals = buildLoadProfile({ from: from < club.createdAt ? club.createdAt : from, to, timezone: club.timezone, hours: club.hours,
      courts: c.isActive ? [{ id: c.id }] : [], blocks, bookings: own.filter(b => b.status === 'CONFIRMED'),
    }).totals;
    const payments = starts.flatMap(b => [b.payment, ...b.seats.map(s => s.payment)]).filter(p => p != null);
    return { name: c.name, confirmed: confirmed.length, amount: confirmed.reduce((sum, b) => sum + b.courtValue, 0),
      pending: starts.filter(b => b.status === 'PENDING').length, cancelled: starts.filter(b => b.status === 'CANCELLED').length,
      expired: starts.filter(b => b.status === 'EXPIRED').length,
      paid: payments.filter(p => p.status === 'PAID').length, paymentPending: payments.filter(p => p.status === 'PENDING').length,
      refunded: payments.filter(p => p.status === 'REFUNDED').length,
      bookedHours: totals.bookedMinutes / 60, freeHours: Math.max(0, totals.openMinutes - totals.bookedMinutes) / 60,
      occupancy: totals.openMinutes ? totals.occupancy * 100 : null,
    };
  });
  return { clubName: club.name, timezone: club.timezone, label: range.label, generated: now.toFormat('dd.MM.yyyy HH:mm:ss'), rows };
}

export async function botAnalytics(clubId: string, input: string) {
  const gate = await prisma.club.findUnique({ where: { id: clubId }, select: {
    isActive: true, plan: { select: { featTrainers: true, featGroups: true, featAnalytics: true } },
  } });
  if (!gate?.isActive || !planFeatures(gate.plan).analytics) return ['Аналітика недоступна для поточного клубу або тарифу.'];
  const data = await courtAnalytics(clubId, input);
  if (!data) return ['Оберіть today, yesterday, week, month або минулу дату YYYY-MM-DD. Наприклад: /analytics 2026-09-01'];
  return analyticsMessages(data.clubName, data.label, data.timezone, data.rows, data.generated);
}
