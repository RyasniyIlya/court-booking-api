import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { DateTime } from 'luxon';
import { prisma, isSlotTakenError, notifyClub } from '../lib/db';
import { buildSlots, isAlignedToGrid, type Interval } from '../lib/slots';
import { normalizePhone } from '../lib/phone';
import bcrypt from 'bcryptjs';
import { findOrCreateCustomer } from '../lib/customers';
import { providerFor, publicBase } from '../lib/payments';
import { clubBilling } from '../lib/billing';
import {
  signCustomerToken, verifyCustomerToken, verifyCustomerPin, hashPinLookup, isPinTakenError,
} from '../lib/customerAuth';

export const publicRouter = Router();

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

/**
 * `isActive` тут навмисно НЕ фільтрується.
 *
 * Раніше вимкнений клуб просто не знаходився, і віджет на його сайті
 * показував «Розклад тимчасово недоступний» — тобто помилку. Гравець не
 * винен, що клуб забув заплатити, і не має бачити зламану сторінку.
 *
 * Тепер клуб завжди знаходиться, а стан вирішує clubBilling(): віджет
 * перетворюється на блок з телефоном, а не на повідомлення про збій.
 */
async function loadClub(slug: string) {
  return prisma.club.findFirst({
    where: { slug },
    include: {
      hours: true,
      courts: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
      trainers: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
    },
  });
}

/**
 * Статуси, що займають час. EXPIRED сюди не входить: неоплачена бронь
 * звільняє слот — так само, як її не рахує EXCLUDE-констрейнт у базі.
 */
const BUSY_STATUSES = ['PENDING', 'CONFIRMED'] as const;

/** GET /api/public/clubs/:slug — дані для віджета */
publicRouter.get('/clubs/:slug', async (req, res) => {
  const club = await loadClub(req.params.slug);
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });

  const billing = clubBilling(club);

  /* Онлайн-запис вимкнено. Віддаємо рівно те, з чого віджет збере блок
     з телефоном: назву, контакти, бренд. Ні годин, ні кортів, ні цін —
     нема сенсу малювати сітку, у яку не можна натиснути.
     Статус 200, а не 4xx: для гравця це не помилка, а режим роботи. */
  if (!billing.online) {
    return res.json({
      name: club.name,
      slug: club.slug,
      timezone: club.timezone,
      phone: club.phone,
      address: club.address,
      logoUrl: club.logoUrl,
      brandColor: club.brandColor,
      online: false,
    });
  }

  res.json({
    online: true,
    name: club.name,
    slug: club.slug,
    timezone: club.timezone,
    slotMinutes: club.slotMinutes,
    horizonDays: club.horizonDays,
    // Шапка віджета. Порожні поля просто не малюються — у клубів без
    // логотипа чи адреси віджет лишається таким, як був.
    phone: club.phone,
    address: club.address,
    logoUrl: club.logoUrl,
    brandColor: club.brandColor,
    // Розклад тижня — щоб віджет показав «Відчинено до 22:00» без окремого
    // запиту. Хвилини від опівночі за таймзоною клубу, як у базі.
    hours: [...club.hours]
      .sort((a, b) => a.weekday - b.weekday)
      .map((h) => ({
        weekday: h.weekday,
        openMinute: h.openMinute,
        closeMinute: h.closeMinute,
        isClosed: h.isClosed,
      })),
    courts: club.courts.map((c) => ({
      id: c.id,
      name: c.name,
      pricePerHour: c.pricePerHour,
      slotMinutes: c.slotMinutes ?? club.slotMinutes,
    })),
    // Чи є сенс показувати вибір тренера. Сам список тягнемо окремо —
    // він залежить від обраної години.
    hasTrainers: club.trainers.length > 0,
    // Разом визначають, чи взагалі бачить гравець оплату і чи це вибір,
    // а чи обов'язок: prepayEnabled=false — оплати немає зовсім;
    // true+true (типово) — оплата обов'язкова, як і раніше;
    // true+false — гравець сам обирає «зараз» чи «на місці».
    prepayEnabled: club.prepayEnabled,
    prepayRequired: club.prepayRequired,
  });
});

/**
 * GET /api/public/clubs/:slug/trainers?start=&end=
 *
 * Тренери, вільні на цей проміжок. Без start/end — просто весь список.
 *
 * Розкладу тренерів ми не ведемо: клуб сам знає, хто коли працює.
 * Тут відсіюються тільки ті, у кого на цю годину вже є заняття, —
 * щоб гравець не обрав зайнятого.
 */
