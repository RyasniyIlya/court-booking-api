import { DateTime } from 'luxon';
import { telegramHtml as html } from './telegramHtml';

import { prisma } from './db';
import { planFeatures } from './plans';
import { sendMessage } from './telegram';

/**
 * Сповіщення про рух у розкладі: бронь зʼявилась, оплатилась, зникла.
 *
 * ── Навіщо один модуль замість sendMessage по місцях ─────────────────────
 *
 * Подія «нова бронь» народжується в пʼяти різних місцях: віджет без
 * передоплати, вебхук банку після оплати, запис у групу, оплата місця в
 * групі, кабінет. Доки кожне з них слало повідомлення саме, розʼїхалось
 * усе, що могло: тренера кликали лише з двох шляхів — передоплачена бронь
 * не кликала його НІКОЛИ, бо гілка з платіжкою робить return до блоку
 * сповіщень; запис у групу не бачив ніхто; скасування мовчало всюди, і
 * тренер приїздив на заняття, якого вже не було.
 *
 * Тому маршрутизація тут одна на всіх, а місця виклику знають рівно два
 * факти: що сталось і з якою бронню.
 *
 * ── Чому модуль сам ходить у базу ───────────────────────────────────────
 *
 * Викликати його можна було б і з готовими полями, але тоді кожне з пʼяти
 * місць мусило б зібрати однаковий набір (клуб, корт, тренер, таймзона) —
 * а вони й так збирали його по-різному, через що повідомлення виходили
 * несхожими одне на одне. Зайвий запит нікого не затримує: усі виклики
 * ідуть через `void` і не стоять на шляху відповіді гравцю.
 *
 * ── Кому що видно ───────────────────────────────────────────────────────
 *
 * Клубна група і особисті чати власника з модератором отримують повну
 * картку: імʼя, телефон, гроші. Тренер — тільки своє заняття, без сум:
 * виручка клубу не його справа, і в кабінеті вона від ролі TRAINER так
 * само закрита. Бот не має бути обхідним шляхом до того, чого людина не
 * бачить на екрані.
 */

export type BookingEvent = 'created' | 'paid' | 'cancelled' | 'updated';

type Params = {
  bookingId: string;
  /** Місце в груповому занятті. null — подія про саму бронь корту. */
  seatId?: string | null;
  event: BookingEvent;
  /**
   * Хто натиснув. Себе не повідомляємо: людина щойно зробила це руками, і
   * підтвердження власної дії в особистому чаті — шум, а не користь.
   */
  actorUserId?: string | null;
  /**
   * Не слати в спільну групу клубу. Ставиться на дії з кабінету: група
   * існує, щоб клуб дізнавався про те, чого не робив сам.
   */
  skipClubChat?: boolean;
};

const HEAD: Record<BookingEvent, { club: string; trainer: string }> = {
  updated: { club: '↪️ <b>Бронь перенесено</b>', trainer: '↪️ <b>Заняття перенесено</b>' },
  created: { club: '🆕 <b>Нова бронь</b>', trainer: '🆕 <b>Вас записали на заняття</b>' },
  paid: { club: '✅ <b>Оплачено бронь</b>', trainer: '🆕 <b>Вас записали на заняття</b>' },
  cancelled: { club: '❌ <b>Бронь скасовано</b>', trainer: '❌ <b>Заняття скасовано</b>' },
};

const SEAT_HEAD: Record<BookingEvent, { club: string; trainer: string }> = {
  updated: { club: '↪️ <b>Запис перенесено</b>', trainer: '↪️ <b>Запис перенесено</b>' },
  created: { club: '🆕 <b>Новий запис у заняття</b>', trainer: '🆕 <b>Новий учасник</b>' },
  paid: { club: '✅ <b>Оплачено місце</b>', trainer: '🆕 <b>Новий учасник</b>' },
  cancelled: { club: '❌ <b>Запис знято</b>', trainer: '❌ <b>Учасник знявся</b>' },
};

/** HTML-розмітку Telegram ставимо ми, а не імена клієнтів. */

const hrn = (kop: number) => `${(kop / 100).toFixed(2)} грн`;

function when(start: Date, end: Date, tz: string) {
  const from = DateTime.fromJSDate(start).setZone(tz).toFormat('dd.MM HH:mm');
  const to = DateTime.fromJSDate(end).setZone(tz).toFormat('HH:mm');
  return `${from}–${to}`;
}

