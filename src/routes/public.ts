import { Router } from 'express';
import { canReschedule } from '../lib/reschedule';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { DateTime } from 'luxon';
import { prisma, isSlotTakenError } from '../lib/db';
import { buildSlots, isAlignedToGrid, type Interval } from '../lib/slots';
import { normalizePhone } from '../lib/phone';
import { cleanCustomerName, findOrCreateCustomer, getActivePass } from '../lib/customers';
import { providerFor, publicBase } from '../lib/payments';
import { clubBilling } from '../lib/billing';
import { playerStats } from '../lib/playerStats';
import { playerLevel } from '../lib/playerLevel';
import { clubLadder, ladderWithMe } from '../lib/clubLadder';
import { notifyBooking } from '../lib/notifyBooking';
import { isTrainerAvailable } from '../lib/trainerAvailability';
import { signCustomerToken, verifyCustomerToken } from '../lib/customerAuth';
import { hashCustomerPassword, passwordText, verifyCustomerPassword } from '../lib/customerPassword';
import { birthDateText, birthDateValue, dateOnly } from '../lib/birthday';
import { isRegistrationOpen, registrationClosesAt } from '../lib/registrationCutoff';
import { resolveJoinPayment, tournamentPayMode } from '../lib/tournamentPay';
import { courtPriceWithPromos, bestPromo, promoPrice } from '../lib/promo';
import { canCancelNow, cancelBookingByCustomer, cancelSeatByCustomer } from '../lib/customerCancel';
import { botReady } from '../lib/telegram';
import { planFeatures } from '../lib/plans';
import { createPlayerLinkCode, PLAYER_LINK_MINUTES, playerStartPayload, unlinkPlayers } from '../lib/playerBot';
import { joinWaitlist, type JoinError } from '../lib/waitlist';
import { TelegramMiniAppDataError, verifyTelegramMiniAppData } from '../lib/telegramMiniApp';

/** Бот налаштований і план клубу дозволяє Telegram */
const playerTelegramReady = (plan: Parameters<typeof planFeatures>[0]) =>
  botReady() && Boolean(process.env.TELEGRAM_BOT_USERNAME) && planFeatures(plan).telegram;

export const publicRouter = Router();

// Попередній розрахунок та остаточний перенос використовують одну перевірку.
publicRouter.post('/customer/bookings/:id/reschedule', async (req, res) => {
  const auth = requireCustomerAuth(req, res);
  if (!auth) return;
  const parsed = z.object({
    start: z.string().datetime(), end: z.string().datetime(), courtId: z.string().uuid(),
    preview: z.boolean().default(false), version: z.string().datetime(),
    expectedPrice: z.number().int().nonnegative().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });
  const d = parsed.data;
  const start = new Date(d.start), end = new Date(d.end);
  const fail = (code: string): never => { throw new Error(`RESCHEDULE:${code}`); };
  try {
    const result = await prisma.$transaction(async (tx) => {
      const b = await tx.booking.findFirst({
        where: { id: String(req.params.id), customerId: auth.customerId, clubId: auth.clubId },
        include: { customer: true, payment: true, club: { include: { hours: true, promos: true, plan: true } },
          trainer: { include: { hours: true, exceptions: true } } },
      });
      if (!b) return fail('NOT_FOUND');
      if (b.capacity !== null || !['PENDING', 'CONFIRMED'].includes(b.status)) return fail('NOT_AVAILABLE');
      if (!canReschedule(b.startTime)) return fail('CLOSED');
      if (b.updatedAt.toISOString() !== d.version) return fail('CHANGED');
      if (b.customer?.isBlocked || !clubBilling(b.club).online) return fail('NOT_AVAILABLE');
      if (end <= start || end.getTime() - start.getTime() !== b.endTime.getTime() - b.startTime.getTime()) return fail('DURATION');
      if (start.getTime() <= Date.now() || start.getTime() < Date.now() + b.club.leadTimeMinutes * 60_000) return fail('TOO_LATE');
      const court = await tx.court.findFirst({ where: { id: d.courtId, clubId: auth.clubId, isActive: true } });
      if (!court) return fail('NOT_AVAILABLE');
      const hours = b.club.hours.find(h => h.weekday === DateTime.fromJSDate(start).setZone(b.club.timezone).weekday % 7);
      const slotMinutes = court.slotMinutes ?? b.club.slotMinutes;
      if (!hours || hours.isClosed || !isAlignedToGrid({ start, end, timezone: b.club.timezone,
        openMinute: hours.openMinute, closeMinute: hours.closeMinute, slotMinutes })) return fail('OUT_OF_GRID');
      const blocked = await tx.block.findFirst({ where: { clubId: auth.clubId,
        OR: [{ courtId: null }, { courtId: court.id }], startTime: { lt: end }, endTime: { gt: start } } });
      const occupied = await tx.booking.findFirst({ where: { id: { not: b.id }, clubId: auth.clubId,
        status: { in: ['PENDING', 'CONFIRMED'] }, startTime: { lt: end }, endTime: { gt: start },
        OR: [{ courtId: court.id }, ...(b.trainerId ? [{ trainerId: b.trainerId }] : [])] } });
      if (blocked || occupied) return fail('SLOT_TAKEN');
      if (b.trainer && (!b.trainer.isActive || !isTrainerAvailable(b.trainer.hours, start, end, b.club.timezone, b.trainer.exceptions))) return fail('TRAINER_UNAVAILABLE');
      const trainerPrice = b.trainer ? Math.round(b.trainer.pricePerHour * (end.getTime() - start.getTime()) / 3600_000) : 0;
      const usage = await tx.passUsage.findUnique({ where: { bookingId: b.id }, include: { pass: true } });
      if (usage && !usage.revertedAt && (start < usage.pass.validFrom || end > usage.pass.validUntil)) return fail('PASS_EXPIRED');
      const courtPrice = courtPriceWithPromos({ pricePerHour: court.pricePerHour, start, end,
        timezone: b.club.timezone, courtId: court.id, slotMinutes, promos: b.club.promos, birthDate: b.customer?.birthDate }).price;
      const price = Math.round((courtPrice + trainerPrice) * (100 - (b.customer?.discountPercent ?? 0)) / 100);
      // Зміна суми потребує окремої платіжної операції. До її реалізації
      // не змінюємо ні бронь, ні наявні списання/платежі.
      const reason = b.expiresAt || b.payment?.status === 'PENDING' || b.payment?.refundRequestedAt ? 'PAYMENT_PENDING'
        : price !== b.priceTotal ? 'PRICE_DIFFERENCE' : null;
      if (d.preview) return { price, oldPrice: b.priceTotal, reason, start: d.start, end: d.end, courtName: court.name };
      if (reason) return fail(reason);
      if (d.expectedPrice !== price) return fail('CHANGED');
      if (!canReschedule(b.startTime)) return fail('CLOSED');
      const changed = await tx.booking.updateMany({ where: { id: b.id, updatedAt: b.updatedAt, status: b.status }, data: {
        courtId: court.id, startTime: start, endTime: end, trainerPrice,
        playerRemindedAt: null, playerConfirmedAt: null, playerReminderLeaseUntil: null,
      } });
      if (changed.count !== 1) return fail('CHANGED');
      await tx.bookingReschedule.create({ data: { bookingId: b.id, customerId: auth.customerId,
        fromCourtId: b.courtId, toCourtId: court.id, fromStart: b.startTime, fromEnd: b.endTime,
        toStart: start, toEnd: end, price } });
      return { price, oldPrice: b.priceTotal, reason: null, start: d.start, end: d.end, courtName: court.name };
    }, { isolationLevel: 'Serializable' });
    if (!d.preview) void notifyBooking({ bookingId: String(req.params.id), event: 'updated' }).catch(() => console.error('[reschedule] notification failed'));
    return res.json({ ok: true, ...result });
  } catch (e) {
    if (isSlotTakenError(e) || (e as { code?: string }).code === 'P2034') return res.status(409).json({ error: 'SLOT_TAKEN' });
    if (e instanceof Error && e.message.startsWith('RESCHEDULE:')) return res.status(409).json({ error: e.message.slice(11) });
    throw e;
  }
});

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
    /* Байти логотипа сюди тягнути не можна: цей запит виконується на КОЖЕН
       показ віджета, а logoData важить до 512 КБ. Без omit кожен гравець,
       який відкрив сторінку клуба, качав би логотип із бази — і той навіть
       не потрапляв би у відповідь, бо нижче віддаються лише обрані поля.
       Сам логотип іде окремим роутом, який браузер кешує на рік. */
    omit: { logoData: true },
    include: {
      hours: true,
      /* Тільки заради «чи шле клуб гравцям у Telegram» — рядок плану крихітний. */
      plan: true,
      courts: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
      /* Тільки увімкнені: правило, яке клуб вимкнув, не має ні рахувати
         ціну, ні їхати в кожну відповідь віджета. Рядків одиниці. */
      promos: { where: { isActive: true } },
      trainers: {
        where: { isActive: true },
        /* name — щоб рівні номери (старі записи з 0) не йшли у випадковому порядку */
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: { hours: true, exceptions: { where: { date: { gte: new Date(Date.now() - 86_400_000) } } } },
      },
    },
  });
}

