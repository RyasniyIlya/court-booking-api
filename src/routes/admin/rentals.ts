import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/db';
import { paymentStatusPatch } from '../../lib/bookingPaymentStatus';
import { RentalError, listRentables, loadOccupancy, lockRentableItems, shiftStock } from '../../lib/rentalStore';
import {
  MAX_RENT_LINES, MAX_RENT_QUANTITY, bookingMinutes, extendConflicts, findShortages, mergeLines,
  onHand, priceEdit,
} from '../../lib/rentals';
import { requireAuth, requireStaff, param } from './shared';

/**
 * /api/admin — прокат на бронях.
 *
 * Створення броні з прокатом живе в bookings.ts (там само, де й бронь).
 * Тут — те, що адміністратор робить із прокатом ПІСЛЯ: змінити набір,
 * видати, прийняти назад.
 *
 * Правила ті самі, що у віджеті: зверх вільного залишку не можна нікому,
 * адміністратору теж. Якщо ракетка насправді лежить у шафі — бреше
 * кількість у коморі, і виправляти треба там.
 *
 * ── Що таке чек-лист ─────────────────────────────────────────────────────
 * Рядки BookingRental і є чек-лист броні. Окремої «шапки» немає навмисно:
 * рядки й так живуть у власній таблиці, переживають перенесення броні й
 * можуть лишатись відкритими після її кінця — усе, заради чого шапку й
 * заводять. Чек-лист вважається закритим, коли на руках не лишилось нічого
 * поворотного.
 *
 * ── Склад ────────────────────────────────────────────────────────────────
 * Списання відбувається рівно в момент RESERVED → ISSUED і рівно для
 * витратних позицій: вода пішла назавжди. Поворотна річ з quantity не
 * зникає — вона просто зайнята, поки її не прийняли назад.
 */
export const rentalsRouter = Router();

const uuid = z.string().uuid();

/* Ті самі статуси, що займають корт (див. lib/rentalStore.ts). */
const ACTIVE_LIST = ['PENDING', 'CONFIRMED'] as const;
const ACTIVE: ReadonlySet<string> = new Set(ACTIVE_LIST);

/**
 * GET /api/admin/rentals/available?start=&end=[&bookingId=]
 *
 * Те саме, що публічний список, але з `bookingId`: власні ракетки броні,
 * яку правлять, рахуються вільними для неї.
 */