publicRouter.get('/clubs/:slug/trainers', async (req, res) => {
  const parsed = z.object({
    start: z.string().datetime({ offset: true }).optional(),
    end: z.string().datetime({ offset: true }).optional(),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const club = await loadClub(req.params.slug);
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });

  const { start, end } = parsed.data;
  let busy = new Set<string>();

  if (start && end) {
    const taken = await prisma.booking.findMany({
      where: {
        clubId: club.id,
        trainerId: { not: null },
        status: { in: [...BUSY_STATUSES] },
        startTime: { lt: new Date(end) },
        endTime: { gt: new Date(start) },
      },
      select: { trainerId: true },
    });
    busy = new Set(taken.map((t) => t.trainerId!));
  }

  res.json(club.trainers.map((t) => ({
    id: t.id,
    name: t.name,
    pricePerHour: t.pricePerHour,
    note: t.note,
    available: !busy.has(t.id),
  })));
});

/**
 * GET /api/public/clubs/:slug/availability?date=2026-08-15[&courtId=...]
 * Порожні слоти не зберігаються в БД — сітка рахується на льоту.
 */
publicRouter.get('/clubs/:slug/availability', async (req, res) => {
  const parsed = z.object({ date: dateSchema, courtId: z.string().uuid().optional() })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST', details: parsed.error.flatten() });
  const { date, courtId } = parsed.data;

  const club = await loadClub(req.params.slug);
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });

  // Онлайн-запис вимкнено — сітки просто немає. Порожній список кортів, а не
  // помилка: віджет у цьому стані малює блок з телефоном і сюди не ходить,
  // але прямий запит теж має отримати щось осмислене.
  if (!clubBilling(club).online) {
    return res.json({ closed: true, offline: true, courts: [] });
  }

  const day = DateTime.fromISO(date, { zone: club.timezone });
  if (!day.isValid) return res.status(400).json({ error: 'BAD_DATE' });

  const today = DateTime.now().setZone(club.timezone).startOf('day');
  if (day < today || day > today.plus({ days: club.horizonDays })) {
    return res.status(400).json({ error: 'DATE_OUT_OF_RANGE' });
  }

  // weekday: Luxon 1=Пн..7=Нд -> наша схема 0=Нд..6=Сб
  const weekday = day.weekday % 7;
  const hours = club.hours.find((h) => h.weekday === weekday);
  if (!hours || hours.isClosed) return res.json({ date, closed: true, courts: [] });

  // Межі доби з запасом ±1 доба — щоб зловити броні, що переходять через північ
  const from = day.startOf('day').minus({ days: 1 }).toJSDate();
  const to = day.startOf('day').plus({ days: 2 }).toJSDate();

  const courts = courtId ? club.courts.filter((c) => c.id === courtId) : club.courts;
  if (courtId && courts.length === 0) return res.status(404).json({ error: 'COURT_NOT_FOUND' });

  const [bookings, blocks] = await Promise.all([
    prisma.booking.findMany({
      where: {
        clubId: club.id,
        status: { in: [...BUSY_STATUSES] },
        startTime: { lt: to },
        endTime: { gt: from },
      },
      select: {
        id: true,
        courtId: true,
        startTime: true,
        endTime: true,
        // Групове заняття гравцю не «зайнято», а «є місця» — тому про нього
        // треба розповісти, а не просто вирізати годину з сітки.
        capacity: true,
        title: true,
        pricePerSeat: true,
        trainer: { select: { name: true } },
        seats: { where: { status: 'BOOKED' }, select: { id: true } },
      },
    }),
    prisma.block.findMany({
      where: { clubId: club.id, startTime: { lt: to }, endTime: { gt: from } },
      select: { courtId: true, startTime: true, endTime: true },
    }),
  ]);

  const now = new Date();
  const result = courts.map((court) => {
    const busy: Interval[] = [
      ...bookings.filter((b) => b.courtId === court.id),
      // courtId === null -> блокування всього клубу
      ...blocks.filter((b) => b.courtId === null || b.courtId === court.id),
    ];

    const slots = buildSlots({
      date,
      timezone: club.timezone,
      openMinute: hours.openMinute,
      closeMinute: hours.closeMinute,
      slotMinutes: court.slotMinutes ?? club.slotMinutes,
      leadTimeMinutes: club.leadTimeMinutes,
      busy,
      now,
    });

    /* Групові заняття цього корту. Слот, на який лягла група, лишається
       available: false — записатись у неї це інша дія, ніж забронювати
       корт, і кнопка в гравця має бути інша. Але тепер із ним їде опис
       заняття, тож віджет малює «Ранкова йога · 3/8», а не «зайнято».

       `startsHere` — бо заняття може бути довшим за слот (півтори години
       на годинній сітці). Картку заняття показуємо один раз, на його
       початку; продовження лишаються звичайним зайнятим часом. */
    const groups = bookings.filter(
      (b) => b.courtId === court.id && b.capacity != null,
    );

    return {
      courtId: court.id,
      courtName: court.name,
      pricePerHour: court.pricePerHour,
      slots: slots.map((s) => {
        const sMs = Date.parse(s.start);
        const eMs = Date.parse(s.end);
        const g = groups.find(
          (b) => sMs < b.endTime.getTime() && eMs > b.startTime.getTime(),
        );
        if (!g) return s;

        const taken = g.seats.length;
        return {
          ...s,
          group: {
            bookingId: g.id,
            title: g.title,
            capacity: g.capacity,
            taken,
            free: Math.max(0, (g.capacity ?? 0) - taken),
            pricePerSeat: g.pricePerSeat ?? 0,
            trainerName: g.trainer?.name ?? null,
            start: g.startTime.toISOString(),
            end: g.endTime.toISOString(),
            /* Підписи рахуємо тут, у таймзоні клубу — так само, як у
               слотів. Інакше гравець із Варшави побачив би на київському
               занятті час свого телефона й прийшов би на годину раніше. */
            startLabel: DateTime.fromJSDate(g.startTime)
              .setZone(club.timezone).toFormat('HH:mm'),
            endLabel: DateTime.fromJSDate(g.endTime)
              .setZone(club.timezone).toFormat('HH:mm'),
            startsHere: g.startTime.getTime() === sMs,
          },
        };
      }),
    };
  });

  res.json({ date, closed: false, timezone: club.timezone, courts: result });
});

