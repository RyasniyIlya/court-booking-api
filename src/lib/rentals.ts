/**
 * Прокат інвентарю при броні — чиста логіка, без бази.
 *
 * Роути (створення броні, додавання адміном, перенесення, правка комори)
 * читають рядки з бази й питають цей модуль, скільки вільно і скільки
 * коштує. Так усі чотири місця відповідають однаково, а правила
 * перевіряються тестами без Postgres.
 *
 * ── Залишок ──────────────────────────────────────────────────────────────
 * `InventoryItem.quantity` — скільки речей у клубу взагалі. Видача й
 * повернення його не чіпають. Зайнятість — це рядки BookingRental у бронях
 * PENDING/CONFIRMED, що перетинають інтервал.
 *
 * Рахуємо ПІК одночасної зайнятості, а не суму перетинів: якщо 18:00–18:30
 * зайнято 5 ракеток і 18:30–19:00 ще 5, то на 18:00–19:00 із 8 вільні 3, а
 * не 0. Сума перетинів відмовляла б людям, коли ракетки лежать на полиці.
 *
 * ── Ціна ─────────────────────────────────────────────────────────────────
 * FIXED — за видачу. HOURLY — ставка × тривалість броні, округлена до
 * копійки на ОДИНИЦЮ, а потім × кількість: так ціна «за ракетку» на екрані
 * множиться на кількість без копійки розбіжності. Округлення те саме, що в
 * ставки тренера (`Math.round(pricePerHour * minutes / 60)`).
 *
 * Знижки й акції на прокат не діють: сума рядків іде в priceTotal після
 * знижки і дорівнює rentalTotal копійка в копійку.
 *
 * ── Поворотні й витратні ─────────────────────────────────────────────────
 * Ракетку повертають, воду — ні, і різниця не косметична:
 *
 *  - поворотна річ при видачі зі складу НЕ списується, але й не звільняється
 *    з кінцем броні: вона на руках, доки її не прийняли. Тому її зайнятість
 *    тягнеться до `ON_HAND_END`, а не до кінця броні;
 *  - витратна при видачі списується з `InventoryItem.quantity` назавжди і
 *    після цього не займає нічого — її просто немає.
 *
 * Через це рядок у статусі RESERVED і той самий рядок у ISSUED займають
 * різне, і рахує це `occupancyOf()`, а не той, хто будує запит.
 */

export type RentMode = 'FIXED' | 'HOURLY';

/** Більше за це в одному рядку — майже напевно зайвий нуль у полі. */
export const MAX_RENT_QUANTITY = 50;
/** Скільки різних позицій можна взяти в одну бронь. */
export const MAX_RENT_LINES = 10;

export type RentRequestLine = { itemId: string; quantity: number };

/** Позиція комори в тому вигляді, який потрібен прокату. */
export type RentableItem = {
  id: string;
  name: string;
  quantity: number;
  rentPrice: number | null;
  rentMode: RentMode;
  /** Ракетку повертають, воду — ні. Див. шапку файлу. */
  returnable: boolean;
};

/** Рядок прокату, готовий до запису в BookingRental. */
export type PricedLine = {
  itemId: string;
  itemName: string;
  quantity: number;
  mode: RentMode;
  unitPrice: number;
  amount: number;
  /** Знімок із позиції: клуб може перевести її у витратні вже завтра. */
  returnable: boolean;
};

/** Зайнятість позиції іншою бронню. */
export type Occupancy = { start: Date; end: Date; quantity: number };

export type Shortage = { itemId: string; requested: number; free: number };

/** Хвилини броні. Округлення до цілих — інтервали в системі кратні хвилині. */
export const bookingMinutes = (start: Date, end: Date) =>
  Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));

/** Ціна однієї одиниці на цю тривалість. */
export function unitAmount(mode: RentMode, unitPrice: number, minutes: number): number {
  return mode === 'HOURLY' ? Math.round((unitPrice * minutes) / 60) : unitPrice;
}