rentalsRouter.get('/rentals/available', requireAuth, requireStaff, async (req, res) => {
  const parsed = z.object({
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    bookingId: uuid.optional(),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const start = new Date(parsed.data.start);
  const end = new Date(parsed.data.end);
  if (end <= start) return res.status(400).json({ error: 'BAD_INTERVAL' });

  res.json(await listRentables(prisma, req.auth!.clubId, start, end, parsed.data.bookingId));
});

class EditError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

/**
 * PUT /api/admin/bookings/:id/rentals — увесь набір прокату броні.
 *
 * Тіло — повний список `[{ itemId, quantity }]`; чого в ньому немає, те
 * знімається. Рядок, що лишився, зберігає статус видачі й знімок ціни.
 *
 * Гроші — рівно як при зміні тренера: priceTotal = стара ціна − старий
 * прокат + новий, статус перераховується тим самим правилом оплати
 * (lib/bookingPaymentStatus.ts). Додали ракетку до прийнятої броні — вона
 * лишається CONFIRMED, а різниця висить боргом у касі; до броні під
 * онлайн-холдом — чекає доплати. Зняли — переплата, яку клуб повертає
 * звичайним записом повернення.
 *
 * Бронь блокується FOR UPDATE: два адміністратори, що правлять ту саму
 * бронь, інакше порахували б ціну кожен від старого rentalTotal.
 */
rentalsRouter.put('/bookings/:id/rentals', requireAuth, requireStaff, async (req, res) => {
  const id = uuid.safeParse(param(req, 'id'));
  const body = z.object({
    rentals: z.array(z.object({
      itemId: uuid,
      quantity: z.number().int().min(1).max(MAX_RENT_QUANTITY),
    })).max(MAX_RENT_LINES),
  }).safeParse(req.body);
  if (!id.success || !body.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const clubId = req.auth!.clubId;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Booking" WHERE "id" = ${id.data}::uuid AND "clubId" = ${clubId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new EditError(404, 'NOT_FOUND');

      const booking = await tx.booking.findUniqueOrThrow({
        where: { id: id.data },
        include: { rentals: true, payment: true, ledgerEntries: { where: { seatId: null } } },
      });

      if (booking.capacity !== null) throw new EditError(400, 'RENTALS_PRIVATE_ONLY');
      if (!ACTIVE.has(booking.status)) throw new EditError(409, 'BOOKING_INACTIVE');

      const request = mergeLines(body.data.rentals);
      const ids = [...new Set([...request.map((r) => r.itemId), ...booking.rentals.map((r) => r.itemId)])];
      const items = await lockRentableItems(tx, clubId, ids);

      const priced = priceEdit(request, booking.rentals, items, bookingMinutes(booking.startTime, booking.endTime));
      if (!priced.ok) throw new RentalError(409, 'RENTAL_NOT_AVAILABLE', { itemId: priced.itemId });

      const occupancy = await loadOccupancy(tx, clubId, ids, booking.startTime, booking.endTime, booking.id);
      const shortages = findShortages(request, items, occupancy, booking.startTime, booking.endTime);
      if (shortages.length > 0) throw new RentalError(409, 'RENTAL_BUSY', { shortages });

      const finalPrice = booking.priceTotal - booking.rentalTotal + priced.total;
      const settled = paymentStatusPatch({ booking, finalPrice });
      if (!settled.ok) throw new EditError(409, settled.error);

      if (priced.removedIds.length > 0) {
        await tx.bookingRental.deleteMany({ where: { id: { in: priced.removedIds } } });
      }
      for (const line of priced.lines) {
        if (line.existingId) {
          await tx.bookingRental.update({
            where: { id: line.existingId },
            data: { quantity: line.quantity, amount: line.amount },
          });
        } else {
          await tx.bookingRental.create({
            data: {
              clubId, bookingId: booking.id, itemId: line.itemId, itemName: line.itemName,
              quantity: line.quantity, mode: line.mode, unitPrice: line.unitPrice, amount: line.amount,
              returnable: line.returnable,
            },
          });
        }
      }

      return tx.booking.update({
        where: { id: booking.id },
        data: { priceTotal: finalPrice, rentalTotal: priced.total, ...settled.data },
        select: {
          id: true, status: true, priceTotal: true, rentalTotal: true,
          rentals: { orderBy: { createdAt: 'asc' } },
        },
      });
    });

    res.json(result);
  } catch (e) {
    if (e instanceof EditError) return res.status(e.status).json({ error: e.code });
    if (e instanceof RentalError) return res.status(e.status).json({ error: e.code, ...e.details });
    throw e;
  }
});

/**
 * POST /api/admin/rentals/:id/issue | /return
 *
 * Перехід лише вперед: RESERVED → ISSUED → RETURNED. Помилкову позначку
 * знімає `/undo`, щоб «повернув» не довелося вигадувати через правку набору.
 *
 * Видача — єдине місце, де рухається склад, і рухає його тільки витратна
 * позиція. Поворотна лишається в quantity й просто числиться на руках, доки
 * її не прийняли: до того вона недоступна іншій броні, навіть якщо корт за
 * часом уже вільний (`occupancyOf` у lib/rentals.ts).
 */
const TRANSITIONS = {
  issue: { from: 'RESERVED', to: 'ISSUED' } as const,
  return: { from: 'ISSUED', to: 'RETURNED' } as const,
};

/** Хто натиснув. У рядку зберігається пошта, а не id: її читає людина в касі. */
const actorEmail = async (userId: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })).email;