const bookingSchema = z.object({
  courtId: z.string().uuid(),
  /** ISO 8601 з таймзоною, напр. 2026-08-15T16:00:00Z */
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  customerName: z.string().trim().min(2).max(80),
  customerPhone: z.string().trim().regex(/^\+?[0-9\s()-]{9,20}$/, 'invalid phone'),
  comment: z.string().trim().max(300).optional(),
  /** Тренер на заняття. null або відсутнє — грають самі. */
  trainerId: z.string().uuid().nullable().optional(),
  /** Куди повернути гравця після платіжки. Віджет підставляє свою сторінку. */
  returnUrl: z.string().url().max(500).optional(),
  /**
   * Має сенс тільки коли клуб віддав prepayEnabled && !prepayRequired —
   * тоді гравець сам обирає. В решті випадків ігнорується: платить,
   * якщо клуб того вимагає, і не платить, якщо оплати в клубі немає.
   */
  payChoice: z.enum(['online', 'onsite']).optional(),
  /**
   * Необов'язково: гравець заодно заводить собі кабінет — наступного разу
   * не вводити ім'я й телефон, а увійти по цьому PIN. Без окремого екрана
   * реєстрації, без SMS — просто галочка "запам'ятати мене" у формі броні.
   */
  setPin: z.string().regex(/^\d{4,8}$/).optional(),
});

/**
 * Адреса повернення з платіжки. Банк відправить гравця туди, куди ми скажемо,
 * тому чужий домен сюди пускати не можна — це відкритий редірект.
 * Приймаємо тільки той самий origin, з якого прийшов запит (це сайт клубу,
 * де стоїть віджет). Без Origin — падаємо на налаштований запасний варіант.
 */
function safeReturnUrl(raw: string | undefined, origin: string | undefined): string {
  const fallback = process.env.PUBLIC_WIDGET_RETURN_URL ?? `${publicBase()}/api/pay/done`;
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return fallback;
    if (origin && u.origin !== origin) return fallback;
    return u.toString();
  } catch {
    return fallback;
  }
}