/**
 * Адреса логотипа для віджета й кабінету.
 *
 * Завантажений файл б'є зовнішнє посилання: якщо клуб вивантажив картинку,
 * він саме її й хоче бачити. Мітка часу в запиті — щоб браузер, який тримає
 * попередній логотип рік, побачив новий одразу після заміни.
 *
 * MONOGRAM повертає null: віджет і кабінет на null малюють дві літери, тож
 * перемикач режиму не потребує окремої гілки в жодному компоненті.
 */
export function logoSrcOf(club: {
  slug: string;
  logoMode: 'MONOGRAM' | 'IMAGE';
  logoUrl: string | null;
  logoMime: string | null;
  logoUpdatedAt: Date | null;
}): string | null {
  if (club.logoMode !== 'IMAGE') return null;

  if (club.logoMime && club.logoUpdatedAt) {
    return `/api/public/clubs/${club.slug}/logo?v=${club.logoUpdatedAt.getTime()}`;
  }

  return club.logoUrl || null;
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
      logoUrl: logoSrcOf(club),
      brandColor: club.brandColor,
      pageBackdrop: club.pageBackdrop,
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
    logoUrl: logoSrcOf(club),
    brandColor: club.brandColor,
    pageBackdrop: club.pageBackdrop,
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
    /* Черга на зайнятий час і нагадування працюють тільки через Telegram.
       Віджет за цим прапорцем вирішує, чи зайнята година клікабельна. */
    playerTelegram: playerTelegramReady(club.plan),
    // Разом визначають, чи взагалі бачить гравець оплату і чи це вибір,
    // а чи обов'язок: prepayEnabled=false — оплати немає зовсім;
    // true+true (типово) — оплата обов'язкова, як і раніше;
    // true+false — гравець сам обирає «зараз» чи «на місці».
    prepayEnabled: club.prepayEnabled,
    prepayRequired: club.prepayRequired,
    /* Акції клубу — для повідомлення у віджеті: «у нас дешевший ранок»
       гравець має побачити до того, як почне шукати вільну годину. Це
       правила, а не ціни: скільки коштуватиме конкретна година, віджет
       бере зі слоту, а остаточну суму все одно рахує сервер при броні. */
    promos: club.promos.map((p) => ({
      id: p.id,
      title: p.title,
      kind: p.kind,
      weekdays: p.weekdays,
      dateFrom: dateOnly(p.dateFrom),
      dateTo: dateOnly(p.dateTo),
      daysBefore: p.daysBefore,
      daysAfter: p.daysAfter,
      startMinute: p.startMinute,
      endMinute: p.endMinute,
      discountType: p.discountType,
      discountValue: p.discountValue,
      courtIds: p.courtIds,
    })),
  });
});

/**
 * GET /api/public/clubs/:slug/logo — сам файл логотипа.
 *
 * Публічний навмисно: віджет стоїть на сайті клуба, і картинка має
 * вантажитись без токена — так само, як вантажиться логотип із будь-якого
 * чужого домену.
 *
 * Кешується на рік і незмінно (`immutable`), бо адреса містить мітку часу
 * останньої заміни: новий файл — нова адреса, стара лежить у браузері й
 * нікому не заважає. Без цього кожен показ віджета качав би сотні кілобайт.
 *
 * `nosniff` і фіксований Content-Type зі свого ж переліку: браузер не має
 * права переінтерпретувати вміст, навіть якщо в базу колись потрапить не те,
 * що ми думали.
 */