/** Підсумок рядка. */
export function lineAmount(mode: RentMode, unitPrice: number, quantity: number, minutes: number): number {
  return unitAmount(mode, unitPrice, minutes) * quantity;
}

/**
 * Зводить повтори однієї позиції в один рядок.
 *
 * Віджет шле по рядку на позицію, але двічі натиснута кнопка чи ручний
 * запит можуть дати дубль. У базі рядок на позицію унікальний, тож
 * склеюємо тут, а не ловимо помилку унікальності.
 */
export function mergeLines(lines: RentRequestLine[]): RentRequestLine[] {
  const byItem = new Map<string, number>();
  for (const l of lines) byItem.set(l.itemId, (byItem.get(l.itemId) ?? 0) + l.quantity);
  return [...byItem].map(([itemId, quantity]) => ({ itemId, quantity }));
}

/**
 * Найбільша одночасна зайнятість усередині [start, end).
 *
 * Інтервали напіввідкриті, як у EXCLUDE-констрейнтах броней: бронь до 19:00
 * і бронь з 19:00 не перетинаються. Тому на однаковому моменті кінець
 * обробляється раніше за початок.
 */
export function peakUsage(occupancies: Occupancy[], start: Date, end: Date): number {
  const from = start.getTime();
  const to = end.getTime();
  const events: Array<[number, number]> = [];

  for (const o of occupancies) {
    const s = Math.max(o.start.getTime(), from);
    const e = Math.min(o.end.getTime(), to);
    if (s >= e || o.quantity <= 0) continue;
    events.push([s, o.quantity], [e, -o.quantity]);
  }

  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > peak) peak = current;
  }
  return peak;
}

/** Скільки одиниць вільно на весь інтервал. Ніколи не відʼємне. */
export function freeQuantity(stock: number, occupancies: Occupancy[], start: Date, end: Date): number {
  return Math.max(0, stock - peakUsage(occupancies, start, end));
}

/**
 * Рахує рядки запиту. Позиція, якої немає в клубі або яка не здається
 * (rentPrice = null), — помилка всього запиту, а не мовчки викинутий рядок:
 * гравець бачив цю ракетку у віджеті й має дізнатися, що її вже нема.
 */
export function priceLines(
  request: RentRequestLine[],
  items: Map<string, RentableItem>,
  minutes: number,
): { ok: true; lines: PricedLine[]; total: number } | { ok: false; error: 'RENTAL_NOT_AVAILABLE'; itemId: string } {
  const lines: PricedLine[] = [];

  for (const r of mergeLines(request)) {
    const item = items.get(r.itemId);
    if (!item || item.rentPrice === null) {
      return { ok: false, error: 'RENTAL_NOT_AVAILABLE', itemId: r.itemId };
    }
    lines.push({
      itemId: item.id,
      itemName: item.name,
      quantity: r.quantity,
      mode: item.rentMode,
      unitPrice: item.rentPrice,
      amount: lineAmount(item.rentMode, item.rentPrice, r.quantity, minutes),
      returnable: item.returnable,
    });
  }

  return { ok: true, lines, total: lines.reduce((sum, l) => sum + l.amount, 0) };
}

/**
 * Чого не вистачає на цей інтервал.
 *
 * `occupancy` — зайнятість ІНШИМИ бронями: при перерахунку власної броні
 * її рядки треба виключити ще в запиті, інакше бронь конкурує сама з собою.
 */
export function findShortages(
  request: RentRequestLine[],
  items: Map<string, Pick<RentableItem, 'quantity'>>,
  occupancy: Map<string, Occupancy[]>,
  start: Date,
  end: Date,
): Shortage[] {
  const shortages: Shortage[] = [];
  for (const r of mergeLines(request)) {
    const stock = items.get(r.itemId)?.quantity ?? 0;
    const free = freeQuantity(stock, occupancy.get(r.itemId) ?? [], start, end);
    if (r.quantity > free) shortages.push({ itemId: r.itemId, requested: r.quantity, free });
  }
  return shortages;
}

export type CurrentLine = PricedLine & { id: string };