/** POST /api/public/clubs/:slug/bookings */
publicRouter.post('/clubs/:slug/bookings', async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST', details: parsed.error.flatten() });
  const body = parsed.data;

  const club = await loadClub(req.params.slug);
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });

  /* Остання лінія. Віджет у стані offline форми не показує, але POST може
     прилетіти зі старої вкладки, відкритої до вимкнення, — і тоді бронь
     створилась би в обхід. 403, а не 404: клуб існує, просто зараз не
     приймає онлайн-записи. */
  if (!clubBilling(club).online) {
    return res.status(403).json({ error: 'CLUB_OFFLINE' });
  }

  const court = club.courts.find((c) => c.id === body.courtId);
  if (!court) return res.status(404).json({ error: 'COURT_NOT_FOUND' });

  const start = new Date(body.start);
  const end = new Date(body.end);
  if (end <= start) return res.status(400).json({ error: 'BAD_INTERVAL' });

  if (start.getTime() < Date.now() + club.leadTimeMinutes * 60_000) {
    return res.status(400).json({ error: 'TOO_LATE' });
  }

  const local = DateTime.fromJSDate(start).setZone(club.timezone);
  const weekday = local.weekday % 7;
  const hours = club.hours.find((h) => h.weekday === weekday);
  if (!hours || hours.isClosed) return res.status(400).json({ error: 'CLUB_CLOSED' });

  const slotMinutes = court.slotMinutes ?? club.slotMinutes;
  if (!isAlignedToGrid({
    start, end, timezone: club.timezone,
    openMinute: hours.openMinute, closeMinute: hours.closeMinute, slotMinutes,
  })) {
    return res.status(400).json({ error: 'OUT_OF_GRID' });
  }

  // Блокування адміністратора перевіряємо явно (їх не покриває констрейнт на Booking)
  const block = await prisma.block.findFirst({
    where: {
      clubId: club.id,
      OR: [{ courtId: null }, { courtId: court.id }],
      startTime: { lt: end },
      endTime: { gt: start },
    },
  });
  if (block) return res.status(409).json({ error: 'SLOT_TAKEN' });

  const phone = normalizePhone(body.customerPhone);
  if (!phone) return res.status(400).json({ error: 'BAD_PHONE' });

  const customer = await findOrCreateCustomer({
    clubId: club.id,
    name: body.customerName,
    rawPhone: body.customerPhone,
  });
  if (customer?.isBlocked) return res.status(403).json({ error: 'CUSTOMER_BLOCKED' });

  let customerToken: string | undefined;
  let pinTaken = false;
  if (customer && body.setPin) {
    const pinHash = await bcrypt.hash(body.setPin, 12);
    const pinLookupHash = hashPinLookup(club.id, body.setPin);
    try {
      await prisma.customer.update({
        where: { id: customer.id },
        data: { pinHash, pinLookupHash, pinFails: 0, pinLockedUntil: null },
      });
      customerToken = signCustomerToken({ customerId: customer.id, clubId: club.id });
    } catch (e) {
      // Цей PIN уже чийсь у клубі — бронь усе одно має пройти, просто без
      // кабінету. Гравець спробує інший PIN наступного разу.
      if (!isPinTakenError(e)) throw e;
      pinTaken = true;
    }
  }

  const minutes = (end.getTime() - start.getTime()) / 60_000;
  const courtPrice = Math.round((court.pricePerHour * minutes) / 60);

  // Тренер: перевіряємо, що він цього клубу, активний і не зайнятий.
  // Констрейнта в базі на тренера немає — тому теоретично двоє можуть
  // проскочити в одну мілісекунду. Живемо з цим свідомо; повний EXCLUDE
  // по trainerId додається однією міграцією, якщо стане проблемою.
  let trainer = null;
  let trainerPrice = 0;

  if (body.trainerId) {
    trainer = club.trainers.find((t) => t.id === body.trainerId && t.isActive) ?? null;
    if (!trainer) return res.status(404).json({ error: 'TRAINER_NOT_FOUND' });

    const clash = await prisma.booking.findFirst({
      where: {
        trainerId: trainer.id,
        status: { in: [...BUSY_STATUSES] },
        startTime: { lt: end },
        endTime: { gt: start },
      },
      select: { id: true },
    });
    if (clash) return res.status(409).json({ error: 'TRAINER_BUSY' });

    trainerPrice = Math.round((trainer.pricePerHour * minutes) / 60);
  }

  const priceTotal = courtPrice + trainerPrice;

  // Три стани клуба: оплати немає (prepayEnabled=false), оплата обов'язкова
  // (prepayRequired=true, типово) — і новий: гравець сам обирає при броні.
  // У третьому стані вибір обов'язковий — без нього незрозуміло, чи повертати
  // слот, тому просимо перепитати, а не тихо вгадувати «на місці».
  if (club.prepayEnabled && !club.prepayRequired && !body.payChoice) {
    return res.status(400).json({ error: 'PAY_CHOICE_REQUIRED' });
  }

  const wantsOnlinePay = club.prepayRequired || body.payChoice === 'online';
  const provider = club.prepayEnabled && wantsOnlinePay ? providerFor(club) : null;
  const needsPay = Boolean(provider) && priceTotal > 0;
  const expiresAt = needsPay
    ? new Date(Date.now() + club.payHoldMinutes * 60_000)
    : null;

  let booking;
  try {
    // Гонку двох одночасних запитів ловить EXCLUDE USING gist у БД,
    // а не перевірка в коді — тому окрема транзакція з SELECT ... не потрібна.
    // PENDING теж рахується зайнятим, тому слот тримається під час оплати.
    booking = await prisma.booking.create({
      data: {
        clubId: club.id,
        courtId: court.id,
        customerName: body.customerName,
        customerPhone: phone.e164,
        customerId: customer?.id ?? null,
        comment: body.comment,
        startTime: start,
        endTime: end,
        priceTotal,
        trainerId: trainer?.id ?? null,
        trainerPrice,
        status: needsPay ? 'PENDING' : (club.autoConfirm ? 'CONFIRMED' : 'PENDING'),
        expiresAt,
        source: 'WIDGET',
      },
    });
  } catch (e) {
    if (isSlotTakenError(e)) return res.status(409).json({ error: 'SLOT_TAKEN' });
    console.error('[booking] create failed', e);
    return res.status(500).json({ error: 'INTERNAL' });
  }

  const when = `${local.toFormat('dd.MM HH:mm')}–` +
    `${DateTime.fromJSDate(end).setZone(club.timezone).toFormat('HH:mm')}`;

  if (needsPay) {
    const back = new URL(safeReturnUrl(body.returnUrl, req.headers.origin));
    back.searchParams.set('cbPay', booking.cancelToken);

    try {
      const invoice = await provider!.createInvoice({
        amountKop: priceTotal,
        reference: booking.id,
        destination: `${club.name}: ${court.name}, ${when}`,
        redirectUrl: back.toString(),
        webHookUrl: `${publicBase()}/api/pay/webhook/${club.id}`,
        ttlSeconds: club.payHoldMinutes * 60,
      });

      await prisma.payment.create({
        data: {
          clubId: club.id,
          bookingId: booking.id,
          provider: provider!.name,
          providerRef: invoice.providerRef,
          pageUrl: invoice.pageUrl,
          amount: priceTotal,
        },
      });

      return res.status(201).json({
        id: booking.id,
        status: 'PENDING',
        cancelToken: booking.cancelToken,
        priceTotal,
        payUrl: invoice.pageUrl,
        expiresAt: expiresAt!.toISOString(),
        customerToken,
        pinTaken,
      });
    } catch (e) {
      // Рахунок не виставився — тримати слот немає підстав, віддаємо назад одразу.
      console.error('[booking] invoice failed', e);
      await prisma.booking.update({
        where: { id: booking.id },
        data: { status: 'EXPIRED', expiresAt: null },
      }).catch(() => {});
      return res.status(502).json({ error: 'PAYMENT_UNAVAILABLE' });
    }
  }

  // Без передоплати повідомляємо клуб одразу. З передоплатою — після оплати
  // (див. lib/payments/apply.ts), інакше адміну падатимуть покинуті кошики.
  void notifyClub(
    club.telegramChatId,
    `<b>Нова бронь</b>\n${court.name}\n${when}\n` +
    (trainer ? `Тренер: ${trainer.name}\n` : '') +
    `${body.customerName}, ${body.customerPhone}\n` +
    `${(priceTotal / 100).toFixed(2)} грн`,
  );

  res.status(201).json({
    id: booking.id,
    status: booking.status,
    cancelToken: booking.cancelToken,
    priceTotal,
    customerToken,
    pinTaken,
  });
});