publicRouter.get('/clubs/:slug/logo', async (req, res) => {
  const club = await prisma.club.findFirst({
    where: { slug: req.params.slug },
    select: { logoData: true, logoMime: true, logoUpdatedAt: true },
  });

  if (!club?.logoData || !club.logoMime) {
    return res.status(404).json({ error: 'NO_LOGO' });
  }

  res.setHeader('Content-Type', club.logoMime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');

  if (club.logoUpdatedAt) {
    res.setHeader('ETag', `"${club.logoUpdatedAt.getTime()}"`);
  }

  res.send(club.logoData);
});

/**
 * GET /api/public/inventory/:id/photo — фото речі з комори клубу.
 *
 * Публічний з тієї ж причини, що й логотип: <img src> не вміє слати
 * заголовок авторизації, а тягнути кожну картку через fetch з токеном і
 * blob-адресами — це три екрани коду заради знімка ракетки. Адреса — це
 * випадковий uuid: вгадати його не можна, а хто має посилання, той уже має
 * і доступ до кабінету. Таємниці у фотографії кошика з мʼячами рівно
 * стільки ж, скільки в логотипі на дверях.
 *
 * Нічого, крім самих байтів, роут не віддає: ні назви речі, ні клубу.
 */
publicRouter.get('/inventory/:id/photo', async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const item = await prisma.inventoryItem.findUnique({
    where: { id: id.data },
    select: { photoData: true, photoMime: true, photoUpdatedAt: true },
  });

  if (!item?.photoData || !item.photoMime) {
    return res.status(404).json({ error: 'NO_PHOTO' });
  }

  res.setHeader('Content-Type', item.photoMime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  if (item.photoUpdatedAt) res.setHeader('ETag', `"${item.photoUpdatedAt.getTime()}"`);

  res.send(item.photoData);
});

/**
 * GET /api/public/clubs/:slug/trainers?start=&end=
 *
 * Тренери, вільні на цей проміжок. Без start/end — просто весь список.
 *
 * Доступність = інтервал входить у регулярний графік тренера І на ньому
 * ще немає заняття. Порожній графік лишає стару поведінку.
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

  const range = start && end ? { start: new Date(start), end: new Date(end) } : null;

  res.json(club.trainers.map((t) => ({
    id: t.id,
    name: t.name,
    pricePerHour: t.pricePerHour,
    note: t.note,
    available: !busy.has(t.id) && (!range || isTrainerAvailable(
      t.hours, range.start, range.end, club.timezone, t.exceptions,
    )),
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
        paymentPlan: true,
        trainer: { select: { name: true } },
        /* PENDING рахується зайнятим нарівні з BOOKED: місце під оплатою
           вже не вільне, і показувати його як вільне означало б вести
           другого гравця в платіжку за тим самим стільцем. */
        seats: { where: { status: { in: ['BOOKED', 'PENDING'] } }, select: { id: true } },
      },
    }),
    prisma.block.findMany({
      where: { clubId: club.id, startTime: { lt: to }, endTime: { gt: from } },
      select: { courtId: true, startTime: true, endTime: true },
    }),
  ]);

  const now = new Date();

  /* Кого ми обслуговуємо. Акція на день народження діє не «в такі дні», а
     «в такі дні ЦЬОГО гравця», тож гостю її в сітці показати нема з чого:
     він побачить звичайну ціну, а не чужу знижку. Токен тут
     необовʼязковий — без нього сітка працює рівно як раніше. */
  const header = req.headers.authorization;
  const viewer = header?.startsWith('Bearer ')
    ? verifyCustomerToken(header.slice(7))
    : null;
  const me = viewer && viewer.clubId === club.id
    ? await prisma.customer.findFirst({
        where: { id: viewer.customerId, clubId: club.id },
        select: { birthDate: true },
      })
    : null;

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

    /* Акційна ціна цієї години. Рахуємо по ПОЧАТКУ слоту — тим самим
       правилом, що й ціну броні: година, яка почалась у вікні акції,
       продається за акційною ціною цілком. */
    const promoFor = (startIso: string) => {
      if (club.promos.length === 0) return null;
      const at = DateTime.fromISO(startIso).setZone(club.timezone);
      const promo = bestPromo(
        club.promos,
        {
          date: at.toFormat('yyyy-MM-dd'),
          startMinute: at.hour * 60 + at.minute,
          courtId: court.id,
          birthDate: me?.birthDate ?? null,
        },
        court.pricePerHour,
      );
      if (!promo) return null;

      return {
        id: promo.id,
        title: promo.title,
        kind: promo.kind,
        discountType: promo.discountType,
        discountValue: promo.discountValue,
        /* Ціна години зі знижкою, копійки. Віджет не перераховує її сам:
           два округлення в різних місцях — два різні числа на екрані. */
        price: promoPrice(court.pricePerHour, promo),
      };
    };

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
            /* Не весь paymentPlan, а тільки режим: у плані лежить ще й
               хто та коли його записав — це кухня клубу, а не діло
               гравця. 'CLUB' означає «за загальними правилами клубу». */
            payMode: tournamentPayMode(g),
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
            registrationOpen: isRegistrationOpen(g.startTime, now.getTime()),
            registrationClosesAt: registrationClosesAt(g.startTime).toISOString(),
          },
        };
      }).map((s) => {
        const promo = promoFor(s.start);
        return promo ? { ...s, promo } : s;
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
  customerEmail: z.string().trim().toLowerCase().email().max(254).optional(),
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
  birthDate: birthDateText,
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

  /* Номер належить акаунту — бронювати на нього можна тільки увійшовши.
     Перевіряємо ДО findOrCreateCustomer: той оновлює пошту картки, і без
     входу її не має права міняти ніхто. */
  const guard = await accountGuard(req, club.id, phone.e164);
  if (guard.blocked) return res.status(401).json({ error: 'LOGIN_REQUIRED' });

  const customer = await findOrCreateCustomer({
    clubId: club.id,
    name: body.customerName,
    rawPhone: body.customerPhone,
    email: body.customerEmail,
    birthDate: body.birthDate ? birthDateValue(body.birthDate) : undefined,
  });
  if (customer?.isBlocked) return res.status(403).json({ error: 'CUSTOMER_BLOCKED' });
  if (customer && !guard.signedIn && dateOnly(customer.birthDate) !== body.birthDate) {
    return res.status(403).json({ error: 'BIRTH_DATE_MISMATCH' });
  }

  /* Токен профілю бронь більше не видає: профіль відчиняє тільки пароль.
     Хто увійшов — той і так із токеном, повертаємо його ж для сумісності. */
  const customerToken = customer && guard.signedIn
    ? signCustomerToken({ customerId: customer.id, clubId: club.id })
    : undefined;

  const minutes = (end.getTime() - start.getTime()) / 60_000;

  /* Акційна ціна корту. Правило клубу може бути на час («щасливі години»),
     на дати або на день народження — останньому потрібно знати, хто
     бронює, тому дата народження їде в розрахунок. Вона вже звірена з
     карткою вище (BIRTH_DATE_MISMATCH), тож підставити чужий день
     народження заради знижки не вийде. */
  const { price: courtPrice } = courtPriceWithPromos({
    pricePerHour: court.pricePerHour,
    start,
    end,
    timezone: club.timezone,
    slotMinutes,
    courtId: court.id,
    promos: club.promos,
    birthDate: body.birthDate,
  });

  // Тренер: перевіряємо, що він цього клубу, активний і не зайнятий.
  // Friendly pre-check; trainer_no_overlap is the final concurrent-write guard.
  let trainer = null;
  let trainerPrice = 0;

  if (body.trainerId) {
    trainer = club.trainers.find((t) => t.id === body.trainerId && t.isActive) ?? null;
    if (!trainer) return res.status(404).json({ error: 'TRAINER_NOT_FOUND' });

    if (!isTrainerAvailable(trainer.hours, start, end, club.timezone, trainer.exceptions)) {
      return res.status(409).json({ error: 'TRAINER_UNAVAILABLE' });
    }

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

  const priceBeforeDiscount = courtPrice + trainerPrice;
  const priceTotal = Math.round(priceBeforeDiscount * (100 - (customer?.discountPercent ?? 0)) / 100);

  // Три стани клуба: оплати немає (prepayEnabled=false), оплата обов'язкова
  // (prepayRequired=true, типово) — і новий: гравець сам обирає при броні.
  // У третьому стані вибір обов'язковий — без нього незрозуміло, чи повертати
  // слот, тому просимо перепитати, а не тихо вгадувати «на місці».
  if (club.prepayEnabled && !club.prepayRequired && !body.payChoice) {
    return res.status(400).json({ error: 'PAY_CHOICE_REQUIRED' });
  }

  const wantsOnlinePay = club.prepayRequired || body.payChoice === 'online';
  const provider = club.prepayEnabled && wantsOnlinePay ? providerFor(club) : null;
  if (club.prepayEnabled && wantsOnlinePay && priceTotal > 0 && !provider) {
    return res.status(409).json({ error: 'ONLINE_PAYMENT_UNAVAILABLE' });
  }
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
        /* Платна бронь підтверджується тільки фактом повної оплати.
           Обіцянка заплатити на місці лишає її PENDING без таймера. */
        status: priceTotal > 0 ? 'PENDING' : (club.autoConfirm ? 'CONFIRMED' : 'PENDING'),
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

  /* Без передоплати повідомляємо одразу. З передоплатою — після оплати
     (див. lib/payments/apply.ts), інакше адміну падатимуть покинуті кошики.

     Кому саме піде повідомлення — клубній групі, власнику, модератору,
     тренеру — вирішує notifyBooking. Тут ми знаємо лише те, що бронь
     зʼявилась. */
  void notifyBooking({ bookingId: booking.id, event: 'created' });

  res.status(201).json({
    id: booking.id,
    status: booking.status,
    cancelToken: booking.cancelToken,
    priceTotal,
    customerToken,
  });
});

const joinSchema = z.object({
  customerName: z.string().trim().min(2).max(80),
  customerPhone: z.string().trim().regex(/^\+?[0-9\s()-]{9,20}$/, 'invalid phone'),
  comment: z.string().trim().max(300).optional(),
  /** Куди повернути гравця після платіжки. Віджет підставляє свою сторінку. */
  returnUrl: z.string().url().max(500).optional(),
  /** Те саме, що й у броні корту: має сенс лише коли клуб лишив вибір гравцю. */
  payChoice: z.enum(['online', 'onsite']).optional(),
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

/* Правило «чи гравець ще може зняти запис сам» живе в lib/customerCancel —
   ним же користується кнопка «Скасувати» в Telegram. Реекспорт лишає
   старий імпорт робочим. */
export { canCancelNow };

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
 * ── Оплата ───────────────────────────────────────────────────────────────
 *
 * Правила ті самі, що й у броні корту: клуб або не бере передоплату, або
 * вимагає її, або лишає вибір гравцю. Різниця одна — неоплачене місце
 * тримає не корт, а одиницю місткості, тому воно створюється в статусі
 * PENDING з `expiresAt`, а не окремим «резервом».
 *
 * Виручку заняття неоплачене місце НЕ підіймає: priceTotal росте в момент
 * оплати (lib/payments/apply.ts). Інакше покинутий кошик на чверть години
 * додавав би клубу грошей, яких він не бачив.
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

  /* Те саме правило, що й у броні корту: місце на номер акаунта — тільки
     після входу, інакше чужа знижка й чуже місце в турнірі. */
  const guard = await accountGuard(req, club.id, phone.e164);
  if (guard.blocked) return res.status(401).json({ error: 'LOGIN_REQUIRED' });

  const customer = await findOrCreateCustomer({
    clubId: club.id,
    name: body.customerName,
    rawPhone: body.customerPhone,
  });
  if (customer?.isBlocked) return res.status(403).json({ error: 'CUSTOMER_BLOCKED' });

  /* Провайдер платежів вибирається вже всередині транзакції: для турніру
     відповідь залежить від самої події, а не тільки від клубу, і прочитати
     її можна лише під замком рядка. Рахунок виставляємо після транзакції,
     тому змінна живе тут. */
  let provider: ReturnType<typeof providerFor> = null;

  let made;
  try {
    made = await prisma.$transaction(async (tx) => {
      /* Блокуємо саме рядок заняття. Всі, хто записується в ЦЮ групу,
         стають у чергу тут; записи в інші групи не чекають. */
      const rows = await tx.$queryRaw<
        {
          id: string; clubId: string; capacity: number | null; pricePerSeat: number | null;
          status: string; title: string | null; startTime: Date; endTime: Date; paymentPlan: { method?: string };
        }[]
      >`SELECT "id", "clubId", "capacity", "pricePerSeat", "status"::text, "title", "startTime", "endTime", "paymentPlan"
          FROM "Booking" WHERE "id" = ${bookingId.data}::uuid FOR UPDATE`;

      const b = rows[0];
      if (!b) throw new HttpError(404, 'NOT_FOUND');
      if (b.clubId !== club.id) throw new HttpError(404, 'NOT_FOUND');
      if (b.capacity == null) throw new HttpError(400, 'NOT_A_GROUP');
      if (!BUSY_STATUSES.includes(b.status as never)) throw new HttpError(409, 'GROUP_CANCELLED');

      if (!isRegistrationOpen(b.startTime)) {
        throw new HttpError(409, 'REGISTRATION_CLOSED');
      }

      /* PENDING рахується зайнятим нарівні з BOOKED: поки один платить,
         його місце вже не вільне. Інакше восьмимісна група продала б
         дев'яте місце за ті самі п'ятнадцять хвилин холду. */
      const HELD = ['BOOKED', 'PENDING'] as const;

      const taken = await tx.bookingSeat.count({
        where: { bookingId: b.id, status: { in: [...HELD] } },
      });
      if (taken >= b.capacity) throw new HttpError(409, 'GROUP_FULL');

      const already = await tx.bookingSeat.findFirst({
        where: { bookingId: b.id, customerPhone: phone.e164, status: { in: [...HELD] } },
        select: { id: true },
      });
      if (already) throw new HttpError(409, 'ALREADY_JOINED');

      const price = Math.round((b.pricePerSeat ?? 0) * (100 - (customer?.discountPercent ?? 0)) / 100);

      /* Чим платить учасник. У турніру своє правило, у решти груп — клубне
         (див. lib/tournamentPay.ts). Рахуємо всередині транзакції, бо
         тільки тут ми вже прочитали саму подію під замком. */
      const pay = resolveJoinPayment({
        mode: tournamentPayMode(b),
        price,
        prepayEnabled: club.prepayEnabled,
        prepayRequired: club.prepayRequired,
        payChoice: body.payChoice,
      });
      if (pay.error) {
        throw new HttpError(pay.error === 'PAY_CHOICE_REQUIRED' ? 400 : 409, pay.error);
      }

      /* Еквайринг увімкнено, але ключі не заведені — платіжки не буде.
         Для турніру «тільки онлайн» це відмова: пустити без оплати
         означало б зламати саме те правило, заради якого його ставили. */
      provider = pay.online ? providerFor(club) : null;
      if (pay.online && !provider) throw new HttpError(409, 'ONLINE_PAYMENT_UNAVAILABLE');

      const needsPay = Boolean(provider) && price > 0;

      const created = await tx.bookingSeat.create({
        data: {
          bookingId: b.id,
          customerId: customer?.id ?? null,
          customerName: body.customerName.trim(),
          customerPhone: phone.e164,
          comment: body.comment,
          price,
          source: 'WIDGET',
          status: needsPay ? 'PENDING' : 'BOOKED',
          expiresAt: needsPay ? new Date(Date.now() + club.payHoldMinutes * 60_000) : null,
        },
      });

      /* Виручка заняття росте разом із проданими місцями — так підсумок
         дня рахується сам, без окремої гілки в аналітиці. Місце, яке ще
         не оплачене, продане не є: його додасть вебхук. */
      if (!needsPay) {
        await tx.booking.update({
          where: { id: b.id },
          data: { priceTotal: { increment: price } },
        });
      }

      return { seat: created, group: b, price, needsPay };
    });
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.code });
    console.error('[join] failed', e);
    return res.status(500).json({ error: 'INTERNAL' });
  }

  const { seat, group, price, needsPay } = made;

  if (!needsPay) {
    /* Те саме правило, що й у броні корту: без передоплати місце продане
       вже зараз, з передоплатою про нього скаже вебхук. Раніше запис у
       групу не бачив узагалі ніхто — ні клуб, ні тренер, який цю групу
       веде. */
    void notifyBooking({ bookingId: group.id, seatId: seat.id, event: 'created' });

    return res.status(201).json({
      id: seat.id,
      cancelToken: seat.cancelToken,
      price: seat.price,
      status: seat.status,
    });
  }

  /* Рахунок виставляємо ПІСЛЯ транзакції: похід у банк займає сотні
     мілісекунд, і тримати на ньому рядковий замок заняття означало б
     ставити в чергу всіх, хто записується в ту саму групу. */
  const back = new URL(safeReturnUrl(body.returnUrl, req.headers.origin));
  back.searchParams.set('cbSeat', seat.cancelToken);

  const when = `${DateTime.fromJSDate(group.startTime).setZone(club.timezone).toFormat('dd.MM HH:mm')}–` +
    `${DateTime.fromJSDate(group.endTime).setZone(club.timezone).toFormat('HH:mm')}`;

  try {
    const invoice = await provider!.createInvoice({
      amountKop: price,
      reference: seat.id,
      destination: `${club.name}: ${group.title ?? 'заняття'}, ${when}`,
      redirectUrl: back.toString(),
      webHookUrl: `${publicBase()}/api/pay/webhook/${club.id}`,
      ttlSeconds: club.payHoldMinutes * 60,
    });

    await prisma.payment.create({
      data: {
        clubId: club.id,
        seatId: seat.id,
        provider: provider!.name,
        providerRef: invoice.providerRef,
        pageUrl: invoice.pageUrl,
        amount: price,
      },
    });

    return res.status(201).json({
      id: seat.id,
      cancelToken: seat.cancelToken,
      price,
      status: 'PENDING',
      payUrl: invoice.pageUrl,
      expiresAt: seat.expiresAt!.toISOString(),
    });
  } catch (e) {
    // Рахунок не виставився — тримати місце немає підстав, віддаємо одразу.
    console.error('[join] invoice failed', e);
    await prisma.bookingSeat.update({
      where: { id: seat.id },
      data: { status: 'EXPIRED', expiresAt: null },
    }).catch(() => {});
    return res.status(502).json({ error: 'PAYMENT_UNAVAILABLE' });
  }
});

