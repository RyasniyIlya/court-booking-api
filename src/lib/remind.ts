import { DateTime } from 'luxon';

import { prisma } from './db';
import { planFeatures } from './plans';
import { sendMessage } from './telegram';
import { isTournament } from './tournamentPay';
import { LEAD_OPTIONS } from './botSettings';

/**
 * Нагадування за чверть години до початку.
 *
 * ── Навіщо ──────────────────────────────────────────────────────────────
 *
 * Розклад є і в кабінеті, і в /today. Чого ніде немає — поштовху в той
 * момент, коли пора виходити на корт. Тренер дивиться розклад уранці, а о
 * 17:45 він зайнятий попереднім заняттям; адміністратор бачить турнір у
 * сітці весь тиждень і згадує про нього за пʼять хвилин до початку.
 *
 * ── Кому що ─────────────────────────────────────────────────────────────
 *
 * Тренеру — його власні заняття, будь-які. Власнику й модератору —
 * турніри й групові, але НЕ кожна приватна бронь: у клубі з десятьма
 * кортами це сорок повідомлень на день, після яких вимикають бота цілком,
 * разом із тим, що справді потрібне.
 *
 * ── Чому в кожного свій інтервал ────────────────────────────────────────
 *
 * Адміністратор за годину встигає підготувати зал і зустріти людей.
 * Тренеру за годину нагадувати рано — він ще на попередньому занятті, і
 * повідомлення загубиться. Спільне число влаштовувало б когось одного.
 *
 * Тому вікно тут ширше за будь-який інтервал (максимум зі списку), а
 * рішення «пора чи ні» ухвалюється по кожній людині окремо.
 */

/** Раз на хвилину: інтервали кратні пʼяти, точніше не треба. */
const TICK_MS = 60_000;

/** Найдовший інтервал зі списку — ширина вікна вибірки з бази. */
const MAX_LEAD = Math.max(...LEAD_OPTIONS);

/**
 * Кому вже нагадали: `${userId}:${bookingId}` -> час початку заняття.
 *
 * У памʼяті, а не в базі — тим самим рішенням, що й у digestScheduler:
 * таблиця заради даних, які живуть годину, коштувала б міграцію і
 * прибирання. Ціна — рестарт процесу в останні хвилини перед заняттям
 * може продублювати одне повідомлення. Дублікат тут нешкідливий, пропуск
 * — ні, тому вибір саме такий.
 *
 * Значення (час початку) потрібне, щоб прибирати минуле: без нього набір
 * ріс би весь час роботи процесу.
 */
const sent = new Map<string, number>();

let timer: NodeJS.Timeout | null = null;

/** Тільки для тестів: чистий старт між кейсами. */
export function resetReminders() {
  sent.clear();
}

const hhmm = (d: Date, tz: string) => DateTime.fromJSDate(d).setZone(tz).toFormat('HH:mm');

type Kind = 'tournament' | 'group' | 'private';

const kindOf = (b: { capacity: number | null; title: string | null }): Kind => {
  if (b.capacity == null) return 'private';
  return isTournament(b) ? 'tournament' : 'group';
};

/**
 * Який вимикач відповідає за цю подію для персоналу.
 *
 * Приватна бронь не має свого: персоналу про неї не нагадують узагалі.
 */
const STAFF_FLAG = {
  tournament: 'tgNotifyTournaments',
  group: 'tgNotifyGroups',
  private: null,
} as const;

function textFor(
  b: { title: string | null; startTime: Date; endTime: Date; capacity: number | null;
    court: { name: string }; customerName: string | null; seats: number },
  kind: Kind,
  tz: string,
  mine: boolean,
): string {
  const time = `${hhmm(b.startTime, tz)}–${hhmm(b.endTime, tz)}`;
  const head = mine
    ? '⏰ <b>Скоро ваше заняття</b>'
    : kind === 'tournament' ? '⏰ <b>Скоро турнір</b>' : '⏰ <b>Скоро групове заняття</b>';

  const lines = [head, '', time, b.court.name];

  if (kind === 'private') {
    if (b.customerName) lines.push(b.customerName);
  } else {
    if (b.title) lines.push(b.title);
    /* Скільки людей прийде — головне число перед груповим: під нього
       готують інвентар і рахують мʼячі. */
    lines.push(`Учасників: ${b.seats}${b.capacity ? ` з ${b.capacity}` : ''}`);
  }

  return lines.join('\n');
}