const joinSchema = z.object({
  customerName: z.string().trim().min(2).max(80),
  customerPhone: z.string().trim().regex(/^\+?[0-9\s()-]{9,20}$/, 'invalid phone'),
  comment: z.string().trim().max(300).optional(),
});

/**
 * Вихід із транзакції з осмисленим кодом.
 *
 * Усередині prisma.$transaction звичайний `return res.status(...)` не
 * годиться: обробник має відкотити транзакцію, а не тихо її закомітити,
 * віддавши помилку. Кидаємо — Prisma відкочує, обробник унизу перекладає
 * назад у HTTP.
 */
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

/**
 * Чи гравець ще може зняти запис сам.
 *
 * Одне правило на дві сутності — бронь корту й місце в груповому занятті:
 * для гравця це та сама дія «я не прийду», і різні строки в них він читав
 * би як помилку. cutoff = 0 означає «до самого початку».
 *
 * Адміністратора це не стосується: клуб домовляється голосом і має могти
 * зняти запис навіть за хвилину до початку.
 */
function canCancelNow(startTime: Date, cutoffMinutes: number): boolean {
  return Date.now() < startTime.getTime() - cutoffMinutes * 60_000;
}

/**
 * POST /api/public/clubs/:slug/bookings/:id/join — записатись у групове заняття.
 *
 * ── Чому транзакція з FOR UPDATE ─────────────────────────────────────────
 *
 * Це єдине місце в проєкті, де від гонки захищає код, а не констрейнт.
 * «Дітей не більше за capacity» декларативно в Postgres не виражається:
 * EXCLUDE працює по перетинах, CHECK не бачить інших рядків. Тому рядок
 * заняття блокується на час перевірки — двоє, що тиснуть «Записатись» на
 * останнє місце в одну мілісекунду, стають у чергу, і другий отримає
 * GROUP_FULL замість дев'ятого місця у восьмимісній групі.
 *
 * Оплати тут немає навмисно: у першій версії групові заняття оплачуються
 * на місці. Оплата за місце вимагає розв'язати Payment.bookingId @unique,
 * і це окрема робота, а не рядок у цьому обробнику.
 */
