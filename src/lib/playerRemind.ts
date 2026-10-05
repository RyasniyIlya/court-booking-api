import { withSendSummary } from './telegramSafety';
import { prisma } from './db';
import { planFeatures } from './plans';
import { botReady, sendReminderMessage } from './telegram';
import { runWaitlistTick } from './waitlist';
import { runTrainerRatingTick } from './trainerRatingBot';
import { loadPlayerItem, playerCardKeyboard, playerCardText, type PlayerItemKind } from './playerBot';

/**
 * Нагадування гравцю за 3 години до гри — з кнопками «Прийду / Скасувати».
 *
 * ── Навіщо саме за три години ───────────────────────────────────────────
 *
 * Нагадування тут не для того, щоб людина не забула, а щоб звільнений час
 * ще встиг комусь дістатись. За пʼятнадцять хвилин скасування нікому не
 * допоможе, за добу — половина планів ще не складена. Три години — коли
 * вечір уже зрозумілий, а черга (lib/waitlist.ts) ще встигає спрацювати.
 *
 * ── Чому мітка в базі, а не в памʼяті ───────────────────────────────────
 *
 * Нагадування персоналу тримає «вже надіслано» в Map і погоджується на
 * рідкий дубль після рестарту. Гравцю дубль — це спам від клубу, тому тут
 * коротка оренда спроби, а playerRemindedAt ставиться після відправки.
 * Зависла спроба звільняється через дві хвилини. Після невизначеного
 * мережевого результату можливий повтор: абсолютної exactly-once доставки немає.
 */

export const PLAYER_REMIND_MINUTES = 180;

/**
 * Свіжі броні не нагадуємо одразу: людина, яка записалась за годину до
 * гри, щойно бачила підтвердження, і «Ви прийдете?» через хвилину
 * читається як збій.
 */
const FRESH_MINUTES = 30;

const BATCH = 100;

export const runPlayerReminderTick = (now?: Date) => withSendSummary('player-reminder', () => runPlayerReminderTickInner(now));
async function runPlayerReminderTickInner(now: Date = new Date()): Promise<number> {
  const to = new Date(now.getTime() + PLAYER_REMIND_MINUTES * 60_000);
  const freshEdge = new Date(now.getTime() - FRESH_MINUTES * 60_000);
  const withTelegram = { telegramChatId: { not: null } };

  const [bookings, seats] = await Promise.all([
    prisma.booking.findMany({
      where: {
        capacity: null,
        /* Тільки підтверджені. PENDING — або чекає оплати (і може протухнути
           за 15 хвилин), або чекає клуб; «Ви прийдете?» на бронь, яку клуб
           ще не прийняв, — запитання не до гравця. */
        status: 'CONFIRMED',
        playerRemindedAt: null,
        startTime: { gt: now, lte: to },
        createdAt: { lte: freshEdge },
        customer: withTelegram,
      },
      select: { id: true, club: { select: { plan: true } } },
      take: BATCH,
    }),
    prisma.bookingSeat.findMany({
      where: {
        status: 'BOOKED',
        playerRemindedAt: null,
        createdAt: { lte: freshEdge },
        customer: withTelegram,
        booking: { status: 'CONFIRMED', startTime: { gt: now, lte: to } },
      },
      select: { id: true, booking: { select: { club: { select: { plan: true } } } } },
      take: BATCH,
    }),
  ]);

  const queue: { kind: PlayerItemKind; id: string }[] = [
    ...bookings.filter((b) => planFeatures(b.club.plan).telegram).map((b) => ({ kind: 'b' as const, id: b.id })),
    ...seats.filter((s) => planFeatures(s.booking.club.plan).telegram).map((s) => ({ kind: 's' as const, id: s.id })),
  ];

  let delivered = 0;

  for (const { kind, id } of queue) {
    const leaseUntil = new Date(now.getTime() + 120_000);
    const where = { id, playerRemindedAt: null, OR: [{ playerReminderLeaseUntil: null }, { playerReminderLeaseUntil: { lt: now } }] };
    const claim = kind === 'b'
      ? await prisma.booking.updateMany({ where, data: { playerReminderLeaseUntil: leaseUntil } })
      : await prisma.bookingSeat.updateMany({ where, data: { playerReminderLeaseUntil: leaseUntil } });
    if (claim.count === 0) continue;

    const item = await loadPlayerItem(kind, id);
    if (!item?.chatId || !item.active) continue;

    /* Гравець уже натиснув «Прийду» під /my — питати ще раз нема чого,
       але картка з кнопкою скасування все одно корисна. */
    const state = item.confirmedAt ? 'confirmed' : 'remind';

    try {
      const result = await sendReminderMessage(item.chatId, playerCardText(item, state, now), playerCardKeyboard(item, state));
      const finish = { where: { id, playerReminderLeaseUntil: leaseUntil }, data: {
        playerReminderLeaseUntil: null, ...(result === 'retry' ? {} : { playerRemindedAt: now }),
      } };
      if (kind === 'b') await prisma.booking.updateMany(finish);
      else await prisma.bookingSeat.updateMany(finish);
      if (result === 'sent') delivered += 1;
      if (result === 'permanent') console.warn('[player-remind] delivery unavailable', kind, id);
    } catch (e) {
      /* A crashed attempt is retried once its short lease expires. */
      console.error('[player-remind] failed; lease will expire', kind, id);
    }
  }

  return delivered;
}