/**
 * Новий набір прокату для вже створеної броні (правка адміністратором).
 *
 * Позиція, що вже була в броні, рахується за ЗНІМКОМ ціни: адміністратор
 * додав другу ракетку — клієнт платить за неї стільки ж, скільки за першу,
 * навіть якщо позиція відтоді подорожчала або її вимкнули з прокату.
 * Нова позиція — за поточною ціною і лише якщо вона здається.
 *
 * `existingId` є у рядків, які оновлюються, а не створюються: у них
 * зберігається статус видачі.
 */
export function priceEdit(
  request: RentRequestLine[],
  current: CurrentLine[],
  items: Map<string, RentableItem>,
  minutes: number,
):
  | { ok: true; lines: Array<PricedLine & { existingId?: string }>; removedIds: string[]; total: number }
  | { ok: false; error: 'RENTAL_NOT_AVAILABLE'; itemId: string } {
  const byItem = new Map(current.map((l) => [l.itemId, l]));
  const lines: Array<PricedLine & { existingId?: string }> = [];

  for (const r of mergeLines(request)) {
    const had = byItem.get(r.itemId);
    if (had) {
      lines.push({
        itemId: had.itemId, itemName: had.itemName, mode: had.mode, unitPrice: had.unitPrice,
        returnable: had.returnable,
        quantity: r.quantity,
        amount: lineAmount(had.mode, had.unitPrice, r.quantity, minutes),
        existingId: had.id,
      });
      continue;
    }
    const item = items.get(r.itemId);
    if (!item || item.rentPrice === null) return { ok: false, error: 'RENTAL_NOT_AVAILABLE', itemId: r.itemId };
    lines.push({
      itemId: item.id, itemName: item.name, mode: item.rentMode, unitPrice: item.rentPrice,
      returnable: item.returnable,
      quantity: r.quantity,
      amount: lineAmount(item.rentMode, item.rentPrice, r.quantity, minutes),
    });
  }

  const kept = new Set(lines.map((l) => l.itemId));
  const removedIds = current.filter((l) => !kept.has(l.itemId)).map((l) => l.id);
  return { ok: true, lines, removedIds, total: lines.reduce((sum, l) => sum + l.amount, 0) };
}

export type RentalStatus = 'RESERVED' | 'ISSUED' | 'RETURNED';

/**
 * Кінець «на руках»: видану поворотну річ ніхто не звільняє за розкладом,
 * її звільняє людина, яка її прийняла. До того вона зайнята — навіть якщо
 * корт за часом давно вільний.
 *
 * Конкретна дата, а не Infinity, бо це значення їде в порівняння дат і в
 * запити; 9999 рік переживе і клуб, і нас.
 */
export const ON_HAND_END = new Date('9999-12-31T00:00:00.000Z');

/** Рядок чек-листа в тому вигляді, який потрібен розрахунку зайнятості. */
export type ChecklistLine = {
  quantity: number;
  status: RentalStatus;
  returnable: boolean;
};

/**
 * Що займає цей рядок чек-листа на інтервалі своєї броні.
 *
 *  - RESERVED — намір: тримає річ на час броні, щоб її не продали двічі;
 *  - ISSUED поворотна — на руках: тримає з початку броні й доки не приймуть;
 *  - ISSUED витратна — вже списана з quantity, більше нічого не тримає;
 *  - RETURNED — повернена, вільна.
 *
 * `null` означає «нічого не займає».
 */
export function occupancyOf(
  line: ChecklistLine,
  bookingStart: Date,
  bookingEnd: Date,
): Occupancy | null {
  if (line.quantity <= 0) return null;
  if (line.status === 'RETURNED') return null;
  if (line.status === 'ISSUED') {
    return line.returnable
      ? { start: bookingStart, end: ON_HAND_END, quantity: line.quantity }
      : null;
  }
  return { start: bookingStart, end: bookingEnd, quantity: line.quantity };
}

