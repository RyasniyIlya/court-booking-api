import { describe, it, expect } from 'vitest';

import {
  bookingMinutes, unitAmount, lineAmount, mergeLines, peakUsage, freeQuantity,
  priceLines, findShortages, rentalsForMove, overbookings, priceEdit,
  occupancyOf, onHand, extendConflicts, ON_HAND_END,
  type RentableItem, type CurrentLine,
} from './rentals';

/**
 * Прокат при броні.
 *
 * Головне, що тут стережемо: гравцю не відмовляють, коли ракетки лежать на
 * полиці (пік, а не сума перетинів), і не продають одну ракетку двом, коли
 * броні стикуються рівно о 19:00.
 */

const at = (hhmm: string) => new Date(`2026-10-03T${hhmm}:00.000Z`);

const racket: RentableItem = { id: 'r', name: 'Ракетка Wilson', quantity: 8, rentPrice: 10_000, rentMode: 'HOURLY', returnable: true };
const balls: RentableItem = { id: 'b', name: 'Мʼячі', quantity: 20, rentPrice: 5_000, rentMode: 'FIXED', returnable: true };
const cover: RentableItem = { id: 'c', name: 'Чохол', quantity: 8, rentPrice: null, rentMode: 'FIXED', returnable: true };
const water: RentableItem = { id: 'w', name: 'Вода', quantity: 30, rentPrice: 2_000, rentMode: 'FIXED', returnable: false };
const items = new Map([racket, balls, cover, water].map((i) => [i.id, i]));

describe('ціна', () => {
  it('FIXED — за видачу, тривалість не важить', () => {
    expect(lineAmount('FIXED', 5_000, 2, 30)).toBe(10_000);
    expect(lineAmount('FIXED', 5_000, 2, 180)).toBe(10_000);
  });

  it('HOURLY — ставка × тривалість', () => {
    expect(lineAmount('HOURLY', 10_000, 1, 60)).toBe(10_000);
    expect(lineAmount('HOURLY', 10_000, 2, 90)).toBe(30_000);
  });

  it('HOURLY округлюється на одиницю, потім × кількість', () => {
    // 10 001 коп × 50/60 = 8 334.17 → 8 334 за ракетку, три ракетки — рівно втричі
    expect(unitAmount('HOURLY', 10_001, 50)).toBe(8_334);
    expect(lineAmount('HOURLY', 10_001, 3, 50)).toBe(25_002);
  });

  it('тривалість броні у хвилинах', () => {
    expect(bookingMinutes(at('18:00'), at('19:30'))).toBe(90);
    expect(bookingMinutes(at('19:00'), at('18:00'))).toBe(0);
  });
});

describe('mergeLines', () => {
  it('склеює повтори однієї позиції', () => {
    expect(mergeLines([
      { itemId: 'r', quantity: 1 },
      { itemId: 'b', quantity: 1 },
      { itemId: 'r', quantity: 2 },
    ])).toEqual([{ itemId: 'r', quantity: 3 }, { itemId: 'b', quantity: 1 }]);
  });
});

describe('peakUsage', () => {
  it('послідовні броні не складаються: пік, а не сума', () => {
    const occ = [
      { start: at('18:00'), end: at('18:30'), quantity: 5 },
      { start: at('18:30'), end: at('19:00'), quantity: 5 },
    ];
    expect(peakUsage(occ, at('18:00'), at('19:00'))).toBe(5);
    expect(freeQuantity(8, occ, at('18:00'), at('19:00'))).toBe(3);
  });

  it('перекриття складаються', () => {
    const occ = [
      { start: at('18:00'), end: at('19:00'), quantity: 3 },
      { start: at('18:30'), end: at('19:30'), quantity: 4 },
    ];
    expect(peakUsage(occ, at('18:00'), at('20:00'))).toBe(7);
  });

  it('стик о 19:00 — не перетин', () => {
    const occ = [{ start: at('17:00'), end: at('19:00'), quantity: 8 }];
    expect(freeQuantity(8, occ, at('19:00'), at('20:00'))).toBe(8);
  });

  it('рахує лише частину всередині запитаного інтервалу', () => {
    const occ = [
      { start: at('16:00'), end: at('18:00'), quantity: 6 },
      { start: at('17:30'), end: at('18:30'), quantity: 2 },
    ];
    // 17:30–18:00 зайнято 8, але це до 18:00 — на 18:00–19:00 лише 2
    expect(peakUsage(occ, at('18:00'), at('19:00'))).toBe(2);
  });

  it('вільне не буває відʼємним, коли склад зменшили під броні', () => {
    const occ = [{ start: at('18:00'), end: at('19:00'), quantity: 8 }];
    expect(freeQuantity(5, occ, at('18:00'), at('19:00'))).toBe(0);
  });
});