/* ── Планувальник гравцевих сповіщень ───────────────────────────────────── */

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Чи крутити гравцевий тік у цьому процесі.
 *
 * Локальний API ходить у ту саму базу й тим самим токеном бота, що й прод.
 * Якби тік працював і тут, ноутбук розробника забирав би мітку «нагадано»
 * раніше за прод і слав би гравцям повідомлення без кнопки «Забронювати»
 * (у локальному .env немає PUBLIC_WEB_URL) — а прод цю бронь уже пропустив
 * би. Тому поза production тік вимкнений, доки його не попросили явно.
 * На відміну від нагадувань персоналу, тут адресати — клієнти клубу.
 */
export function playerSchedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PLAYER_SCHEDULER === 'off') return false;
  return env.NODE_ENV === 'production' || env.PLAYER_SCHEDULER === 'on';
}

/**
 * Нагадування і черга — один тік раз на хвилину.
 *
 * Без токена бота не запускається зовсім: інакше тік ставив би мітку
 * «нагадано» на броні, а sendMessage мовчки нічого б не відправляв — і після
 * того, як токен зʼявиться, цим броням нагадування вже не прийшло б.
 *
 * `running` — щоб повільна база не накладала тік на тік: другий прохід по
 * тих самих чергах одночасно з першим — рівно та гонка, від якої захищають
 * умовні updateMany, і зайвий раз її будити не варто.
 */
export function startPlayerScheduler() {
  if (timer) return;
  if (!playerSchedulerEnabled()) {
    console.log('[player] нагадування гравцям і черга вимкнені поза production (PLAYER_SCHEDULER=on — увімкнути)');
    return;
  }
  if (!botReady()) {
    console.log('[player] TELEGRAM_BOT_TOKEN не заданий — нагадування гравцям і черга вимкнені');
    return;
  }

  timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        await runPlayerReminderTick();
        /* Окремо: збій запиту оцінок не повинен зупинити чергу. */
        try {
          await runTrainerRatingTick();
        } catch (e) {
          console.error('[player] тік оцінок тренера упав', e);
        }
        await runWaitlistTick();
      } catch (e) {
        console.error('[player] тік упав', e);
      } finally {
        running = false;
      }
    })();
  }, 60_000);
  timer.unref?.();

  console.log(`[player] нагадування гравцям за ${PLAYER_REMIND_MINUTES} хв, запит оцінки тренера і черга увімкнені`);
}