export type MoveResult = {
  /** Рядки з перерахованою на нову тривалість сумою. Склад не змінюється. */
  lines: CurrentLine[];
  /** Чого на новий час бракує. Попередження, а не відмова. */
  shortages: Array<{ itemId: string; itemName: string; requested: number; free: number }>;
  rentalTotal: number;
  /** Нова сума мінус стара. Відʼємне — переплата, яку клуб повертає. */
  delta: number;
};

/**
 * Прокат при перенесенні броні.
 *
 * Чек-лист переносу НЕ належить: переїжджає бронь, а видане залишається
 * виданим. Тому тут нічого не знімається й не урізається — рядки лишаються
 * як є, змінюється тільки сума HOURLY-позицій, бо тривалість стала іншою, і
 * ціна мусить збігтися з тим, що клієнт справді взяв. Ставка береться зі
 * знімка рядка: подорожчання позиції після броні клієнта не стосується.
 *
 * Якщо на новий час речей бракує, адміністратор бачить це попередженням і
 * вирішує сам — домовитись із наступним клієнтом, дати інший комплект.
 * Мовчки різати чужу бронь система права не має.
 *
 * `free` — вільно на новий інтервал без урахування самої цієї броні.
 */
export function rentalsForMove(
  current: CurrentLine[],
  free: Map<string, number>,
  minutes: number,
): MoveResult {
  const lines = current.map((line) => ({
    ...line,
    amount: lineAmount(line.mode, line.unitPrice, line.quantity, minutes),
  }));

  const shortages: MoveResult['shortages'] = [];
  for (const line of current) {
    const available = Math.max(0, free.get(line.itemId) ?? 0);
    if (line.quantity > available) {
      shortages.push({
        itemId: line.itemId, itemName: line.itemName,
        requested: line.quantity, free: available,
      });
    }
  }

  const before = current.reduce((sum, l) => sum + l.amount, 0);
  const rentalTotal = lines.reduce((sum, l) => sum + l.amount, 0);
  return { lines, shortages, rentalTotal, delta: rentalTotal - before };
}

/**
 * Що видано на руки й не прийнято назад.
 *
 * Потрібне двом місцям: кнопці «Прийняти інвентар» (що саме приймаємо) і
 * попередженню про конфлікт при продовженні (що з цього чекає наступна
 * бронь).
 */
export const onHand = <T extends ChecklistLine>(lines: T[]): T[] =>
  lines.filter((l) => l.status === 'ISSUED' && l.returnable);

export type ExtendConflict = {
  itemId: string;
  itemName: string;
  /** Скільки на руках у цього клієнта. */
  onHand: number;
  /** Скільки з них чекає наступна бронь. */
  needed: number;
  bookingId: string;
  startTime: Date;
};

/**
 * Конфлікт інвентарю при продовженні броні.
 *
 * Рішення свідомо обмежене: система ПОПЕРЕДЖАЄ, не блокує. Продовження —
 * це гроші в касі зараз, а ракетка знаходиться: у наступного клієнта може
 * бути свій комплект, або клуб домовиться. Автоматики розвʼязання конфлікту
 * тут немає навмисно.
 *
 * `held` — що ця бронь тримає на руках; `upcoming` — рядки чужих броней, що
 * потрапляють у продовжений інтервал.
 */