describe('priceLines', () => {
  it('знімок назви, режиму й ціни; сума рядків', () => {
    const r = priceLines([{ itemId: 'r', quantity: 2 }, { itemId: 'b', quantity: 1 }], items, 90);
    expect(r).toEqual({
      ok: true,
      total: 35_000,
      lines: [
        { itemId: 'r', itemName: 'Ракетка Wilson', quantity: 2, mode: 'HOURLY', unitPrice: 10_000, amount: 30_000, returnable: true },
        { itemId: 'b', itemName: 'Мʼячі', quantity: 1, mode: 'FIXED', unitPrice: 5_000, amount: 5_000, returnable: true },
      ],
    });
  });

  it('позиція без ціни — помилка всього запиту', () => {
    expect(priceLines([{ itemId: 'r', quantity: 1 }, { itemId: 'c', quantity: 1 }], items, 60))
      .toEqual({ ok: false, error: 'RENTAL_NOT_AVAILABLE', itemId: 'c' });
  });

  it('чужа або видалена позиція — та сама помилка', () => {
    expect(priceLines([{ itemId: 'x', quantity: 1 }], items, 60))
      .toEqual({ ok: false, error: 'RENTAL_NOT_AVAILABLE', itemId: 'x' });
  });

  it('нульова ціна — допустима', () => {
    const free = new Map([['z', { ...balls, id: 'z', rentPrice: 0 }]]);
    expect(priceLines([{ itemId: 'z', quantity: 3 }], free, 60)).toMatchObject({ ok: true, total: 0 });
  });
});

describe('findShortages', () => {
  const occupancy = new Map([['r', [{ start: at('18:00'), end: at('19:00'), quantity: 6 }]]]);

  it('вистачає — порожньо', () => {
    expect(findShortages([{ itemId: 'r', quantity: 2 }], items, occupancy, at('18:00'), at('19:00'))).toEqual([]);
  });

  it('не вистачає — скільки просили і скільки вільно', () => {
    expect(findShortages(
      [{ itemId: 'r', quantity: 2 }, { itemId: 'r', quantity: 1 }],
      items, occupancy, at('18:30'), at('19:30'),
    )).toEqual([{ itemId: 'r', requested: 3, free: 2 }]);
  });
});

describe('rentalsForMove — перенесення не чіпає чек-лист', () => {
  const current: CurrentLine[] = [
    { id: 'l1', itemId: 'r', itemName: 'Ракетка Wilson', quantity: 2, mode: 'HOURLY', unitPrice: 10_000, amount: 20_000, returnable: true },
    { id: 'l2', itemId: 'b', itemName: 'Мʼячі', quantity: 1, mode: 'FIXED', unitPrice: 5_000, amount: 5_000, returnable: true },
  ];

  it('усе є — HOURLY перераховується на нову тривалість', () => {
    const r = rentalsForMove(current, new Map([['r', 8], ['b', 20]]), 90);
    expect(r.shortages).toEqual([]);
    expect(r.lines.map((l) => l.amount)).toEqual([30_000, 5_000]);
    expect(r.rentalTotal).toBe(35_000);
    expect(r.delta).toBe(10_000);
  });

  it('на новий час не вистачає — попереджає, але нічого не знімає', () => {
    const r = rentalsForMove(current, new Map([['r', 1], ['b', 20]]), 60);
    expect(r.shortages).toEqual([
      { itemId: 'r', itemName: 'Ракетка Wilson', requested: 2, free: 1 },
    ]);
    expect(r.lines.map((l) => l.quantity)).toEqual([2, 1]);
    expect(r.rentalTotal).toBe(25_000);
    expect(r.delta).toBe(0);
  });

  it('позиції немає зовсім — теж лише попередження', () => {
    const r = rentalsForMove(current, new Map([['r', 8]]), 60);
    expect(r.shortages).toEqual([
      { itemId: 'b', itemName: 'Мʼячі', requested: 1, free: 0 },
    ]);
    expect(r.lines).toHaveLength(2);
    expect(r.rentalTotal).toBe(25_000);
  });

  it('ціна за знімком, а не за поточною позицією', () => {
    const r = rentalsForMove([{ ...current[0], unitPrice: 8_000, amount: 16_000 }], new Map([['r', 8]]), 60);
    expect(r.lines[0].amount).toBe(16_000);
  });
});

describe('occupancyOf — що саме тримає рядок чек-листа', () => {
  const from = at('18:00');
  const to = at('19:00');

  it('заплановане тримає рівно інтервал броні', () => {
    expect(occupancyOf({ quantity: 2, status: 'RESERVED', returnable: true }, from, to))
      .toEqual({ start: from, end: to, quantity: 2 });
  });

  it('видана поворотна річ тримає, доки її не прийняли', () => {
    expect(occupancyOf({ quantity: 2, status: 'ISSUED', returnable: true }, from, to))
      .toEqual({ start: from, end: ON_HAND_END, quantity: 2 });
  });

  it('видана витратна вже списана — не тримає нічого', () => {
    expect(occupancyOf({ quantity: 2, status: 'ISSUED', returnable: false }, from, to)).toBeNull();
  });

  it('повернена — вільна', () => {
    expect(occupancyOf({ quantity: 2, status: 'RETURNED', returnable: true }, from, to)).toBeNull();
  });

  it('затримана ракетка недоступна наступній броні, хоч корт уже вільний', () => {
    const held = occupancyOf({ quantity: 6, status: 'ISSUED', returnable: true }, at('18:00'), at('19:00'))!;
    expect(freeQuantity(8, [held], at('20:00'), at('21:00'))).toBe(2);
  });
});

