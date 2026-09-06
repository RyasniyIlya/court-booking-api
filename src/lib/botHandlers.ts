import { DateTime } from 'luxon';

import { prisma } from './db';
import {
  answerCallback,
  deleteMessage,
  editMessageText,
  sendMessage,
  setMyCommands,
  type TgUpdate,
} from './telegram';
import { dayDigest, digestText, WEEKDAY_FULL, weekReport, weekText } from './digest';
import { count, SESSIONS } from './plural';
import { loginByPassword, logout, menuFor } from './botAuth';
import { changePassword, parseNewPassword, requestReset } from './botPassword';
import {
  COMMANDS_GUEST,
  commandForLabel,
  commandsFor,
  dayButtons,
  parseAction,
  periodButtons,
  removeKeyboard,
  replyKeyboard,
} from './botKeyboard';
import { revenueBreakdown, revenueText, staffReport, staffText } from './sections';
import { botAnalytics } from './botAnalytics';

/**
 * Що бот відповідає на команди.
 *
 * Один бот на дві ролі. Розводить їх не команда, а те, ким виявився
 * співрозмовник: власник за /today отримує цифри клубу, тренер — свої
 * заняття. Робити двох ботів означало б два токени, два налаштування у
 * BotFather і клуб, який плутає, кого куди додавати.
 *
 * Чужий чат не отримує нічого, крім пропозиції увійти: доки чат не
 * звʼязаний з акаунтом, бот не знає ні клубу, ні прав, і будь-яка
 * відповідь була б витоком.
 *
 * Кнопки живуть у botKeyboard — тут тільки те, що вони роблять.
 */

const HELP = [
  '🎾 <b>Бот вашого клубу</b>',
  '',
  'Показує цифри клубу: виручку за день, за вчора і тиждень із графіком.',
  '',
  '<b>Щоб увійти</b>',
  '<code>/login пошта пароль</code>',
  '',
  '<i>Пошта і пароль — ті самі, що й у кабінеті.</i>',
  '<i>Повідомлення з паролем я видалю одразу після перевірки.</i>',
  '',
  '<b>Забули пароль?</b>',
  'Якщо цей чат уже був підключений, задайте новий: <code>/newpassword новий пароль</code>.',
  'Якщо ні — надішліть заявку: <code>/restore ваша-пошта@приклад.com</code>',
  'Ми передзвонимо і задамо новий пароль після перевірки.',
].join('\n');

type Club = { id: string; name: string; timezone: string };

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
 * Час оновлення в підвалі повідомлення.
 *
 * Не прикраса: Telegram відхиляє editMessageText, якщо текст не змінився
 * ані на символ. Без відмітки часу кнопка «🔄» на тих самих цифрах
 * поверталася б помилкою, і в лог сипалось би «message is not modified».
 */
const stamp = (timezone: string) =>
  `\n\n<i>оновлено о ${DateTime.now().setZone(timezone).toFormat('HH:mm:ss')}</i>`;

/** Зведення за день зі зсувом: 0 — сьогодні, 1 — вчора */
async function dayMessage(club: Club, offset: number, stamped = false) {
  const anchor = DateTime.now().setZone(club.timezone).minus({ days: offset });
  const d = await dayDigest(club.id, club.timezone, anchor);

  return {
    text: digestText(club.name, d, club.timezone) + (stamped ? stamp(club.timezone) : ''),
    markup: dayButtons(offset),
  };
}

/**
 * Звіт за період: тиждень, персонал або виручка.
 *
 * Одна функція на три розділи, бо різниця між ними — тільки джерело
 * тексту. Кнопки, відмітка оновлення й перемикач періоду в них спільні, і
 * розводити це по трьох майже однакових функціях означало б правити
 * кожну з них при кожній зміні розмітки.
 */
async function periodMessage(
  club: Club,
  section: 'week' | 'staff' | 'money',
  days: number,
  stamped = false,
) {
  let text: string;

  if (section === 'staff') {
    text = staffText(club.name, await staffReport(club.id, club.timezone, days), days, club.timezone);
  } else if (section === 'money') {
    text = revenueText(
      club.name,
      await revenueBreakdown(club.id, club.timezone, days),
      days,
      club.timezone,
    );
  } else {
    text = weekText(club.name, await weekReport(club.id, club.timezone, days), days);
  }

  return {
    text: text + (stamped ? stamp(club.timezone) : ''),
    markup: periodButtons(section, days),
  };
}

