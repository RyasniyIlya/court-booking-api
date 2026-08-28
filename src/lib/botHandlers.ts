import { DateTime } from 'luxon';

import { prisma } from './db';
import { sendMessage, type TgUpdate } from './telegram';
import { dayDigest, digestText } from './digest';

/**
 * Що бот відповідає на команди.
 *
 * Один бот на дві ролі. Розводить їх не команда, а те, ким виявився
 * співрозмовник: власник за /today отримує цифри клубу, тренер — свої
 * заняття. Робити двох ботів означало б два токени, два налаштування у
 * BotFather і клуб, який плутає, кого куди додавати.
 *
 * Чужий чат не отримує нічого, крім пропозиції прив'язатись: доки чат не
 * звʼязаний з акаунтом, бот не знає ні клубу, ні прав, і будь-яка відповідь
 * була б витоком.
 */

const HELP = [
  'Це бот вашого клубу.',
  '',
  'Щоб підключитись, відкрийте кабінет → Налаштування → Команда,',
  'натисніть «Підключити Telegram» і надішліть сюди код, який там зʼявиться.',
].join('\n');

const OWNER_MENU = [
  '/today — броні, виручка і нові клієнти за сьогодні',
  '/help — що я вмію',
].join('\n');

const TRAINER_MENU = [
  '/today — ваші заняття на сьогодні',
  '/help — що я вмію',
].join('\n');

/** Кого ми знаємо за цим чатом */
async function userByChat(chatId: string) {
  return prisma.user.findUnique({
    where: { tgChatId: chatId },
    select: {
      id: true,
      role: true,
      trainerId: true,
      club: { select: { id: true, name: true, timezone: true } },
    },
  });
}

/**
 * Прив'язка чату до акаунта за одноразовим кодом.
 *
 * Код гаситься одразу після використання, а не лишається «поки не зміниться»:
 * інакше переслане в чаті повідомлення з кодом дало б доступ будь-кому, хто
 * його прочитав.
 */
async function linkByCode(chatId: string, code: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { tgLinkCode: code },
    select: { id: true, role: true, tgLinkUntil: true, club: { select: { name: true } } },
  });

  if (!user) {
    return 'Такого коду немає. Візьміть новий у кабінеті: Налаштування → Команда.';
  }

  if (!user.tgLinkUntil || user.tgLinkUntil < new Date()) {
    return 'Код протух. Візьміть новий у кабінеті — вони живуть 15 хвилин.';
  }

  /* Чат міг бути прив'язаний до іншої людини цього ж клубу. Відв'язуємо
     старого власника чату мовчки: unique-індекс на tgChatId інакше просто
     впаде, і людина побачить незрозумілу помилку замість підключення. */
  await prisma.user.updateMany({
    where: { tgChatId: chatId },
    data: { tgChatId: null },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { tgChatId: chatId, tgLinkCode: null, tgLinkUntil: null },
  });

  const menu = user.role === 'TRAINER' ? TRAINER_MENU : OWNER_MENU;
  return `Підключено до клубу <b>${user.club.name}</b>.\n\n${menu}`;
}

/** Заняття тренера на сьогодні */
async function trainerToday(trainerId: string, timezone: string): Promise<string> {
  const local = DateTime.now().setZone(timezone);
  const from = local.startOf('day').toUTC().toJSDate();
  const to = local.endOf('day').toUTC().toJSDate();

  const rows = await prisma.booking.findMany({
    where: {
      trainerId,
      status: { in: ['PENDING', 'CONFIRMED'] },
      startTime: { gte: from, lte: to },
    },
    orderBy: { startTime: 'asc' },
    select: {
      startTime: true,
      endTime: true,
      customerName: true,
      status: true,
      court: { select: { name: true } },
    },
  });

  if (rows.length === 0) return 'Сьогодні занять немає.';

  const lines = rows.map((b) => {
    const s = DateTime.fromJSDate(b.startTime).setZone(timezone).toFormat('HH:mm');
    const e = DateTime.fromJSDate(b.endTime).setZone(timezone).toFormat('HH:mm');
    const wait = b.status === 'PENDING' ? ' · чекає підтвердження' : '';
    return `${s}–${e} · ${b.court?.name ?? 'корт'} · ${b.customerName ?? 'без імені'}${wait}`;
  });

  return `<b>Сьогодні у вас ${rows.length}</b>\n\n${lines.join('\n')}`;
}

/**
 * Обробити одне оновлення. Викликається і з polling, і з вебхука —
 * саме тому вона тут, а не всередині транспорту.
 */
export async function handleUpdate(u: TgUpdate): Promise<void> {
  const msg = u.message;
  const text = msg?.text?.trim();
  if (!msg || !text) return;

  const chatId = String(msg.chat.id);
  const [cmdRaw, ...args] = text.split(/\s+/);
  /* У групах команди приходять як /today@my_bot — відрізаємо адресата,
     інакше в груповому чаті бот не впізнає жодної своєї ж команди. */
  const cmd = cmdRaw.split('@')[0].toLowerCase();

  /* /start із кодом — єдине, що працює до прив'язки. */
  if (cmd === '/start' && args[0]) {
    await sendMessage(chatId, await linkByCode(chatId, args[0]));
    return;
  }

  const me = await userByChat(chatId);

  if (!me) {
    /* Голий код без /start теж приймаємо: людина частіше просто вставляє
       його в чат, ніж пише команду з аргументом. */
    if (/^[A-Z0-9]{6}$/i.test(text)) {
      await sendMessage(chatId, await linkByCode(chatId, text.toUpperCase()));
      return;
    }
    await sendMessage(chatId, HELP);
    return;
  }

  const menu = me.role === 'TRAINER' ? TRAINER_MENU : OWNER_MENU;

  if (cmd === '/help' || cmd === '/start') {
    await sendMessage(chatId, `Клуб <b>${me.club.name}</b>.\n\n${menu}`);
    return;
  }

  if (cmd === '/today') {
    if (me.role === 'TRAINER') {
      if (!me.trainerId) {
        await sendMessage(chatId, 'Ваш акаунт ще не прив’язаний до картки тренера — попросіть адміністратора клубу.');
        return;
      }
      await sendMessage(chatId, await trainerToday(me.trainerId, me.club.timezone));
      return;
    }

    const d = await dayDigest(me.club.id, me.club.timezone);
    await sendMessage(chatId, digestText(me.club.name, d, me.club.timezone));
    return;
  }

  await sendMessage(chatId, `Не знаю такої команди.\n\n${menu}`);
}