/**
 * Один прохід. Винесено з інтервалу, щоб тест міг покликати напряму —
 * той самий прийом, що в digestScheduler.
 */
export async function runReminderTick(now: Date = new Date()): Promise<number> {
  const from = now;
  const to = new Date(now.getTime() + MAX_LEAD * 60_000);

  /* Тільки те, що ще відбудеться і не скасоване. EXPIRED і CANCELLED сюди
     не потрапляють: нагадувати про заняття, якого немає, — рівно та
     помилка, проти якої все це й робилось. */
  const upcoming = await prisma.booking.findMany({
    where: {
      status: { in: ['PENDING', 'CONFIRMED'] },
      startTime: { gt: from, lte: to },
    },
    select: {
      id: true,
      title: true,
      capacity: true,
      startTime: true,
      endTime: true,
      customerName: true,
      trainerId: true,
      clubId: true,
      court: { select: { name: true } },
      club: { select: { plan: true, timezone: true } },
      _count: { select: { seats: { where: { status: 'BOOKED' } } } },
    },
  });

  if (upcoming.length === 0) return 0;

  /* Один запит на всіх, а не на кожну бронь: клубів у вибірці небагато, а
     людей у клубі одиниці. */
  const people = await prisma.user.findMany({
    where: {
      clubId: { in: [...new Set(upcoming.map((b) => b.clubId))] },
      tgChatId: { not: null },
    },
    select: {
      id: true,
      clubId: true,
      role: true,
      trainerId: true,
      tgChatId: true,
      tgNotifyTournaments: true,
      tgNotifyGroups: true,
      tgNotifySessions: true,
      tgRemindMinutes: true,
    },
  });

  let delivered = 0;

  for (const b of upcoming) {
    if (!planFeatures(b.club.plan).telegram) continue;

    const kind = kindOf(b);
    const minutesLeft = (b.startTime.getTime() - now.getTime()) / 60_000;

    for (const p of people) {
      if (p.clubId !== b.clubId) continue;

      /* Своє заняття — у тренера, прив'язаного до картки. Для всіх інших
         подія «чужа», навіть якщо людина сама OWNER. */
      const mine = Boolean(p.trainerId) && p.trainerId === b.trainerId;
      const staff = p.role === 'OWNER' || p.role === 'ADMIN';

      let wanted: boolean;
      if (mine) {
        wanted = p.tgNotifySessions;
      } else if (staff) {
        const flag = STAFF_FLAG[kind];
        wanted = flag ? p[flag] : false;
      } else {
        /* Тренер, якого це заняття не стосується, не отримує нічого:
           чужий розклад — не його справа. */
        wanted = false;
      }
      if (!wanted) continue;

      /* Пора саме цій людині. Умова «<=», а не «рівно»: якщо тік
         пропустили (рестарт, завислий запит), нагадування прийде з
         запізненням — це краще, ніж не прийти зовсім. Від повторів
         захищає `sent`, а не точність попадання у хвилину. */
      if (minutesLeft > p.tgRemindMinutes) continue;

      const key = `${p.id}:${b.id}`;
      if (sent.has(key)) continue;
      sent.set(key, b.startTime.getTime());

      try {
        await sendMessage(
          p.tgChatId!,
          textFor({ ...b, seats: b._count.seats }, kind, b.club.timezone, mine),
        );
        delivered += 1;
      } catch (e) {
        /* Один недоступний чат не має ламати розсилку решті. Ключ уже
           стоїть: повторна спроба в наступний тік дала б те саме
           падіння, а не порятунок. */
        console.error('[remind] не вдалось надіслати', p.id, e);
      }
    }
  }

  /* Минуле більше не знадобиться: те саме заняття у вибірку не повернеться. */
  for (const [key, startedAt] of sent) {
    if (startedAt < now.getTime()) sent.delete(key);
  }

  return delivered;
}

export function startReminderScheduler() {
  if (timer) return;

  timer = setInterval(() => {
    void runReminderTick().catch((e) => console.error('[remind] тік упав', e));
  }, TICK_MS);

  /* unref: інтервал не має тримати процес живим сам по собі — інакше
     локальний запуск не завершиться по Ctrl+C з першого разу. */
  timer.unref?.();

  console.log(`[remind] нагадування увімкнено, вікно до ${MAX_LEAD} хв`);
}

export function stopReminderScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  sent.clear();
}