export async function notifyBooking(params: Params): Promise<void> {
  const { bookingId, seatId = null, event, actorUserId = null, skipClubChat = false } = params;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      title: true,
      startTime: true,
      endTime: true,
      priceTotal: true,
      promoNames: true,
      promoDiscount: true,
      customerName: true,
      customerPhone: true,
      customer: { select: { telegramChatId: true } },
      trainerId: true,
      court: { select: { name: true } },
      trainer: { select: { name: true } },
      club: { select: { id: true, plan: true, timezone: true, telegramChatId: true } },
    },
  });
  if (!booking) return;

  /* Telegram — можливість максимального пакета. Перевірка тут, а не в
     кожному місці виклику: інакше клуб на молодшому тарифі отримував би
     повідомлення рівно з тих шляхів, де про неї забули. */
  const { club } = booking;
  if (!planFeatures(club.plan).telegram) return;
  if (event === 'updated' && booking.customer?.telegramChatId) {
    await sendMessage(booking.customer.telegramChatId,
      `↪️ <b>Бронь перенесено</b>\n\n${when(booking.startTime, booking.endTime, club.timezone)}\n${html(booking.court.name)}\n/my — ваші записи`);
  }

  const seat = seatId
    ? await prisma.bookingSeat.findUnique({
      where: { id: seatId },
      select: { customerName: true, customerPhone: true, price: true },
    })
    : null;
  /* Місце вказали, а його немає — слати «новий запис» без учасника
     означало б повідомити ні про що. */
  if (seatId && !seat) return;

  const tz = club.timezone;
  const head = seat ? SEAT_HEAD[event] : HEAD[event];
  const what = seat
    ? `${booking.title ?? 'Заняття'} · ${booking.court.name}`
    : booking.court.name;

  const who = seat
    ? { name: seat.customerName, phone: seat.customerPhone }
    : { name: booking.customerName, phone: booking.customerPhone };
  const money = seat ? seat.price : booking.priceTotal;

  /* Повна картка — тим, хто веде клуб. Телефон у ній головне: саме за ним
     передзвонюють, коли з бронню щось не так. */
  const forClub = [
    head.club,
    '',
    when(booking.startTime, booking.endTime, tz),
    html(what),
    booking.trainer ? `Тренер: ${html(booking.trainer.name)}` : '',
    who.name ? `Клієнт: ${html(who.name)}` : '',
    who.phone ? `Телефон: ${html(who.phone)}` : '',
    !seat && booking.promoNames.length > 0
      ? `🏷 Акція: ${booking.promoNames.map(html).join(', ')}${booking.promoDiscount > 0 ? ` · знижка ${hrn(booking.promoDiscount)}` : ''}`
      : '',
    money > 0 ? hrn(money) : '',
  ].filter(Boolean).join('\n');

  /* Те саме без грошей — тренеру. */
  const forTrainer = [
    head.trainer,
    '',
    when(booking.startTime, booking.endTime, tz),
    html(what),
    who.name ? `Клієнт: ${html(who.name)}` : '',
    who.phone ? `Телефон: ${html(who.phone)}` : '',
  ].filter(Boolean).join('\n');

  await deliver({
    clubId: club.id,
    clubChatId: skipClubChat ? null : club.telegramChatId,
    trainerId: booking.trainerId,
    actorUserId,
    forClub,
    forTrainer,
  });
}

/**
 * Скасування серії одним повідомленням.
 *
 * Окремо від notifyBooking навмисно. Серія — це до кількох десятків
 * однакових занять, і виклик notifyBooking у циклі означав би двадцять
 * повідомлень поспіль кожному тренеру: формально правда, практично —
 * чат, у якому більше нічого не видно. Тут та сама розсилка, але текст
 * один на всю серію.
 */