/**
 * Привʼязка чату одноразовим кодом із кабінету.
 *
 * Основний спосіб входу — /login поштою і паролем. Код лишається робочим
 * заради кнопки «Підключити Telegram», яка вже стоїть у кабінеті: прибрати
 * його тут означало б, що кнопка мовчки перестає працювати. У довідці бота
 * він не згадується.
 */
async function linkByCode(chatId: string, code: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { tgLinkCode: code },
    select: { id: true, role: true, tgLinkUntil: true, club: { select: { name: true } } },
  });

  if (!user) {
    return 'Такого коду немає. Увійдіть командою <code>/login пошта пароль</code>.';
  }

  if (!user.tgLinkUntil || user.tgLinkUntil < new Date()) {
    return 'Код протух — вони живуть 15 хвилин. Увійдіть командою <code>/login пошта пароль</code>.';
  }

  await prisma.user.updateMany({ where: { tgChatId: chatId }, data: { tgChatId: null } });
  await prisma.user.update({
    where: { id: user.id },
    data: { tgChatId: chatId, tgLinkCode: null, tgLinkUntil: null },
  });

  return `Підключено до клубу <b>${user.club.name}</b>.\n\n${menuFor(user.role)}`;
}

/**
 * Заняття тренера на сьогодні.
 *
 * Час — моноширинним: у списку з десяти рядків саме він працює лівою
 * колонкою, за якою ковзає око. Решта лишається звичайним текстом, бо
 * імена й назви кортів у <pre> почали б рвати рядок на телефоні.
 */