describe('onHand', () => {
  it('лише видане й поворотне', () => {
    const lines = [
      { id: 'a', quantity: 1, status: 'RESERVED' as const, returnable: true },
      { id: 'b', quantity: 1, status: 'ISSUED' as const, returnable: true },
      { id: 'c', quantity: 1, status: 'ISSUED' as const, returnable: false },
      { id: 'd', quantity: 1, status: 'RETURNED' as const, returnable: true },
    ];
    expect(onHand(lines).map((l) => l.id)).toEqual(['b']);
  });
});

describe('extendConflicts', () => {
  const held = [{ itemId: 'r', itemName: 'Ракетка Wilson', quantity: 2 }];

  it('наступна бронь чекає те, що на руках', () => {
    expect(extendConflicts(held, [
      { itemId: 'r', quantity: 1, bookingId: 'next', startTime: at('19:00') },
    ])).toEqual([
      { itemId: 'r', itemName: 'Ракетка Wilson', onHand: 2, needed: 1, bookingId: 'next', startTime: at('19:00') },
    ]);
  });

  it('чужа позиція конфліктом не є', () => {
    expect(extendConflicts(held, [
      { itemId: 'b', quantity: 1, bookingId: 'next', startTime: at('19:00') },
    ])).toEqual([]);
  });

  it('найближча бронь — першою', () => {
    const r = extendConflicts(held, [
      { itemId: 'r', quantity: 1, bookingId: 'later', startTime: at('21:00') },
      { itemId: 'r', quantity: 1, bookingId: 'soon', startTime: at('19:00') },
    ]);
    expect(r.map((c) => c.bookingId)).toEqual(['soon', 'later']);
  });
});

describe('priceEdit', () => {
  const current: CurrentLine[] = [
    { id: 'l1', itemId: 'r', itemName: 'Ракетка (стара назва)', quantity: 1, mode: 'HOURLY', unitPrice: 8_000, amount: 8_000, returnable: true },
    { id: 'l2', itemId: 'b', itemName: 'Мʼячі', quantity: 1, mode: 'FIXED', unitPrice: 5_000, amount: 5_000, returnable: true },
  ];

  it('наявна позиція — за знімком, нова — за поточною ціною, прибрана — у removedIds', () => {
    const extra: RentableItem = { id: 'n', name: 'Сітка', quantity: 2, rentPrice: 3_000, rentMode: 'FIXED', returnable: true };
    const r = priceEdit(
      [{ itemId: 'r', quantity: 2 }, { itemId: 'n', quantity: 1 }],
      current, new Map([...items, ['n', extra]]), 60,
    );
    expect(r).toEqual({
      ok: true,
      removedIds: ['l2'],
      total: 19_000,
      lines: [
        { itemId: 'r', itemName: 'Ракетка (стара назва)', mode: 'HOURLY', unitPrice: 8_000, quantity: 2, amount: 16_000, existingId: 'l1', returnable: true },
        { itemId: 'n', itemName: 'Сітка', mode: 'FIXED', unitPrice: 3_000, quantity: 1, amount: 3_000, returnable: true },
      ],
    });
  });

  it('вимкнену з прокату позицію, що вже в броні, можна лишити чи зменшити', () => {
    const off = new Map([['b', { ...balls, rentPrice: null }]]);
    expect(priceEdit([{ itemId: 'b', quantity: 1 }], current, off, 60)).toMatchObject({ ok: true, total: 5_000 });
  });

  it('нову позицію без ціни додати не можна', () => {
    expect(priceEdit([{ itemId: 'c', quantity: 1 }], current, items, 60))
      .toEqual({ ok: false, error: 'RENTAL_NOT_AVAILABLE', itemId: 'c' });
  });
});

describe('overbookings', () => {
  it('зменшення складу нижче піку показує броні в перетині', () => {
    const r = overbookings(5, [
      { bookingId: 'A', start: at('18:00'), end: at('19:00'), quantity: 4 },
      { bookingId: 'B', start: at('18:30'), end: at('19:30'), quantity: 4 },
      { bookingId: 'C', start: at('20:00'), end: at('21:00'), quantity: 5 },
    ]);
    expect(r.sort((x, y) => x.bookingId.localeCompare(y.bookingId))).toEqual([
      { bookingId: 'A', shortBy: 3 },
      { bookingId: 'B', shortBy: 3 },
    ]);
  });

  it('стик о 19:00 — не перебір', () => {
    expect(overbookings(5, [
      { bookingId: 'A', start: at('18:00'), end: at('19:00'), quantity: 5 },
      { bookingId: 'B', start: at('19:00'), end: at('20:00'), quantity: 5 },
    ])).toEqual([]);
  });

  it('склад з запасом — порожньо', () => {
    expect(overbookings(12, [{ bookingId: 'A', start: at('18:00'), end: at('19:00'), quantity: 8 }])).toEqual([]);
  });
});