/**
 * GET /api/public/seats/:token/status — те саме, що й у броні, але для місця.
 *
 * Віджет опитує сюди після повернення з платіжки. Джерело правди — вебхук,
 * а не факт повернення гравця, тому статус читається з бази.
 */
publicRouter.get('/seats/:token/status', async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.token);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const seat = await prisma.bookingSeat.findUnique({
    where: { cancelToken: parsed.data },
    include: {
      payment: { select: { status: true } },
      booking: {
        select: {
          title: true, startTime: true, endTime: true,
          court: { select: { name: true } },
          trainer: { select: { name: true } },
          club: { select: { timezone: true } },
        },
      },
    },
  });
  if (!seat) return res.status(404).json({ error: 'NOT_FOUND' });

  const tz = seat.booking.club.timezone;
  const label = (d: Date) => DateTime.fromJSDate(d).setZone(tz).toFormat('HH:mm');

  res.json({
    id: seat.id,
    status: seat.status,
    paymentStatus: seat.payment?.status ?? null,
    title: seat.booking.title,
    courtName: seat.booking.court.name,
    trainerName: seat.booking.trainer?.name ?? null,
    start: seat.booking.startTime.toISOString(),
    end: seat.booking.endTime.toISOString(),
    startLabel: label(seat.booking.startTime),
    endLabel: label(seat.booking.endTime),
    price: seat.price,
    expiresAt: seat.expiresAt?.toISOString() ?? null,
  });
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

  /* Токен перевіряємо тут, до спільної функції: без нього будь-хто, хто
     знає id броні, скасував би чужу гру. */
  const owned = await prisma.booking.findUnique({
    where: { id: req.params.id },
    select: { cancelToken: true },
  });
  if (!owned || owned.cancelToken !== parsed.data.token) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }

  const result = await cancelBookingByCustomer(req.params.id);
  if (!result.ok) return res.status(result.status).json({ error: result.code });

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