async function trainerToday(trainerId: string, timezone: string, clubName: string): Promise<string> {
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

  const head = `🎾 <b>${clubName}</b>\n<i>${WEEKDAY_FULL[local.weekday - 1]}, ${local.toFormat('dd.MM')}</i>`;

  if (rows.length === 0) return `${head}\n\nСьогодні занять немає.`;

  const lines = rows.map((b) => {
    const s = DateTime.fromJSDate(b.startTime).setZone(timezone).toFormat('HH:mm');
    const e = DateTime.fromJSDate(b.endTime).setZone(timezone).toFormat('HH:mm');
    /* Очікування підтвердження — окремим значком, а не хвостом тексту:
       у списку з десяти рядків його треба помітити, не читаючи. */
    const wait = b.status === 'PENDING' ? ' ⏳' : '';
    return `<code>${s}–${e}</code>  ${b.court?.name ?? 'корт'} · ${b.customerName ?? 'без імені'}${wait}`;
  });

  const pending = rows.filter((b) => b.status === 'PENDING').length;

  return [
    head,
    '',
    `📋 ${count(rows.length, SESSIONS)}`,
    '',
    lines.join('\n'),
    /* Формулювання без числівника у ролі підмета: «1 чекає» і «2 чекають»
       вимагали б ще однієї таблиці форм заради одного рядка. */
    pending > 0 ? `\n<i>⏳ чекають підтвердження: ${pending}</i>` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Розібрати «/login пошта пароль».
 *
 * Пароль може містити пробіли, тому все після пошти склеюємо назад: інакше
 * людина з нормальним паролем «два слова» отримала б «невірний пароль» без
 * жодного пояснення.
 */
export function parseLogin(args: string[]): { email: string; password: string } | null {
  if (args.length < 2) return null;
  const [email, ...rest] = args;
  const password = rest.join(' ');
  if (!email.includes('@') || !password) return null;
  return { email, password };
}

/**
 * Натиснута кнопка під повідомленням.
 *
 * Цифри переписуються на місці, а не приходять новим повідомленням:
 * інакше три натискання «14 днів» дали б три однакові звіти поспіль.
 */
async function handleCallback(q: NonNullable<TgUpdate['callback_query']>): Promise<void> {
  const chatId = String(q.message?.chat.id ?? q.from?.id ?? '');
  if (!chatId) return;

  const me = await userByChat(chatId);

  if (!me) {
    await answerCallback(q.id, 'Спершу увійдіть: /login пошта пароль');
    return;
  }

  const action = parseAction(q.data);
  if (!action) {
    /* Кнопка зі старого повідомлення або чужі дані. Мовчки гасимо
       годинник: пояснювати тут нічого, а падати тим більше. */
    await answerCallback(q.id);
    return;
  }

  if (me.role === 'TRAINER') {
    await answerCallback(q.id, 'Ця команда доступна власнику клубу');
    return;
  }

  const msg = action.kind === 'day'
    ? await dayMessage(me.club, action.offset, true)
    : await periodMessage(me.club, action.kind, action.days, true);

  if (q.message) {
    await editMessageText(chatId, q.message.message_id, msg.text, msg.markup);
  } else {
    await sendMessage(chatId, msg.text, msg.markup);
  }

  await answerCallback(q.id);
}

/**
 * Обробити одне оновлення. Викликається і з polling, і з вебхука —
 * саме тому вона тут, а не всередині транспорту.
 */
export async function handleUpdate(u: TgUpdate): Promise<void> {
  if (u.callback_query) {
    await handleCallback(u.callback_query);
    return;
  }

  const msg = u.message;
  const raw = msg?.text?.trim();
  if (!msg || !raw) return;

  const chatId = String(msg.chat.id);

  /* Кнопка постійної клавіатури приходить звичайним текстом — переводимо
     її в команду до розбору, щоб далі шлях був рівно один. */
  const text = commandForLabel(raw) ?? raw;

  const [cmdRaw, ...args] = text.split(/\s+/);
  /* У групах команди приходять як /today@my_bot — відрізаємо адресата,
     інакше в груповому чаті бот не впізнає жодної своєї ж команди. */
  const cmd = cmdRaw.split('@')[0].toLowerCase();

  /* Вхід. Єдина команда, що працює до привʼязки — і єдина, після якої ми
     прибираємо повідомлення: пароль не має лишитись в історії чату. */
  if (cmd === '/login') {
    await deleteMessage(chatId, msg.message_id);

    const creds = parseLogin(args);
    if (!creds) {
      await sendMessage(chatId, 'Формат: <code>/login пошта пароль</code>');
      return;
    }

    const reply = await loginByPassword(chatId, creds.email, creds.password);
    const me = await userByChat(chatId);

    if (me) {
      await setMyCommands(commandsFor(me.role), chatId);
      await sendMessage(chatId, reply, replyKeyboard(me.role));
    } else {
      await sendMessage(chatId, reply);
    }
    return;
  }

  /* Новий пароль. Стоїть поруч із /login навмисно: це друга й остання
     команда, після якої треба прибрати повідомлення, і тримати обидві
     разом надійніше, ніж згадати про видалення десь нижче по файлу.
     Привʼязку перевіряє changePassword — саме тому виклик тут іде до
     userByChat, а не після нього. */
  if (cmd === '/newpassword') {
    await deleteMessage(chatId, msg.message_id);

    const password = parseNewPassword(args);
    if (!password) {
      await sendMessage(chatId, 'Формат: <code>/newpassword новий пароль</code>');
      return;
    }

    const reply = await changePassword(chatId, password);
    const me = await userByChat(chatId);
    await sendMessage(chatId, reply, me ? replyKeyboard(me.role) : undefined);
    return;
  }

  /* Заявка на відновлення. Працює до привʼязки — це єдиний шлях для тих,
     кого /newpassword не рятує: пароль забуто, бота не підключено, і
     довести особу через Telegram неможливо. Пароль тут не приймаємо й не
     видаємо, тому й видаляти повідомлення нема чого. */
  if (cmd === '/restore') {
    if (!args[0]) {
      await sendMessage(chatId, 'Формат: <code>/restore ваша-пошта@приклад.com</code>');
      return;
    }

    /* Підпис у Telegram — єдине, за чим оператор звірить заявку з тим,
       хто телефонує. @username надійніший, імʼя людина міняє частіше. */
    const from = msg.from;
    const tgName = from?.username
      ? `@${from.username}`
      : [from?.first_name, from?.last_name].filter(Boolean).join(' ') || null;

    await sendMessage(chatId, await requestReset(chatId, args[0], tgName));
    return;
  }

  /* /start із кодом — сумісність із кнопкою кабінету. */
  if (cmd === '/start' && args[0]) {
    const reply = await linkByCode(chatId, args[0]);
    const linked = await userByChat(chatId);

    if (linked) {
      await setMyCommands(commandsFor(linked.role), chatId);
      await sendMessage(chatId, reply, replyKeyboard(linked.role));
    } else {
      await sendMessage(chatId, reply);
    }
    return;
  }

  const me = await userByChat(chatId);

  if (!me) {
    /* Голий код без /start теж приймаємо: людина частіше просто вставляє
       його в чат, ніж пише команду з аргументом. */
    if (/^[A-Z0-9]{6}$/i.test(raw)) {
      await sendMessage(chatId, await linkByCode(chatId, raw.toUpperCase()));
      return;
    }
    await sendMessage(chatId, HELP);
    return;
  }

  const keyboard = replyKeyboard(me.role);
  const menu = menuFor(me.role);

  if (cmd === '/analytics') {
    if (msg.chat.type !== 'private' || !['OWNER', 'ADMIN'].includes(me.role)) {
      await sendMessage(chatId, 'Аналітика доступна власнику та модератору лише в особистому чаті з ботом.');
      return;
    }
    const messages = await botAnalytics(me.club.id, args.join(' '));
    for (const text of messages) await sendMessage(chatId, text, keyboard);
    return;
  }

  if (cmd === '/help' || cmd === '/start') {
    await setMyCommands(commandsFor(me.role), chatId);
    await sendMessage(chatId, `Клуб <b>${me.club.name}</b>.\n\n${menu}`, keyboard);
    return;
  }

  if (cmd === '/logout') {
    await logout(chatId);
    /* Разом із чатом прибираємо і клавіатуру, і меню команд: лишити
       кнопки, які більше нічого не роблять, гірше, ніж не мати їх. */
    await setMyCommands(COMMANDS_GUEST, chatId);
    await sendMessage(
      chatId,
      'Чат відключено. Щоб повернутись — <code>/login пошта пароль</code>.',
      removeKeyboard,
    );
    return;
  }

  if (cmd === '/today') {
    if (me.role === 'TRAINER') {
      if (!me.trainerId) {
        await sendMessage(chatId, 'Ваш акаунт ще не привʼязаний до картки тренера — попросіть адміністратора клубу.', keyboard);
        return;
      }
      await sendMessage(
        chatId,
        await trainerToday(me.trainerId, me.club.timezone, me.club.name),
        keyboard,
      );
      return;
    }

    const m = await dayMessage(me.club, 0);
    await sendMessage(chatId, m.text, m.markup);
    return;
  }

  /* Гроші клубу — не тренерська справа. Виручка і тижнева динаміка в
     кабінеті теж закриті від ролі TRAINER, і бот не має бути обхідним
     шляхом до того, чого людина не бачить на екрані. */
  if (cmd === '/yesterday' || cmd === '/week' || cmd === '/staff' || cmd === '/revenue') {
    if (me.role === 'TRAINER') {
      await sendMessage(chatId, `Ця команда доступна власнику клубу.\n\n${menu}`, keyboard);
      return;
    }

    if (cmd === '/yesterday') {
      const m = await dayMessage(me.club, 1);
      await sendMessage(chatId, m.text, m.markup);
      return;
    }

    /* Розділи відкриваються тижнем: найкоротший період відповідає на
       «що зараз», а довші вмикаються кнопкою під самим звітом. */
    const section = cmd === '/staff' ? 'staff' : cmd === '/revenue' ? 'money' : 'week';
    const m = await periodMessage(me.club, section, 7);
    await sendMessage(chatId, m.text, m.markup);
    return;
  }

  await sendMessage(chatId, `Не знаю такої команди.\n\n${menu}`, keyboard);
}