publicRouter.post('/clubs/:slug/bookings/:id/join', async (req, res) => {
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const body = parsed.data;

  const bookingId = z.string().uuid().safeParse(req.params.id);
  if (!bookingId.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const club = await loadClub(req.params.slug);
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });
  if (!clubBilling(club).online) return res.status(403).json({ error: 'CLUB_OFFLINE' });

  const phone = normalizePhone(body.customerPhone);
  if (!phone) return res.status(400).json({ error: 'BAD_PHONE' });

  const customer = await findOrCreateCustomer({
    clubId: club.id,
    name: body.customerName,
    rawPhone: body.customerPhone,
  });
  if (customer?.isBlocked) return res.status(403).json({ error: 'CUSTOMER_BLOCKED' });

  try {
    const seat = await prisma.$transaction(async (tx) => {
      /* Блокуємо саме рядок заняття. Всі, хто записується в ЦЮ групу,
         стають у чергу тут; записи в інші групи не чекають. */
      const rows = await tx.$queryRaw<
        { id: string; clubId: string; capacity: number | null; pricePerSeat: number | null; status: string; startTime: Date }[]
      >`SELECT "id", "clubId", "capacity", "pricePerSeat", "status"::text, "startTime"
          FROM "Booking" WHERE "id" = ${bookingId.data}::uuid FOR UPDATE`;

      const b = rows[0];
      if (!b) throw new HttpError(404, 'NOT_FOUND');
      if (b.clubId !== club.id) throw new HttpError(404, 'NOT_FOUND');
      if (b.capacity == null) throw new HttpError(400, 'NOT_A_GROUP');
      if (!BUSY_STATUSES.includes(b.status as never)) throw new HttpError(409, 'GROUP_CANCELLED');

      if (b.startTime.getTime() < Date.now() + club.leadTimeMinutes * 60_000) {
        throw new HttpError(400, 'TOO_LATE');
      }

      const taken = await tx.bookingSeat.count({
        where: { bookingId: b.id, status: 'BOOKED' },
      });
      if (taken >= b.capacity) throw new HttpError(409, 'GROUP_FULL');

      const already = await tx.bookingSeat.findFirst({
        where: { bookingId: b.id, customerPhone: phone.e164, status: 'BOOKED' },
        select: { id: true },
      });
      if (already) throw new HttpError(409, 'ALREADY_JOINED');

      const price = b.pricePerSeat ?? 0;

      const created = await tx.bookingSeat.create({
        data: {
          bookingId: b.id,
          customerId: customer?.id ?? null,
          customerName: body.customerName.trim(),
          customerPhone: phone.e164,
          comment: body.comment,
          price,
          source: 'WIDGET',
        },
      });

      /* Виручка заняття росте разом із проданими місцями — так підсумок
         дня рахується сам, без окремої гілки в аналітиці. */
      await tx.booking.update({
        where: { id: b.id },
        data: { priceTotal: { increment: price } },
      });

      return created;
    });

    res.status(201).json({
      id: seat.id,
      cancelToken: seat.cancelToken,
      price: seat.price,
    });
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.code });
    console.error('[join] failed', e);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

/**
 * GET /api/public/bookings/:token/status
 *
 * Віджет питає сюди після повернення з платіжки. Повернення гравця на сайт
 * не гарантоване і не є джерелом правди — правда приходить вебхуком, тому
 * віджет коротко опитує цей роут, поки статус не стане остаточним.
 */