// Signed Telegram launches do not consume the password-attempt allowance.
// Separate buckets prevent Mini App opens from locking ordinary web login.
const telegramSessionLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS' },
});

/**
 * Чи можна діяти від імені картки з цим телефоном.
 *
 * Картка з паролем — це акаунт: бронювати чи записуватись на її номер можна
 * тільки з її ж токеном. Інакше форма броні лишалась би обхідними дверима
 * в чужий профіль — зі знижкою власника, його бонусами і правом змінити
 * пошту картки. Гість і картка без пароля бронюють як і раніше.
 */
async function accountGuard(req: import('express').Request, clubId: string, phone: string) {
  const owner = await prisma.customer.findUnique({
    where: { clubId_phone: { clubId, phone } },
    select: { id: true, passwordHash: true },
  });
  const header = req.headers.authorization;
  const viewer = header?.startsWith('Bearer ') ? verifyCustomerToken(header.slice(7)) : null;
  const signedIn = Boolean(owner && viewer && viewer.clubId === clubId && viewer.customerId === owner.id);
  return { blocked: Boolean(owner?.passwordHash) && !signedIn, signedIn };
}

/**
 * POST /api/public/clubs/:slug/customer/login  { phone, password }
 *
 * Телефон + пароль. Дата народження профіль більше не відчиняє — див.
 * lib/customerPassword.ts.
 */
