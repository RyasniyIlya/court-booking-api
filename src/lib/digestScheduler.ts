import { DateTime } from 'luxon';

import { prisma } from './db';
import { sendMessage } from './telegram';
import { dayDigest, digestText, weekReport, weekText } from './digest';

/**
 * Щоденне зведення власнику — саме воно робить бота корисним.
 *
 * Команда /today відповідає, коли її спитали; більшість власників не
 * питає. Тому цифри приходять самі: увечері за день, а в понеділок ще й
 * за минулий тиждень із графіком.
 *
 * Година — в ТАЙМЗОНІ КЛУБУ, а не сервера. На Render процес живе в UTC, і
 * «о 21:00» без зони означало б для київського клубу опівночі, тобто
 * зведення вже наступної доби — з нулями.
 *
 * Без cron і без черг: один setInterval у тому ж процесі, що й бот. Черга
 * задач тут — окремий сервіс заради одного повідомлення на клуб на добу.
 */

/** Як часто перевіряємо, чи комусь пора. Чверть години — і не мажемо повз
    годину в зонах із півгодинним зсувом (Індія, Непал). */
const TICK_MS = 15 * 60_000;

/** О котрій за місцевим часом клубу */
const hour = () => Number(process.env.DIGEST_HOUR ?? 21);

/**
 * Кому вже слали сьогодні: `${userId}:${локальна дата}`.
 *
 * У памʼяті, а не в базі: колонка «останнє зведення» коштувала б міграцію
 * заради даних, що живуть добу. Ціна — рестарт у ту саму чверть години
 * може продублювати повідомлення; рестарт у будь-яку іншу чверть години
 * не робить нічого, бо вікно відправки вже минуло.
 */
const sent = new Set<string>();

let timer: NodeJS.Timeout | null = null;

/**
 * Кому взагалі йде зведення.
 *
 * Тільки OWNER і ADMIN: у тренера в кабінеті виручки клубу немає, і бот не
 * має ставати обхідним шляхом до неї. Тренерські /today лишаються на
 * запит — розкладом його ніхто не питав завалювати.
 */
async function recipients() {
  return prisma.user.findMany({
    where: { tgChatId: { not: null }, role: { in: ['OWNER', 'ADMIN'] } },
    select: {
      id: true,
      tgChatId: true,
      club: { select: { id: true, name: true, timezone: true } },
    },
  });
}

/** Один прохід. Винесено з інтервалу, щоб тест міг покликати напряму. */
export async function runDigestTick(now: DateTime = DateTime.now()): Promise<number> {
  const target = hour();
  const people = await recipients();
  let delivered = 0;

  for (const p of people) {
    if (!p.tgChatId) continue;

    const local = now.setZone(p.club.timezone);

    /* Вікно — перша чверть години після цільової. Ширше означало б
       чотири зведення поспіль, вужче — пропуск, якщо тік трохи поплив. */
    if (local.hour !== target || local.minute >= 15) continue;

    const key = `${p.id}:${local.toFormat('yyyy-MM-dd')}`;
    if (sent.has(key)) continue;
    sent.add(key);

    try {
      const d = await dayDigest(p.club.id, p.club.timezone, local);
      await sendMessage(p.tgChatId, digestText(p.club.name, d, p.club.timezone));

      /* Понеділок — ще й тиждень, що закінчився вчора. Тижневий звіт у
         неділю ввечері приходив би тоді, коли клуб ще працює. */
      if (local.weekday === 1) {
        const r = await weekReport(p.club.id, p.club.timezone, 7, local.minus({ days: 1 }));
        await sendMessage(p.tgChatId, weekText(p.club.name, r));
      }

      delivered += 1;
    } catch (e) {
      /* Один клуб не має ламати розсилку решті. Ключ уже стоїть — повторна
         спроба в наступний тік дала б те саме падіння, а не порятунок. */
      console.error('[digest] не вдалось надіслати', p.club.id, e);
    }
  }

  /* Набір не має рости вічно: лишаємо тільки сьогоднішні ключі. */
  if (sent.size > people.length * 2) {
    const today = now.toFormat('yyyy-MM-dd');
    for (const key of sent) {
      if (!key.endsWith(today)) sent.delete(key);
    }
  }

  return delivered;
}

export function startDigestScheduler() {
  if (timer) return;

  timer = setInterval(() => {
    void runDigestTick().catch((e) => console.error('[digest] тік упав', e));
  }, TICK_MS);

  /* unref: інтервал не має тримати процес живим сам по собі — інакше
     локальний запуск не завершиться по Ctrl+C з першого разу. */
  timer.unref?.();

  console.log(`[digest] щоденне зведення о ${hour()}:00 за часом клубу`);
}

export function stopDigestScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  sent.clear();
}