export function extendConflicts(
  held: Array<{ itemId: string; itemName: string; quantity: number }>,
  upcoming: Array<{ itemId: string; quantity: number; bookingId: string; startTime: Date }>,
): ExtendConflict[] {
  const byItem = new Map(held.map((h) => [h.itemId, h]));
  const conflicts: ExtendConflict[] = [];

  for (const next of upcoming) {
    const mine = byItem.get(next.itemId);
    if (!mine) continue;
    conflicts.push({
      itemId: next.itemId,
      itemName: mine.itemName,
      onHand: mine.quantity,
      needed: next.quantity,
      bookingId: next.bookingId,
      startTime: next.startTime,
    });
  }

  return conflicts.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

export type BookedRental = Occupancy & { bookingId: string };

/**
 * Броні, яким не вистачить речей, якщо залишок позиції стане `stock`.
 *
 * Потрібне правці комори: зменшити кількість можна (ракетки вже зламані),
 * але адміністратор має побачити, кого це зачепить. Бронь потрапляє в
 * список, якщо хоч у якийсь момент її інтервалу зайнято більше за
 * `stock`; `shortBy` — найбільший перебір за цей час.
 */
export function overbookings(stock: number, rentals: BookedRental[]): Array<{ bookingId: string; shortBy: number }> {
  const events: Array<{ t: number; delta: number; bookingId: string }> = [];
  for (const r of rentals) {
    if (r.start.getTime() >= r.end.getTime() || r.quantity <= 0) continue;
    events.push({ t: r.start.getTime(), delta: r.quantity, bookingId: r.bookingId });
    events.push({ t: r.end.getTime(), delta: -r.quantity, bookingId: r.bookingId });
  }
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);

  const active = new Map<string, number>();
  const shortBy = new Map<string, number>();
  let current = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    current += ev.delta;
    if (ev.delta > 0) active.set(ev.bookingId, (active.get(ev.bookingId) ?? 0) + 1);
    else {
      const left = (active.get(ev.bookingId) ?? 1) - 1;
      if (left > 0) active.set(ev.bookingId, left);
      else active.delete(ev.bookingId);
    }

    /* Стан оцінюємо лише після всіх подій одного моменту: інакше кінець
       однієї броні й початок наступної о 19:00 на мить виглядали б
       перебором, якого в житті немає. */
    const next = events[i + 1];
    if (next && next.t === ev.t) continue;

    const excess = current - stock;
    if (excess <= 0) continue;
    for (const id of active.keys()) {
      shortBy.set(id, Math.max(shortBy.get(id) ?? 0, excess));
    }
  }

  return [...shortBy].map(([bookingId, by]) => ({ bookingId, shortBy: by }));
}

/** Урізаний рядок: чого й наскільки не дорахувались. */
export type Cut = {
  itemId: string;
  itemName: string;
  /** Скільки було в броні. */
  from: number;
  /** Скільки лишилось після урізання; 0 — рядок знімається зовсім. */
  to: number;
};

export type TrimResult = {
  /** Рядки після урізання. `quantity` 0 означає «рядок прибрати». */
  lines: CurrentLine[];
  /** Що саме довелось урізати. Порожньо — все на місці. */
  cuts: Cut[];
  rentalTotal: number;
  /** Нова сума прокату мінус стара. Відʼємне — переплата, яку клуб повертає. */
  delta: number;
};

/**
 * Урізає прокат броні до того, що справді вільно.
 *
 * Потрібне одному місцю — оплаті, що прийшла ПІСЛЯ того, як холд протух
 * (див. lib/payments/apply.ts). Поки гравець платив, ракетки могли піти
 * іншим. Корт важливіший: бронь лишається, а інвентарю виписуємо стільки,
 * скільки є, різницю клуб повертає грошима.
 *
 * Видане на руки сюди не потрапляє — його відсіює викликач
 * (`trimRentalsToFree`): якщо річ уже в клієнта, урізати нічого.
 * Ставка береться зі знімка рядка — подорожчання позиції після броні
 * клієнта не стосується.
 *
 * `free` — вільно на інтервал броні без урахування самої цієї броні.
 */
export function trimToFree(
  current: CurrentLine[],
  free: Map<string, number>,
  minutes: number,
): TrimResult {
  const lines: CurrentLine[] = [];
  const cuts: Cut[] = [];

  for (const line of current) {
    const available = Math.max(0, free.get(line.itemId) ?? 0);
    const quantity = Math.min(line.quantity, available);
    if (quantity !== line.quantity) {
      cuts.push({ itemId: line.itemId, itemName: line.itemName, from: line.quantity, to: quantity });
    }
    lines.push({
      ...line,
      quantity,
      amount: lineAmount(line.mode, line.unitPrice, quantity, minutes),
    });
  }

  const before = current.reduce((sum, l) => sum + l.amount, 0);
  const rentalTotal = lines.reduce((sum, l) => sum + l.amount, 0);
  return { lines, cuts, rentalTotal, delta: rentalTotal - before };
}