publicRouter.post('/clubs/:slug/customer/login', customerLoginLimiter, async (req, res) => {
  const parsed = z
    .object({ phone: z.string().trim(), password: z.string().min(1).max(128) })
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
  if (!customer) return res.status(404).json({ error: 'CUSTOMER_NOT_FOUND' });

  const check = await verifyCustomerPassword(customer.id, parsed.data.password);
  if (!check.ok) {
    /* Картка є, а пароля в неї немає: заведена адміністратором, бронню
       гостя або до появи паролів. Віджет пропонує створити акаунт на цей
       номер — а не каже «невірний пароль», якого людина ніколи не мала. */
    if (check.reason === 'NOT_SET') return res.status(409).json({ error: 'PASSWORD_NOT_SET' });
    if (check.reason === 'LOCKED') return res.status(429).json({ error: 'ACCOUNT_LOCKED' });
    return res.status(403).json({ error: 'INVALID_CREDENTIALS' });
  }

  res.json({
    token: signCustomerToken({ customerId: customer.id, clubId: club.id }),
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    birthDate: dateOnly(customer.birthDate),
  });
});

/**
 * POST /api/public/clubs/:slug/customer/register  { phone, name, birthDate, password }
 *
 * Акаунт гравця: створюється тільки разом із паролем.
 *
 * Номер, у якого акаунт уже є, — 409, а не тихий вхід: інакше форма
 * реєстрації стала б другою формою входу без пароля.
 *
 * Картку без пароля (заведену адміністратором, бронню гостя чи до появи
 * паролів) можна перетворити на акаунт. Якщо в картці вже є дата
 * народження, вона мусить збігтися — хоч якийсь доказ, що картка твоя.
 * Пароль ставиться умовним оновленням «де пароля ще немає»: двоє, що
 * одночасно реєструють той самий номер, не перезапишуть одне одного.
 */