for (const action of ['issue', 'return'] as const) {
  rentalsRouter.post(`/rentals/:id/${action}`, requireAuth, requireStaff, async (req, res) => {
    const id = uuid.safeParse(param(req, 'id'));
    if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

    const clubId = req.auth!.clubId;
    const email = await actorEmail(req.auth!.userId);
    const { from, to } = TRANSITIONS[action];
    const now = new Date();

    try {
      const row = await prisma.$transaction(async (tx) => {
        /* Замок на позиції комори береться ДО перевірки статусу: списання
           витратної й читання залишку мають статись під одним замком, інакше
           двоє на стійці спишуть одну пляшку двічі. */
        const current = await tx.bookingRental.findFirst({
          where: { id: id.data, clubId },
          select: { id: true, itemId: true, quantity: true, returnable: true, status: true },
        });
        if (!current) throw new EditError(404, 'NOT_FOUND');
        await lockRentableItems(tx, clubId, [current.itemId]);

        /* Умова статусу — у самому update: двоє, що натиснули «Видано»
           разом, не запишуть видачу двічі, другий отримає 409. */
        const updated = await tx.bookingRental.updateMany({
          where: {
            id: id.data,
            clubId,
            status: from,
            ...(action === 'issue' ? { booking: { status: { in: [...ACTIVE_LIST] } } } : {}),
          },
          data: action === 'issue'
            ? { status: to, issuedAt: now, issuedBy: email }
            : { status: to, returnedAt: now, returnedBy: email },
        });
        if (updated.count === 0) throw new EditError(409, 'BAD_TRANSITION');

        if (action === 'issue' && !current.returnable) {
          await shiftStock(tx, current.itemId, -current.quantity);
        }

        return tx.bookingRental.findUniqueOrThrow({ where: { id: id.data } });
      });

      res.json(row);
    } catch (e) {
      if (e instanceof EditError) return res.status(e.status).json({ error: e.code });
      throw e;
    }
  });
}

/**
 * POST /api/admin/rentals/:id/undo — крок назад: RETURNED → ISSUED → RESERVED.
 * Натиснули «Видано» не на тому рядку — це не має лишатись у картці назавжди.
 *
 * Скасована видача витратної повертає її на склад: пляшку не відкривали.
 */
rentalsRouter.post('/rentals/:id/undo', requireAuth, requireStaff, async (req, res) => {
  const id = uuid.safeParse(param(req, 'id'));
  if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const clubId = req.auth!.clubId;

  try {
    const row = await prisma.$transaction(async (tx) => {
      const current = await tx.bookingRental.findFirst({
        where: { id: id.data, clubId },
        select: { id: true, itemId: true, quantity: true, returnable: true, status: true },
      });
      if (!current) throw new EditError(404, 'NOT_FOUND');
      if (current.status === 'RESERVED') throw new EditError(409, 'BAD_TRANSITION');
      await lockRentableItems(tx, clubId, [current.itemId]);

      const back = current.status === 'RETURNED'
        ? { status: 'ISSUED' as const, returnedAt: null, returnedBy: null }
        : { status: 'RESERVED' as const, issuedAt: null, issuedBy: null };

      const updated = await tx.bookingRental.updateMany({
        where: { id: id.data, clubId, status: current.status },
        data: back,
      });
      if (updated.count === 0) throw new EditError(409, 'BAD_TRANSITION');

      if (back.status === 'RESERVED' && !current.returnable) {
        await shiftStock(tx, current.itemId, current.quantity);
      }

      return tx.bookingRental.findUniqueOrThrow({ where: { id: id.data } });
    });

    res.json(row);
  } catch (e) {
    if (e instanceof EditError) return res.status(e.status).json({ error: e.code });
    throw e;
  }
});

/**
 * GET /api/admin/bookings/:id/checklist — чек-лист броні.
 *
 * `open` — чи лишилось щось на руках. Саме він вирішує, показувати вікно
 * «Прийняти інвентар» після кінця броні.
 */