publicRouter.get('/bookings/:token/status', async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.token);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const booking = await prisma.booking.findUnique({
    where: { cancelToken: parsed.data },
    include: { court: { select: { name: true } }, payment: { select: { status: true } } },
  });
  if (!booking) return res.status(404).json({ error: 'NOT_FOUND' });

  res.json({
    id: booking.id,
    status: booking.status,
    paymentStatus: booking.payment?.status ?? null,
    courtName: booking.court.name,
    start: booking.startTime.toISOString(),
    end: booking.endTime.toISOString(),
    priceTotal: booking.priceTotal,
    expiresAt: booking.expiresAt?.toISOString() ?? null,
  });
});

/** POST /api/public/bookings/:id/cancel  { token } — скасування клієнтом за посиланням */
publicRouter.post('/bookings/:id/cancel', async (req, res) => {
  const parsed = z.object({ token: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { club: { select: { cancelCutoffMinutes: true } } },
  });
  if (!booking || booking.cancelToken !== parsed.data.token) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }
  if (booking.status === 'CANCELLED') return res.json({ ok: true });

  const cutoff = booking.club.cancelCutoffMinutes;
  if (!canCancelNow(booking.startTime, cutoff)) {
    return res.status(400).json({ error: cutoff > 0 ? 'CANCEL_CLOSED' : 'ALREADY_STARTED' });
  }

  await prisma.booking.update({
    where: { id: booking.id },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });
  res.json({ ok: true });
});

/* -------------------------------------------------------------------------- */
/* КАБІНЕТ ГРАВЦЯ                                                             */
/* -------------------------------------------------------------------------- */

const customerLoginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS' },
});

/**
 * POST /api/public/clubs/:slug/customer/login
 *
 * Телефон + PIN, заведений раніше через setPin при броні. Немає картки або
 * немає PIN — PIN_NOT_SET: віджет тоді просто показує звичайну форму.
 */
publicRouter.post('/clubs/:slug/customer/login', customerLoginLimiter, async (req, res) => {
  const parsed = z
    .object({ phone: z.string().trim(), pin: z.string().regex(/^\d{4,8}$/) })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const club = await loadClub(slug);
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: 'BAD_PHONE' });

  const customer = await prisma.customer.findUnique({
    where: { clubId_phone: { clubId: club.id, phone: phone.e164 } },
  });
  if (!customer) return res.status(404).json({ error: 'PIN_NOT_SET' });

  const result = await verifyCustomerPin(customer.id, parsed.data.pin);
  if (!result.ok) {
    const status = result.reason === 'LOCKED' ? 423 : result.reason === 'NOT_SET' ? 404 : 403;
    const error =
      result.reason === 'LOCKED' ? 'PIN_LOCKED'
        : result.reason === 'NOT_SET' ? 'PIN_NOT_SET'
          : 'INVALID_PIN';
    return res.status(status).json({ error });
  }

  res.json({
    token: signCustomerToken({ customerId: customer.id, clubId: club.id }),
    name: customer.name,
    phone: customer.phone,
  });
});

function requireCustomerAuth(req: import('express').Request, res: import('express').Response) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return null;
  }
  const auth = verifyCustomerToken(header.slice(7));
  if (!auth) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return null;
  }
  return auth;
}

/**
 * GET /api/public/customer/me
 *
 * Профіль + майбутні броні гравця в цьому клубі — щоб побачив, що вже
 * записаний, а не тільки щоб не передруковувати ім'я вкотре.
 */