publicRouter.post('/clubs/:slug/customer/register', customerLoginLimiter, async (req, res) => {
  const parsed = z
    .object({ phone: z.string().trim(), name: z.string(), birthDate: birthDateText, password: passwordText })
    .safeParse(req.body);
  if (!parsed.success) {
    const weak = parsed.error.issues.some((i) => i.path[0] === 'password');
    return res.status(400).json({ error: weak ? 'WEAK_PASSWORD' : 'BAD_REQUEST' });
  }

  const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const club = await loadClub(slug);
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });

  const name = cleanCustomerName(parsed.data.name);
  if (!name) return res.status(400).json({ error: 'BAD_NAME' });

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: 'BAD_PHONE' });

  const existing = await prisma.customer.findUnique({
    where: { clubId_phone: { clubId: club.id, phone: phone.e164 } },
    select: { birthDate: true, passwordHash: true },
  });
  if (existing?.passwordHash) return res.status(409).json({ error: 'ALREADY_REGISTERED' });
  if (existing?.birthDate && dateOnly(existing.birthDate) !== parsed.data.birthDate) {
    return res.status(403).json({ error: 'BIRTH_DATE_MISMATCH' });
  }

  const customer = await findOrCreateCustomer({
    clubId: club.id,
    name,
    rawPhone: phone.e164,
    birthDate: birthDateValue(parsed.data.birthDate),
  });
  if (!customer) return res.status(400).json({ error: 'BAD_PHONE' });

  const claimed = await prisma.customer.updateMany({
    where: { id: customer.id, passwordHash: null },
    data: {
      passwordHash: await hashCustomerPassword(parsed.data.password),
      passwordFails: 0,
      passwordLockedUntil: null,
    },
  });
  if (claimed.count !== 1) return res.status(409).json({ error: 'ALREADY_REGISTERED' });

  res.status(201).json({
    token: signCustomerToken({ customerId: customer.id, clubId: club.id }),
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    birthDate: dateOnly(customer.birthDate),
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
publicRouter.get('/customer/records/:kind/:id/payment', async (req, res) => {
  const auth = requireCustomerAuth(req, res);
  if (!auth) return;
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success || !['court', 'seat'].includes(String(req.params.kind))) return res.sendStatus(400);
  const item = req.params.kind === 'seat'
    ? await prisma.bookingSeat.findFirst({ where: { id: id.data, customerId: auth.customerId, booking: { clubId: auth.clubId, status: { in: ['PENDING', 'CONFIRMED'] } } }, include: { payment: true } })
    : await prisma.booking.findFirst({ where: { id: id.data, customerId: auth.customerId, clubId: auth.clubId }, include: { payment: true } });
  if (!item) return res.sendStatus(404);
  if (item.status !== 'PENDING' || !item.expiresAt || item.expiresAt <= new Date() || item.payment?.status !== 'PENDING' || !item.payment.pageUrl) {
    return res.status(409).json({ error: 'PAYMENT_NOT_PENDING' });
  }
  res.set('Cache-Control', 'no-store').json({ url: item.payment.pageUrl });
});

/**
 * POST /api/public/clubs/:slug/customer/telegram-session { initData }
 *
 * Seamless Mini App login for a profile that was already linked in the
 * bot. The browser never sends a Telegram user id by itself: the id is
 * accepted only from fresh, HMAC-verified Telegram.WebApp.initData.
 * Customer.telegramChatId was written from a private bot chat, whose chat
 * id is the same Telegram user id, so it is the existing database link.
 */
publicRouter.post('/clubs/:slug/customer/telegram-session', telegramSessionLimiter, async (req, res) => {
  const parsed = z.object({ initData: z.string().min(1).max(8192) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  let identity;
  try {
    identity = verifyTelegramMiniAppData(parsed.data.initData);
  } catch (error) {
    if (error instanceof TelegramMiniAppDataError && error.code === 'UNAVAILABLE') {
      return res.status(503).json({ error: 'TELEGRAM_UNAVAILABLE' });
    }
    return res.status(401).json({ error: 'INVALID_TELEGRAM_DATA' });
  }

  const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const club = await loadClub(slug);
  if (!club) return res.status(404).json({ error: 'CLUB_NOT_FOUND' });
  if (!club.isActive || !club.approvedAt || !planFeatures(club.plan).telegram) {
    return res.status(503).json({ error: 'TELEGRAM_UNAVAILABLE' });
  }

  const customer = await prisma.customer.findFirst({
    where: { clubId: club.id, telegramChatId: identity.userId },
  });
  if (!customer) return res.status(404).json({ error: 'TELEGRAM_ACCOUNT_NOT_LINKED' });

  res.set('Cache-Control', 'no-store').json({
    token: signCustomerToken({ customerId: customer.id, clubId: club.id }),
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    birthDate: dateOnly(customer.birthDate),
  });
});

publicRouter.get('/customer/me', async (req, res) => {
  const auth = requireCustomerAuth(req, res);
  if (!auth) return;

  const customer = await prisma.customer.findUnique({ where: { id: auth.customerId } });
  if (!customer || customer.clubId !== auth.clubId) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }

  const now = new Date();

  const [upcoming, seats, club, pastBookings, pastSeats, pass, waitlist] = await Promise.all([
    prisma.booking.findMany({
      where: {
        customerId: customer.id,
        status: { in: [...BUSY_STATUSES] },
        startTime: { gte: now },
      },
      include: { court: { select: { name: true } }, payment: true },
      orderBy: { startTime: 'asc' },
      take: 20,
    }),
    /* Записи в групові заняття шукаються окремо: у контейнера групи
       customerId порожній (клієнта в неї немає), тому запит вище їх
       не бачить і бачити не може. */
    prisma.bookingSeat.findMany({
      where: {
        customerId: customer.id,
        status: { in: ['BOOKED', 'PENDING'] },
        booking: {
          status: { in: [...BUSY_STATUSES] },
          startTime: { gte: now },
        },
      },
      include: {
        payment: true,
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
      select: { timezone: true, cancelCutoffMinutes: true, passesEnabled: true, plan: true },
    }),
    /* Минулі відвідування — тільки для підсумку в картці гравця.
       Беремо обидва джерела й лише поля, потрібні для статистики:
       список минулих броней сам по собі гравцю у віджеті не показуємо,
       щоб не перетворювати картку на бухгалтерію. */
    prisma.booking.findMany({
      where: {
        customerId: customer.id,
        status: 'CONFIRMED',
        startTime: { lte: now },
      },
      select: {
        id: true,
        startTime: true,
        endTime: true,
        priceTotal: true,
        court: { select: { name: true } },
        trainer: { select: { name: true } },
      },
      take: 500,
    }),
    prisma.bookingSeat.findMany({
      where: {
        customerId: customer.id,
        status: 'BOOKED',
        booking: { status: 'CONFIRMED', startTime: { lte: now } },
      },
      select: {
        id: true,
        price: true,
        booking: {
          select: {
            startTime: true,
            endTime: true,
            court: { select: { name: true } },
            trainer: { select: { name: true } },
          },
        },
      },
      take: 500,
    }),
    /* Абонемент. Той самий getActivePass, що бачить ресепшен, — щоб
       гравець і адміністратор не сперечались про залишок біля стійки. */
    getActivePass(customer.id, now),
    /* Черги гравця — щоб у профілі було видно, на що він чекає, і з
       черги можна було вийти, не шукаючи повідомлення бота. */
    prisma.waitlistEntry.findMany({
      where: { customerId: customer.id, status: { in: ['WAITING', 'OFFERED'] }, startTime: { gt: now } },
      select: {
        id: true, courtId: true, startTime: true, endTime: true, status: true, offerUntil: true,
        court: { select: { name: true } },
      },
      orderBy: { startTime: 'asc' },
      take: 10,
    }),
  ]);

  const tz = club?.timezone ?? 'Europe/Kyiv';
  const cutoff = club?.cancelCutoffMinutes ?? 0;
  const label = (d: Date) => DateTime.fromJSDate(d).setZone(tz).toFormat('HH:mm');

  /* Підсумок гравця про себе: скільки разів приходив, де грає найчастіше,
     з ким тренується і скільки тижнів поспіль не пропускає. */
  const stats = playerStats(
    [
      ...pastBookings.map((b) => ({
        start: b.startTime,
        end: b.endTime,
        courtName: b.court?.name ?? null,
        trainerName: b.trainer?.name ?? null,
        kind: 'court' as const,
        price: b.priceTotal,
      })),
      ...pastSeats.map((s) => ({
        start: s.booking.startTime,
        end: s.booking.endTime,
        courtName: s.booking.court?.name ?? null,
        trainerName: s.booking.trainer?.name ?? null,
        kind: 'group' as const,
        price: s.price,
      })),
    ],
    tz,
    now,
  );

  /* Внутрішній рівень клубу. Він міряється місцем серед своїх, тому потрібен
     підсумок по всіх гравцях — він кешується на п'ять хвилин (clubLadder).

     Рівень рахуємо тільки тим, хто вже приходив: «Новачок, 0 із 84» для
     людини з першою бронею попереду — це не привітання, а вирок. */
  const level = stats.visits > 0
    ? playerLevel(
      { visits: stats.visits, hours: stats.hours, spent: stats.spent },
      ladderWithMe(
        await clubLadder(customer.clubId, now),
        customer.id,
        { visits: stats.visits, hours: stats.hours, spent: stats.spent },
      ),
    )
    : null;

  /* Витрати лишаються на сервері. Вони входять у рівень, але окремим
     числом гравцю не показуються: профіль у віджеті — про звичку ходити,
     а не про те, скільки людина занесла в касу. */
  const { spent: _spent, ...publicStats } = stats;

  res.json({
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    birthDate: dateOnly(customer.birthDate),
    discountPercent: customer.discountPercent,
    bonusBalance: customer.bonusBalance,
    stats: publicStats,
    level,
    /* passId гравцю ні до чого: скасувати чи змінити абонемент він не
       може, а зайвий ідентифікатор у відповіді — це зайвий ідентифікатор
       у відповіді. label теж лишається адмінці: у віджеті число й дата
       верстаються окремо. */
    /* Клуб, який абонементів не веде, не має показувати залишок навіть
       тоді, коли в базі щось лежить: вимикач у налаштуваннях означає «ми
       цим більше не займаємось», і залишок на екрані гравця після нього —
       обіцянка, якої на ресепшені не виконають. */
    pass: club?.passesEnabled === false || !pass ? null : {
      type: pass.type,
      left: pass.left,
      total: pass.total,
      validUntil: pass.validUntil.toISOString(),
      daysLeft: pass.daysLeft,
    },
    /* Правило клубу їде разом зі списком: віджет має пояснити гравцю, чому
       кнопки більше немає, а не мовчки її прибрати. */
    cancelCutoffMinutes: cutoff,
    /* available — чи може клуб узагалі слати гравцю в Telegram (план і
       бот). Без нього віджет показав би кнопку, яка нічого не підключить. */
    telegram: {
      available: playerTelegramReady(club?.plan),
      connected: Boolean(customer.telegramChatId),
    },
    waitlist: waitlist.map((w) => ({
      id: w.id,
      courtId: w.courtId,
      courtName: w.court.name,
      start: w.startTime.toISOString(),
      end: w.endTime.toISOString(),
      status: w.status,
      offerUntil: w.offerUntil?.toISOString() ?? null,
    })),
    upcoming: upcoming.map((b) => ({
      id: b.id,
      courtName: b.court.name,
      start: b.startTime.toISOString(),
      end: b.endTime.toISOString(),
      status: b.status,
      expiresAt: b.expiresAt?.toISOString() ?? null,
      paymentStatus: b.payment?.status ?? null,
      canResumePayment: b.status === 'PENDING' && Boolean(b.expiresAt && b.expiresAt > now && b.payment?.status === 'PENDING' && b.payment.pageUrl),
      priceTotal: b.priceTotal,
      cancelToken: b.cancelToken,
      courtId: b.courtId,
      version: b.updatedAt.toISOString(),
      canReschedule: b.capacity === null && canReschedule(b.startTime),
      canCancel: canCancelNow(b.startTime, cutoff),
    })),
    /* Окремим списком, а не впереміш із бронями: скасовується це іншим
       роутом (звільняється місце, а не корт), і кнопка має бути своя. */
    groups: seats.map((s) => ({
      seatId: s.id,
      status: s.status,
      expiresAt: s.expiresAt?.toISOString() ?? null,
      paymentStatus: s.payment?.status ?? null,
      canResumePayment: s.status === 'PENDING' && Boolean(s.expiresAt && s.expiresAt > now && s.payment?.status === 'PENDING' && s.payment.pageUrl),
      cancelToken: s.cancelToken,
      title: s.booking.title,
      courtName: s.booking.court.name,
      trainerName: s.booking.trainer?.name ?? null,
      start: s.booking.startTime.toISOString(),
      end: s.booking.endTime.toISOString(),
      startLabel: label(s.booking.startTime),
      endLabel: label(s.booking.endTime),
      price: s.price,
      canCancel: s.status === 'BOOKED' && canCancelNow(s.booking.startTime, cutoff),
    })),
    history: [
      ...pastBookings.map((b) => ({
        id: `booking:${b.id}`,
        kind: 'court' as const,
        start: b.startTime.toISOString(),
        end: b.endTime.toISOString(),
        courtName: b.court?.name ?? 'Корт',
        trainerName: b.trainer?.name ?? null,
      })),
      ...pastSeats.map((s) => ({
        id: `seat:${s.id}`,
        kind: 'group' as const,
        start: s.booking.startTime.toISOString(),
        end: s.booking.endTime.toISOString(),
        courtName: s.booking.court?.name ?? 'Корт',
        trainerName: s.booking.trainer?.name ?? null,
      })),
    ].sort((a, b) => b.start.localeCompare(a.start)),
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
/* -------------------------------------------------------------------------- */
/* TELEGRAM І ЧЕРГА ГРАВЦЯ                                                    */
/* -------------------------------------------------------------------------- */

/** Картка гравця разом із планом клубу — для перевірок нижче */
async function customerWithClub(auth: { customerId: string; clubId: string }) {
  const customer = await prisma.customer.findUnique({
    where: { id: auth.customerId },
    select: {
      id: true,
      clubId: true,
      club: { select: { id: true, slug: true, name: true, timezone: true, leadTimeMinutes: true, plan: true } },
    },
  });
  return customer && customer.clubId === auth.clubId ? customer : null;
}

/**
 * POST /api/public/customer/telegram/link
 *
 * Посилання t.me/<бот>?start=p_<код>. Гравець відкриває його, Telegram сам
 * надсилає боту /start з кодом — нічого переписувати не треба.
 */
publicRouter.post('/customer/telegram/link', async (req, res) => {
  const auth = requireCustomerAuth(req, res);
  if (!auth) return;

  const customer = await customerWithClub(auth);
  if (!customer) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!playerTelegramReady(customer.club.plan)) {
    return res.status(503).json({ error: 'TELEGRAM_UNAVAILABLE' });
  }

  const code = await createPlayerLinkCode(customer.id);
  res.json({
    url: `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=${playerStartPayload(code)}`,
    minutes: PLAYER_LINK_MINUTES,
  });
});

/** DELETE /api/public/customer/telegram — відключити сповіщення гравця */
publicRouter.delete('/customer/telegram', async (req, res) => {
  const auth = requireCustomerAuth(req, res);
  if (!auth) return;

  const customer = await customerWithClub(auth);
  if (!customer) return res.status(404).json({ error: 'NOT_FOUND' });

  await unlinkPlayers([customer.id]);
  res.json({ ok: true });
});

const waitlistSchema = z.object({
  courtId: z.string().uuid(),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
});

const JOIN_STATUS: Record<JoinError, number> = {
  COURT_NOT_FOUND: 404,
  BAD_SLOT: 400,
  TOO_LATE: 409,
  SLOT_FREE: 409,
  ALREADY_MINE: 409,
  TELEGRAM_REQUIRED: 409,
  TELEGRAM_UNAVAILABLE: 503,
  TOO_MANY: 409,
  CUSTOMER_BLOCKED: 403,
};

/**
 * POST /api/public/clubs/:slug/waitlist  { courtId, start, end }
 *
 * Стати в чергу на зайнятий слот. Тільки з кабінету гравця й тільки з
 * підключеним Telegram — див. lib/waitlist.ts.
 */
publicRouter.post('/clubs/:slug/waitlist', async (req, res) => {
  const auth = requireCustomerAuth(req, res);
  if (!auth) return;

  const parsed = waitlistSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  const customer = await customerWithClub(auth);
  const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  if (!customer || customer.club.slug !== slug) return res.status(404).json({ error: 'NOT_FOUND' });

  const result = await joinWaitlist({
    club: customer.club,
    customerId: customer.id,
    courtId: parsed.data.courtId,
    start: new Date(parsed.data.start),
    end: new Date(parsed.data.end),
  });
  if (!result.ok) return res.status(JOIN_STATUS[result.code]).json({ error: result.code });

  res.status(201).json({ id: result.id });
});

/** DELETE /api/public/customer/waitlist/:id — вийти з черги */
publicRouter.delete('/customer/waitlist/:id', async (req, res) => {
  const auth = requireCustomerAuth(req, res);
  if (!auth) return;

  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST' });

  /* updateMany з власником у where: чужий id просто нічого не змінює, і
     відповідь не підказує, що такий запис існує. */
  await prisma.waitlistEntry.updateMany({
    where: {
      id: id.data,
      customerId: auth.customerId,
      clubId: auth.clubId,
      status: { in: ['WAITING', 'OFFERED'] },
    },
    data: { status: 'CANCELLED' },
  });
  res.json({ ok: true });
});

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
    /* Чиє це місце: токен місця або кабінет того самого клієнта. Решта —
       строк, виручка, сповіщення — спільна з кнопкою в Telegram. */
    const result = await cancelSeatByCustomer(id.data, (seat) => {
      const byToken = Boolean(body.data.token) && seat.cancelToken === body.data.token;
      const byCabinet = Boolean(auth)
        && seat.customerId === auth!.customerId
        && seat.clubId === auth!.clubId;
      return byToken || byCabinet;
    });
    if (!result.ok) return res.status(result.status).json({ error: result.code });

    res.json({ ok: true });
  } catch (e) {
    console.error('[seat cancel] failed', e);
    res.status(500).json({ error: 'INTERNAL' });
  }
});