rentalsRouter.get('/bookings/:id/checklist', requireAuth, requireStaff, async (req, res) => {
  const id = uuid.safeParse(param(req, 'id'));
  if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const booking = await prisma.booking.findFirst({
    where: { id: id.data, clubId: req.auth!.clubId },
    select: {
      id: true, status: true, startTime: true, endTime: true, rentalTotal: true,
      rentals: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!booking) return res.status(404).json({ error: 'NOT_FOUND' });

  const held = onHand(booking.rentals);
  res.json({
    bookingId: booking.id,
    startTime: booking.startTime,
    endTime: booking.endTime,
    rentalTotal: booking.rentalTotal,
    items: booking.rentals,
    open: held.length > 0,
    onHand: held.map((l) => ({ id: l.id, itemId: l.itemId, itemName: l.itemName, quantity: l.quantity })),
    depositTotal: booking.rentals.reduce((sum, l) => sum + (l.depositAmount ?? 0), 0),
  });
});

/**
 * POST /api/admin/bookings/:id/inventory/accept — «Прийняти інвентар».
 *
 * Закриває чек-лист: усе видане поворотне переходить у RETURNED і
 * звільняється для інших броней. Витратне не чіпаємо — його списали ще при
 * видачі, і «повертати» воду нема куди.
 *
 * Рядки, які так і лишились у RESERVED, теж не чіпаємо: їх просто не взяли.
 * Вони нікого не тримають — їхній інтервал скінчився разом із бронню.
 *
 * Статус самої броні не міняється. Бронь «завершена» — це її минулий час, а
 * не окремий стан: заводити його заради однієї кнопки означало б додати
 * BookingStatus, який довелось би врахувати в кожному запиті системи.
 */
rentalsRouter.post('/bookings/:id/inventory/accept', requireAuth, requireStaff, async (req, res) => {
  const id = uuid.safeParse(param(req, 'id'));
  if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const clubId = req.auth!.clubId;
  const email = await actorEmail(req.auth!.userId);
  const now = new Date();

  const booking = await prisma.booking.findFirst({
    where: { id: id.data, clubId },
    select: { id: true, rentals: { select: { id: true, quantity: true, status: true, returnable: true } } },
  });
  if (!booking) return res.status(404).json({ error: 'NOT_FOUND' });

  const ids = onHand(booking.rentals).map((l) => l.id);

  /* Умова статусу лишається в WHERE: поки ми читали, черговий міг прийняти
     ту саму ракетку окремою кнопкою. Тоді рядок просто не потрапить під
     update, і `accepted` чесно покаже, скільки прийняли ми. */
  const accepted = ids.length
    ? (await prisma.bookingRental.updateMany({
        where: { id: { in: ids }, clubId, status: 'ISSUED' },
        data: { status: 'RETURNED', returnedAt: now, returnedBy: email },
      })).count
    : 0;

  const items = await prisma.bookingRental.findMany({
    where: { bookingId: booking.id },
    orderBy: { createdAt: 'asc' },
  });

  res.json({ accepted, open: onHand(items).length > 0, items });
});

/**
 * PATCH /api/admin/rentals/:id/deposit — застава або штраф на рядку.
 *
 * Заготовка: суму й причину пише адміністратор руками. Ні автоматичного
 * розрахунку, ні утримання з оплати, ні сповіщень тут немає — і це
 * свідоме рішення, а не недороблене. Обидва поля або жодного (CHECK у базі).
 */
rentalsRouter.patch('/rentals/:id/deposit', requireAuth, requireStaff, async (req, res) => {
  const id = uuid.safeParse(param(req, 'id'));
  const body = z.object({
    amount: z.number().int().min(0).max(100_000_000).nullable(),
    reason: z.string().trim().min(1).max(300).nullable(),
  })
    .refine((d) => (d.amount === null) === (d.reason === null), { message: 'DEPOSIT_PAIRED' })
    .safeParse(req.body);
  if (!id.success || !body.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const updated = await prisma.bookingRental.updateMany({
    where: { id: id.data, clubId: req.auth!.clubId },
    data: { depositAmount: body.data.amount, depositReason: body.data.reason },
  });
  if (updated.count === 0) return res.status(404).json({ error: 'NOT_FOUND' });

  res.json(await prisma.bookingRental.findUniqueOrThrow({ where: { id: id.data } }));
});

/**
 * GET /api/admin/bookings/:id/extend-check?end= — що заважає продовжити.
 *
 * Читає й нічого не змінює: кабінет зве це перед тим, як показати кнопку
 * «Продовжити», і малює попередження поруч із нею.
 *
 * Рішення свідомо обмежене: система ПОПЕРЕДЖАЄ про конфлікт інвентарю, але
 * не блокує продовження. Продовження — це гроші в касі зараз, а ракетка
 * знаходиться: у наступного клієнта може бути свій комплект, або клуб
 * домовиться голосом. Автоматики розвʼязання конфлікту немає навмисно.
 *
 * `courtBusy` — інша річ: корт зайняти двічі не можна, і це вже не
 * попередження, а межа. Саму заборону тримає EXCLUDE-констрейнт у базі,
 * тут лише чесна відповідь наперед.
 */
rentalsRouter.get('/bookings/:id/extend-check', requireAuth, requireStaff, async (req, res) => {
  const id = uuid.safeParse(param(req, 'id'));
  const query = z.object({ end: z.string().datetime({ offset: true }) }).safeParse(req.query);
  if (!id.success || !query.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const clubId = req.auth!.clubId;
  const newEnd = new Date(query.data.end);

  const booking = await prisma.booking.findFirst({
    where: { id: id.data, clubId },
    select: {
      id: true, courtId: true, endTime: true, status: true, capacity: true,
      rentals: { select: { id: true, itemId: true, itemName: true, quantity: true, status: true, returnable: true } },
    },
  });
  if (!booking) return res.status(404).json({ error: 'NOT_FOUND' });
  if (booking.capacity !== null) return res.status(400).json({ error: 'RENTALS_PRIVATE_ONLY' });
  if (!ACTIVE.has(booking.status)) return res.status(409).json({ error: 'BOOKING_INACTIVE' });
  if (newEnd <= booking.endTime) return res.status(400).json({ error: 'BAD_INTERVAL' });

  const held = onHand(booking.rentals);

  /* Чужі рядки, що потрапляють у продовжений хвіст. Беремо й RESERVED теж —
     саме заплановане в наступній броні й створює конфлікт: ракетка ще на
     руках, а її вже комусь пообіцяли. */
  const upcoming = held.length
    ? await prisma.bookingRental.findMany({
        where: {
          clubId,
          itemId: { in: held.map((l) => l.itemId) },
          status: { in: ['RESERVED', 'ISSUED'] },
          booking: {
            id: { not: booking.id },
            status: { in: [...ACTIVE_LIST] },
            startTime: { lt: newEnd },
            endTime: { gt: booking.endTime },
          },
        },
        select: { itemId: true, quantity: true, bookingId: true, booking: { select: { startTime: true } } },
      })
    : [];

  const courtBusy = await prisma.booking.findFirst({
    where: {
      id: { not: booking.id },
      courtId: booking.courtId,
      status: { in: [...ACTIVE_LIST] },
      startTime: { lt: newEnd },
      endTime: { gt: booking.endTime },
    },
    select: { id: true, startTime: true, endTime: true },
  });

  res.json({
    bookingId: booking.id,
    from: booking.endTime,
    to: newEnd,
    courtBusy: courtBusy ?? null,
    onHand: held.map((l) => ({ itemId: l.itemId, itemName: l.itemName, quantity: l.quantity })),
    conflicts: extendConflicts(
      held.map((l) => ({ itemId: l.itemId, itemName: l.itemName, quantity: l.quantity })),
      upcoming.map((u) => ({
        itemId: u.itemId, quantity: u.quantity, bookingId: u.bookingId, startTime: u.booking.startTime,
      })),
    ),
  });
});