publicRouter.get('/customer/me', async (req, res) => {
  const auth = requireCustomerAuth(req, res);
  if (!auth) return;

  const customer = await prisma.customer.findUnique({ where: { id: auth.customerId } });
  if (!customer || customer.clubId !== auth.clubId) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }

  const now = new Date();

  const [upcoming, seats, club] = await Promise.all([
    prisma.booking.findMany({
      where: {
        customerId: customer.id,
        status: { in: [...BUSY_STATUSES] },
        startTime: { gte: now },
      },
      include: { court: { select: { name: true } } },
      orderBy: { startTime: 'asc' },
      take: 20,
    }),
    /* Записи в групові заняття шукаються окремо: у контейнера групи
       customerId порожній (клієнта в неї немає), тому запит вище їх
       не бачить і бачити не може. */
    prisma.bookingSeat.findMany({
      where: {
        customerId: customer.id,
        status: 'BOOKED',
        booking: {
          status: { in: [...BUSY_STATUSES] },
          startTime: { gte: now },
        },
      },
      include: {
        booking: {
          include: {
            court: { select: { name: true } },
            trainer: { select: { name: true } },
          },
        },
      },
      orderBy: { booking: { startTime: 'asc' } },
      take: 20,
    }),
    prisma.club.findUnique({
      where: { id: customer.clubId },
      select: { timezone: true, cancelCutoffMinutes: true },
    }),
  ]);

  const tz = club?.timezone ?? 'Europe/Kyiv';
  const cutoff = club?.cancelCutoffMinutes ?? 0;
  const label = (d: Date) => DateTime.fromJSDate(d).setZone(tz).toFormat('HH:mm');

  res.json({
    name: customer.name,
    phone: customer.phone,
    /* Правило клубу їде разом зі списком: віджет має пояснити гравцю, чому
       кнопки більше немає, а не мовчки її прибрати. */
    cancelCutoffMinutes: cutoff,
    upcoming: upcoming.map((b) => ({
      id: b.id,
      courtName: b.court.name,
      start: b.startTime.toISOString(),
      end: b.endTime.toISOString(),
      status: b.status,
      priceTotal: b.priceTotal,
      cancelToken: b.cancelToken,
      canCancel: canCancelNow(b.startTime, cutoff),
    })),
    /* Окремим списком, а не впереміш із бронями: скасовується це іншим
       роутом (звільняється місце, а не корт), і кнопка має бути своя. */
    groups: seats.map((s) => ({
      seatId: s.id,
      cancelToken: s.cancelToken,
      title: s.booking.title,
      courtName: s.booking.court.name,
      trainerName: s.booking.trainer?.name ?? null,
      start: s.booking.startTime.toISOString(),
      end: s.booking.endTime.toISOString(),
      startLabel: label(s.booking.startTime),
      endLabel: label(s.booking.endTime),
      price: s.price,
      canCancel: canCancelNow(s.booking.startTime, cutoff),
    })),
  });
});

/**
 * POST /api/public/seats/:id/cancel — гравець звільняє своє місце.
 *
 * Дві дороги до однієї дії: за `cancelToken` (він видається одразу після
 * запису — працює й без кабінету) або з-під токена кабінету. Друга потрібна
 * саме тоді, коли гравець прийшов через «Мої записи»: токена місця він там
 * не бачив і бачити не мусить.
 *
 * Місце не видаляється, а стає CANCELLED: клуб має бачити, хто передумав.
 * Частковий унікальний індекс seat_one_per_phone рахує тільки BOOKED, тож
 * той самий гравець може записатись у це заняття знову.
 */
publicRouter.post('/seats/:id/cancel', async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const body = z.object({ token: z.string().uuid().optional() }).safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const header = req.headers.authorization;
  const auth = header?.startsWith('Bearer ')
    ? verifyCustomerToken(header.slice(7))
    : null;

  try {
    await prisma.$transaction(async (tx) => {
      const seat = await tx.bookingSeat.findUnique({
        where: { id: id.data },
        include: {
          booking: {
            select: {
              id: true,
              startTime: true,
              clubId: true,
              club: { select: { cancelCutoffMinutes: true } },
            },
          },
        },
      });
      if (!seat) throw new HttpError(404, 'NOT_FOUND');

      /* Чиє це місце. Токен місця або кабінет того самого клієнта — інакше
         сусід по групі зміг би зняти чужий запис, знаючи лише id. */
      const byToken = Boolean(body.data.token) && seat.cancelToken === body.data.token;
      const byCabinet = Boolean(auth)
        && seat.customerId === auth!.customerId
        && seat.booking.clubId === auth!.clubId;
      if (!byToken && !byCabinet) throw new HttpError(404, 'NOT_FOUND');

      // Повторний виклик не має бути помилкою: гравець міг двічі тицьнути
      if (seat.status === 'CANCELLED') return;

      const cutoff = seat.booking.club.cancelCutoffMinutes;
      if (!canCancelNow(seat.booking.startTime, cutoff)) {
        throw new HttpError(400, cutoff > 0 ? 'CANCEL_CLOSED' : 'ALREADY_STARTED');
      }

      await tx.bookingSeat.update({
        where: { id: seat.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });

      /* Виручка йде разом із місцем — інакше скасовані записи назавжди
         лишились би в підсумку дня. */
      await tx.booking.update({
        where: { id: seat.booking.id },
        data: { priceTotal: { decrement: seat.price } },
      });
    });

    res.json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.code });
    console.error('[seat cancel] failed', e);
    res.status(500).json({ error: 'INTERNAL' });
  }
});
