/**
 * Прокат при броні — частина, що ходить у базу.
 *
 * Правила (ціна, пік зайнятості, урізання) живуть у lib/rentals.ts і
 * перевіряються тестами без Postgres. Тут — лише читання рядків і замок.
 *
 * ── Чому FOR UPDATE, а не констрейнт ─────────────────────────────────────
 * Тренера від подвійного продажу стереже EXCLUDE trainer_no_overlap, бо
 * тренер один. У позиції залишок N, а «сума перетинів ≤ N» Postgres
 * декларативно не виражає. Тому рядки InventoryItem блокуються на час
 * перевірки: дві броні, що беруть ОСТАННЮ ракетку Wilson в одну мілісекунду,
 * стають у чергу, і друга бачить уже закомічений рядок першої. Броні на
 * інші позиції не чекають.
 *
 * Замок береться в порядку id — інакше дві броні «ракетка + мʼячі» і
 * «мʼячі + ракетка» могли б узяти замки навхрест і зачекати одна одну.
 */

import type { Prisma, PrismaClient } from '@prisma/client';

import {
  bookingMinutes, findShortages, mergeLines, occupancyOf, priceLines, freeQuantity, rentalsForMove,
  trimToFree,
  type CurrentLine, type MoveResult, type Occupancy, type PricedLine, type RentableItem,
  type RentalStatus, type RentRequestLine, type Shortage, type TrimResult,
} from './rentals';

type Db = PrismaClient | Prisma.TransactionClient;

/** Ті самі статуси, що займають корт. EXPIRED і CANCELLED резерв звільняють. */
const BUSY = ['PENDING', 'CONFIRMED'] as const;

/**
 * Помилка прокату всередині транзакції. Кидаємо, щоб Prisma відкотила
 * бронь разом із рядками; обробник роуту перекладає її в HTTP.
 */
export class RentalError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'RENTAL_BUSY' | 'RENTAL_NOT_AVAILABLE',
    readonly details: { shortages?: Shortage[]; itemId?: string } = {},
  ) {
    super(code);
  }
}