export async function notifySeriesCancelled(params: {
  clubId: string;
  /** Скасовані заняття: досить id тренера й часу першого з них. */
  bookings: { trainerId: string | null; startTime: Date; courtName: string }[];
  actorUserId?: string | null;
}): Promise<void> {
  const { clubId, bookings, actorUserId = null } = params;
  if (bookings.length === 0) return;

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { plan: true, timezone: true, telegramChatId: true },
  });
  if (!club || !planFeatures(club.plan).telegram) return;

  /* По тренеру окремо: кожен має побачити СВОЇ зняті заняття, а не
     загальне число по клубу, з якого його частка невідома. */
  const byTrainer = new Map<string | null, typeof bookings>();
  for (const b of bookings) {
    byTrainer.set(b.trainerId, [...(byTrainer.get(b.trainerId) ?? []), b]);
  }

  const text = (rows: typeof bookings, head: string) => {
    const first = rows.reduce((a, b) => (a.startTime < b.startTime ? a : b));
    return [
      head,
      '',
      `Знято занять: <b>${rows.length}</b>`,
      `Найближче: ${DateTime.fromJSDate(first.startTime).setZone(club.timezone).toFormat('dd.MM HH:mm')}`,
      html(first.courtName),
    ].join('\n');
  };

  /* Клубна група бачить серію цілком — це одна дія клубу, а не сума
     чужих занять. Персоналу воно ж піде в особисті чати. */
  await deliver({
    clubId,
    clubChatId: club.telegramChatId,
    trainerId: null,
    actorUserId,
    forClub: text(bookings, '❌ <b>Серію занять скасовано</b>'),
    forTrainer: '',
  });

  for (const [trainerId, rows] of byTrainer) {
    if (!trainerId) continue;
    await deliver({
      clubId,
      /* Групі вже сказали рядком вище, і персоналу теж: тут лишається
         рівно тренер, чиї це заняття. */
      clubChatId: null,
      trainerId,
      actorUserId,
      staffToo: false,
      forClub: '',
      forTrainer: text(rows, '❌ <b>Ваші заняття скасовано</b>'),
    });
  }
}

/**
 * Кому насправді йде повідомлення.
 *
 * Єдине місце, де вирішується видимість, — саме тому воно тут, а не в
 * кожній з функцій вище: варіантів отримувача три (спільна група, персонал
 * особисто, тренер особисто), і розводити їх по двох майже однакових
 * копіях означало б правити обидві при кожній зміні правил.
 */
async function deliver(params: {
  clubId: string;
  clubChatId: string | null;
  trainerId: string | null;
  actorUserId: string | null;
  forClub: string;
  forTrainer: string;
  /** false — персонал не чіпаємо, повідомлення тільки для тренера. */
  staffToo?: boolean;
}): Promise<void> {
  const {
    clubId, clubChatId, trainerId, actorUserId, forClub, forTrainer, staffToo = true,
  } = params;

  /* Одним запитом і персонал, і тренер: це той самий User, різниця лише в
     тому, за яким полем ми його знайшли. */
  const or = [
    ...(staffToo ? [{ role: { in: ['OWNER' as const, 'ADMIN' as const] } }] : []),
    ...(trainerId ? [{ trainerId }] : []),
  ];

  const people = or.length === 0 ? [] : await prisma.user.findMany({
    where: {
      clubId,
      tgChatId: { not: null },
      tgNotifyBookings: true,
      ...(actorUserId ? { id: { not: actorUserId } } : {}),
      OR: or,
    },
    select: { tgChatId: true, role: true },
  });

  /* Один чат — одне повідомлення. Власник, який сам стоїть у розкладі
     тренером, підпадає під обидві гілки OR; без збірки в Map він отримав
     би ту саму бронь двічі — повну й урізану. */
  const targets = new Map<string, string>();

  if (clubChatId && forClub) targets.set(clubChatId, forClub);

  for (const p of people) {
    const chatId = p.tgChatId!;
    const staff = p.role === 'OWNER' || p.role === 'ADMIN';
    const text = staff ? forClub : forTrainer;
    if (!text) continue;
    /* Повна картка перемагає: якщо людина має право бачити гроші, ховати
       їх через те, що вона ще й тренер цього заняття, немає підстав. */
    if (staff || !targets.has(chatId)) targets.set(chatId, text);
  }

  /* Послідовно, а не Promise.all: Telegram обмежує близько 30 повідомлень
     на секунду, і залп на великому клубі почав би ловити 429. Черга тут
     коротка — стільки, скільки людей у клубі підключили бота. */
  for (const [chatId, text] of targets) {
    try {
      await sendMessage(chatId, text);
    } catch (e) {
      /* Один недоступний чат (людина заблокувала бота) не має ховати
         повідомлення від решти — і тим більше валити бронь. */
      console.error('[notifyBooking] send failed', chatId, e);
    }
  }
}