/** Блокує позиції клубу й повертає їх у вигляді для прокату. */
export async function lockRentableItems(
  tx: Prisma.TransactionClient,
  clubId: string,
  itemIds: string[],
): Promise<Map<string, RentableItem>> {
  const ids = [...new Set(itemIds)].sort();
  if (ids.length === 0) return new Map();

  const rows = await tx.$queryRaw<RentableItem[]>`
    SELECT "id", "name", "quantity", "rentPrice", "rentMode"::text AS "rentMode", "returnable"
      FROM "InventoryItem"
     WHERE "clubId" = ${clubId}::uuid AND "id" = ANY(${ids}::uuid[])
     ORDER BY "id"
       FOR UPDATE`;

  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Зайнятість позицій іншими бронями на інтервалі.
 *
 * Крім броней, що перетинаються з [start, end), сюди потрапляє те, що
 * ВИДАНО на руки й ще не прийнято: поворотна річ не звільняється з кінцем
 * чужої броні, вона звільняється, коли її принесли назад. Клієнт затримав
 * ракетки — наступному їх немає, навіть якщо корт за часом вільний.
 *
 * Скільки саме тримає кожен рядок, вирішує `occupancyOf()` у lib/rentals.ts:
 * витратна позиція після видачі вже списана з quantity й не тримає нічого.
 *
 * `excludeBookingId` — власна бронь при правці чи перенесенні: інакше вона
 * конкурувала б сама з собою за ті самі ракетки.
 */
export async function loadOccupancy(
  db: Db,
  clubId: string,
  itemIds: string[],
  start: Date,
  end: Date,
  excludeBookingId?: string,
): Promise<Map<string, Occupancy[]>> {
  const map = new Map<string, Occupancy[]>();
  if (itemIds.length === 0) return map;

  const rows = await db.bookingRental.findMany({
    where: {
      clubId,
      itemId: { in: [...new Set(itemIds)] },
      booking: {
        startTime: { lt: end },
        ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
      },
      OR: [
        /* Звичайний перетин інтервалів живої броні. */
        { booking: { status: { in: [...BUSY] }, endTime: { gt: start } } },
        /* Або річ на руках — її бронь могла скінчитись позавчора чи бути
           скасованою, поки ракетки в клієнта: статус броні річ не повертає. */
        { status: 'ISSUED', returnable: true },
      ],
    },
    select: {
      itemId: true, quantity: true, status: true, returnable: true,
      booking: { select: { startTime: true, endTime: true } },
    },
  });

  for (const r of rows) {
    const occupancy = occupancyOf(r, r.booking.startTime, r.booking.endTime);
    if (!occupancy) continue;
    const list = map.get(r.itemId) ?? [];
    list.push(occupancy);
    map.set(r.itemId, list);
  }
  return map;
}

/**
 * Резерв прокату під замком. Викликати ВСЕРЕДИНІ транзакції, що створює
 * або змінює бронь: рядки BookingRental мають записатись до того, як
 * замок відпуститься.
 *
 * Кидає RentalError, якщо позиція не здається або її не вистачає.
 */
export async function reserveRentals(
  tx: Prisma.TransactionClient,
  args: {
    clubId: string;
    start: Date;
    end: Date;
    request: RentRequestLine[];
    excludeBookingId?: string;
  },
): Promise<{ lines: PricedLine[]; total: number }> {
  const request = mergeLines(args.request);
  if (request.length === 0) return { lines: [], total: 0 };

  const ids = request.map((r) => r.itemId);
  const items = await lockRentableItems(tx, args.clubId, ids);

  const priced = priceLines(request, items, bookingMinutes(args.start, args.end));
  if (!priced.ok) throw new RentalError(409, 'RENTAL_NOT_AVAILABLE', { itemId: priced.itemId });

  const occupancy = await loadOccupancy(tx, args.clubId, ids, args.start, args.end, args.excludeBookingId);
  const shortages = findShortages(request, items, occupancy, args.start, args.end);
  if (shortages.length > 0) throw new RentalError(409, 'RENTAL_BUSY', { shortages });

  return { lines: priced.lines, total: priced.total };
}

/**
 * Попередній розрахунок без замка — щоб до транзакції знати суму броні
 * (від неї залежить, чи потрібна передоплата). Під замком сума
 * перераховується ще раз, і якщо позиція за цей час подорожчала чи
 * перестала здаватись, транзакція відмовить.
 */
export async function previewRentals(
  db: Db,
  clubId: string,
  request: RentRequestLine[],
  start: Date,
  end: Date,
): Promise<{ ok: true; lines: PricedLine[]; total: number } | { ok: false; itemId: string }> {
  const merged = mergeLines(request);
  if (merged.length === 0) return { ok: true, lines: [], total: 0 };

  const rows = await db.inventoryItem.findMany({
    where: { clubId, id: { in: merged.map((r) => r.itemId) } },
    select: { id: true, name: true, quantity: true, rentPrice: true, rentMode: true, returnable: true },
  });
  const priced = priceLines(merged, new Map(rows.map((r) => [r.id, r])), bookingMinutes(start, end));
  return priced.ok ? priced : { ok: false, itemId: priced.itemId };
}

/**
 * Перераховує прокат броні на новий час і записує рядки.
 *
 * Нічого не знімає й не урізає: чек-лист перенесенню не належить (див.
 * `rentalsForMove` у lib/rentals.ts). Міняється тільки сума HOURLY-позицій,
 * бо тривалість стала іншою. Саму бронь (priceTotal, rentalTotal) НЕ чіпає —
 * викликач пише її разом з іншими полями, а різницю бере з `delta`.
 *
 * Нестача на новий час повертається в `shortages` як попередження для
 * адміністратора. Викликати в транзакції.
 */
export async function recalcRentalsForMove(
  tx: Prisma.TransactionClient,
  booking: { id: string; clubId: string },
  current: CurrentLine[],
  start: Date,
  end: Date,
): Promise<MoveResult> {
  const ids = current.map((r) => r.itemId);
  const items = await lockRentableItems(tx, booking.clubId, ids);
  const occupancy = await loadOccupancy(tx, booking.clubId, ids, start, end, booking.id);
  const free = new Map(ids.map((id) => [
    id,
    freeQuantity(items.get(id)?.quantity ?? 0, occupancy.get(id) ?? [], start, end),
  ]));

  const move = rentalsForMove(current, free, bookingMinutes(start, end));

  for (const line of move.lines) {
    /* Сума рядка й так перерахована в памʼяті — у базу йде тільки те, що
       змінилось, щоб не переписувати весь чек-лист на кожен перенос. */
    const was = current.find((c) => c.id === line.id);
    if (was && was.amount === line.amount) continue;
    await tx.bookingRental.update({ where: { id: line.id }, data: { amount: line.amount } });
  }

  return move;
}

/**
 * Списує витратну позицію зі складу. Викликати в транзакції, ПІСЛЯ
 * lockRentableItems: залишок читається й пишеться під тим самим замком.
 *
 * `sign` = -1 при видачі, +1 при скасуванні помилкової видачі (undo).
 * Нижче нуля не опускаємось: якщо в коморі порахували менше, ніж видали,
 * бреше комора, а видачу зупиняти пізно — клієнт уже з водою.
 */
export async function shiftStock(
  tx: Prisma.TransactionClient,
  itemId: string,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  await tx.$executeRaw`
    UPDATE "InventoryItem"
       SET "quantity" = GREATEST(0, "quantity" + ${delta})
     WHERE "id" = ${itemId}::uuid`;
}

/** Дані рядка для nested create у Booking. */
export const rentalCreateData = (clubId: string, lines: PricedLine[]) =>
  lines.map((l) => ({
    clubId,
    itemId: l.itemId,
    itemName: l.itemName,
    quantity: l.quantity,
    mode: l.mode,
    unitPrice: l.unitPrice,
    amount: l.amount,
    returnable: l.returnable,
  }));

/**
 * Що можна взяти напрокат на цей інтервал — для віджета й кабінету.
 * Без інтервалу `free` = null: список показується, але обіцянки немає.
 * `excludeBookingId` — кабінет править прокат цієї броні: її власні ракетки
 * рахуються вільними для неї самої.
 */
export async function listRentables(db: Db, clubId: string, start?: Date, end?: Date, excludeBookingId?: string) {
  const items = await db.inventoryItem.findMany({
    where: { clubId, rentPrice: { not: null } },
    select: {
      id: true, name: true, category: true, unit: true, quantity: true,
      rentPrice: true, rentMode: true, returnable: true, photoMime: true, photoUpdatedAt: true,
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

  const occupancy = start && end
    ? await loadOccupancy(db, clubId, items.map((i) => i.id), start, end, excludeBookingId)
    : new Map<string, Occupancy[]>();

  return items.map((i) => ({
    id: i.id,
    name: i.name,
    category: i.category,
    unit: i.unit,
    rentPrice: i.rentPrice!,
    rentMode: i.rentMode,
    returnable: i.returnable,
    photoUrl: i.photoMime
      ? `/api/public/inventory/${i.id}/photo?v=${i.photoUpdatedAt?.getTime() ?? 0}`
      : null,
    free: start && end ? freeQuantity(i.quantity, occupancy.get(i.id) ?? [], start, end) : null,
  }));
}

/**
 * Урізає прокат броні до того, що справді вільно, і пише рядки.
 *
 * Оплата прийшла після того, як холд протух: корт бронь зберігає, а
 * ракетки за цей час могли піти іншим. Правила урізання — `trimToFree`
 * у lib/rentals.ts, тут — замок, читання зайнятості й запис.
 *
 * Рядок, від якого не лишилось нічого, видаляється: у BookingRental
 * стоїть CHECK quantity > 0, нульового рядка база не тримає.
 *
 * Саму бронь (priceTotal, rentalTotal) НЕ чіпає — викликач пише її сам,
 * різницю бере з `delta`. Викликати в транзакції.
 */
export async function trimRentalsToFree(
  tx: Prisma.TransactionClient,
  booking: { id: string; clubId: string },
  current: Array<CurrentLine & { status: RentalStatus }>,
  start: Date,
  end: Date,
): Promise<TrimResult> {
  /* Видане на руки не урізається: річ уже в клієнта. Повернене не займає
     нічого й ціни не змінює. */
  const trimmable = current.filter((l) => l.status !== 'ISSUED' && l.status !== 'RETURNED');
  if (trimmable.length === 0) {
    return { lines: [], cuts: [], rentalTotal: current.reduce((sum, l) => sum + l.amount, 0), delta: 0 };
  }

  const ids = trimmable.map((l) => l.itemId);
  const items = await lockRentableItems(tx, booking.clubId, ids);
  const occupancy = await loadOccupancy(tx, booking.clubId, ids, start, end, booking.id);
  const free = new Map(ids.map((id) => [
    id,
    freeQuantity(items.get(id)?.quantity ?? 0, occupancy.get(id) ?? [], start, end),
  ]));

  const trim = trimToFree(trimmable, free, bookingMinutes(start, end));

  const gone = trim.lines.filter((l) => l.quantity === 0).map((l) => l.id);
  if (gone.length) await tx.bookingRental.deleteMany({ where: { id: { in: gone } } });
  for (const line of trim.lines) {
    if (line.quantity === 0) continue;
    const was = trimmable.find((c) => c.id === line.id);
    if (was && was.quantity === line.quantity && was.amount === line.amount) continue;
    await tx.bookingRental.update({ where: { id: line.id }, data: { quantity: line.quantity, amount: line.amount } });
  }

  /* rentalTotal броні — це всі рядки, а не тільки урізані. */
  const untouched = current
    .filter((l) => l.status === 'ISSUED' || l.status === 'RETURNED')
    .reduce((sum, l) => sum + l.amount, 0);
  return { ...trim, rentalTotal: trim.rentalTotal + untouched };
}
