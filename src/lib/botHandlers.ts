import { planFeatures, telegramAnalytics } from './plans';
import { DateTime } from 'luxon';
import { telegramHtml } from './telegramHtml';

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
import {
  canToggle,
  parseSettingsAction,
  settingsKeyboard,
  settingsText,
} from './botSettings';
import { clubChoiceKeyboard, slugFromStartPayload } from './botBooking';
import { codeFromStartPayload, handlePlayerCallback, handlePlayerCommand, sendPrivacyNoticeOnce } from './playerBot';
import {
  handlePlayerLoginMessage,
  loginSlugFromStartPayload,
  playerLoginButtonFor,
  playerLoginClubChoice,
  startLinkByCode,
  startPlayerLogin,
} from './playerLogin';
import { handleHomeCallback, loadClubHome, sendClubHome, sendOwnClubHome } from './playerHome';
import { handleAiCallback } from './aiTelegram';
import { handlePlayerAiText, handleStaffAiText, UNKNOWN_HINT } from './botAi';
import { resetContext } from './ai/chatContext';

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
  '<b>Для гравця</b>',
  'Натисніть /book, оберіть клуб і відкрийте його розклад.',
  'Якщо ви підключили Telegram у профілі — бот одразу відкриває ваш клуб: акції, тренери на зміні, запис.',
  'Якщо клуб надіслав своє посилання на бота — вибирати клуб повторно не потрібно.',
  'Створіть профіль на сайті клубу. Тут натисніть «Увійти в профіль» — введіть телефон і пароль із сайту.',
  'Нагадування про ігри: профіль гравця на сторінці клубу → «Підключити Telegram».',
  '/my — ваші записи, /stop — вимкнути сповіщення гравця.',
  '',
  '<b>Для команди клубу</b>',
  'Після входу бот показує броні, виручку та робочі звіти.',
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

async function bookingClub(slug: string) {
  return prisma.club.findFirst({
    where: { slug, isActive: true, approvedAt: { not: null } },
    select: { id: true, slug: true, name: true },
  });
}

/**
 * Клуб за посиланням t.me/<бот>?start=club_<slug> або кнопкою зі списку.
 *
 * Гравцеві, чий чат уже привʼязаний до картки ЦЬОГО клубу, — його
 * особиста головна (привітання за імʼям, «Мій профіль»). Решті — та сама
 * головна, але без імені, і під нею кнопка входу в профіль: людина, що
 * відкрила клуб у боті, саме тут і вирішує, чи підключати нагадування.
 */
async function showBookingClub(chatId: string, slug: string): Promise<boolean> {
  const club = await bookingClub(slug);
  if (!club) return false;

  const card = await prisma.customer.findFirst({
    where: { clubId: club.id, telegramChatId: chatId },
    select: { id: true },
  });
  if (card) return sendClubHome(chatId, club.id, card.id);

  const view = await loadClubHome(club.id, null);
  if (!view) return false;

  const login = await playerLoginButtonFor(chatId, club.slug);
  const rows = [...view.keyboard, ...(login ? [[login]] : [])];
  await sendMessage(chatId, view.text, rows.length ? { inline_keyboard: rows } : undefined);
  return true;
}

async function showClubChoice(chatId: string) {
  const clubs = await prisma.club.findMany({
    where: { isActive: true, approvedAt: { not: null } },
    select: { slug: true, name: true },
    orderBy: { name: 'asc' },
    take: 30,
  });
  if (clubs.length === 0) {
    await sendMessage(chatId, 'Зараз немає клубів, доступних для онлайн-бронювання.');
    return;
  }
  await sendMessage(chatId, 'Оберіть клуб, у якому хочете забронювати корт:', clubChoiceKeyboard(clubs));
}

/** Кого ми знаємо за цим чатом */
async function userByChat(chatId: string) {
  return prisma.user.findUnique({
    where: { tgChatId: chatId },
    select: {
      id: true,
      role: true,
      trainerId: true,
      tgNotifyBookings: true,
      club: { select: { id: true, name: true, timezone: true, plan: true } },
    },
  });
}

/**
 * Поточні налаштування сповіщень людини.
 *
 * Окремим запитом, а не полями в userByChat: їх пʼять, і тягнути їх на
 * КОЖНЕ повідомлення заради екрана, який відкривають раз на місяць, —
 * марна робота на кожному /today.
 */
async function notifySettings(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      tgNotifyBookings: true,
      tgNotifyTournaments: true,
      tgNotifyGroups: true,
      tgNotifySessions: true,
      tgRemindMinutes: true,
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
    select: { id: true, role: true, passwordHash: true, tgLinkUntil: true, club: { select: { name: true, plan: true } } },
  });

  if (!user) {
    return 'Такого коду немає. Увійдіть командою <code>/login пошта пароль</code>.';
  }

  if (!user.tgLinkUntil || user.tgLinkUntil < new Date()) {
    return 'Код протух — вони живуть 15 хвилин. Увійдіть командою <code>/login пошта пароль</code>.';
  }

  if (!planFeatures(user.club.plan).telegram) return 'Telegram-бот доступний після підключення тарифу.';

  const linked = await prisma.$transaction(async tx => {
    const consumed = await tx.user.updateMany({
      where: { id: user.id, tgLinkCode: code, tgLinkUntil: { gte: new Date() }, passwordHash: user.passwordHash },
      data: { tgLinkCode: null, tgLinkUntil: null },
    });
    if (consumed.count !== 1) return false;
    await tx.user.updateMany({ where: { tgChatId: chatId, id: { not: user.id } }, data: { tgChatId: null } });
    await tx.user.update({ where: { id: user.id }, data: { tgChatId: chatId } });
    return true;
  });
  if (!linked) return 'Код уже використаний або протух. Отримайте новий код у кабінеті.';

  return `Підключено до клубу <b>${telegramHtml(user.club.name)}</b>.\n\n${menuFor(user.role, telegramAnalytics(user.club.plan))}`;
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
      court: { select: { name: true, plan: true } },
    },
  });

  const head = `🎾 <b>${telegramHtml(clubName)}</b>\n<i>${WEEKDAY_FULL[local.weekday - 1]}, ${local.toFormat('dd.MM')}</i>`;

  if (rows.length === 0) return `${head}\n\nСьогодні занять немає.`;

  const lines = rows.map((b) => {
    const s = DateTime.fromJSDate(b.startTime).setZone(timezone).toFormat('HH:mm');
    const e = DateTime.fromJSDate(b.endTime).setZone(timezone).toFormat('HH:mm');
    /* Очікування підтвердження — окремим значком, а не хвостом тексту:
       у списку з десяти рядків його треба помітити, не читаючи. */
    const wait = b.status === 'PENDING' ? ' ⏳' : '';
    return `<code>${s}–${e}</code>  ${telegramHtml(b.court?.name ?? 'корт')} · ${telegramHtml(b.customerName ?? 'без імені')}${wait}`;
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

  /* Змінив клуб — розмова з ІІ починається з чистого аркуша (контекст і так окремий на клуб, це другий замок). */
  if (q.data?.startsWith('homeclub:') || q.data?.startsWith('bookclub:')) await resetContext(chatId);

  /* Кнопки гравця (нагадування, черга) — першими: гравцем буває і той, хто
     в клубі працює, і його «Прийду» не має впиратись у перевірку ролі. */
  if (await handlePlayerCallback(q)) return;
  /* Головна клубу, згода на акції, відписка від листів повернення — теж до
     перевірки ролі: гравцем буває й людина з персоналу. */
  if (await handleHomeCallback(q)) return;
  /* Кнопки ІІ-менеджера («Підтвердити / Відхилити») — рішення власника; роль перевіряє сам обробник. */
  if (await handleAiCallback(q)) return;

  if (q.data?.startsWith('plogin:')) {
    if (!q.from || String(q.from.id) !== chatId) {
      await answerCallback(q.id, 'Відкрийте особистий чат із ботом');
      return;
    }
    const slug = q.data.slice('plogin:'.length);
    await answerCallback(q.id);
    if (/^[a-z0-9][a-z0-9-]{1,47}$/.test(slug)) await startPlayerLogin(chatId, slug);
    return;
  }

  if (q.data?.startsWith('bookclub:')) {
    const slug = q.data.slice('bookclub:'.length);
    const shown = /^[a-z0-9][a-z0-9-]{1,47}$/.test(slug) && await showBookingClub(chatId, slug);
    await answerCallback(q.id, shown ? undefined : 'Клуб не знайдено');
    return;
  }

  const me = await userByChat(chatId);

  if (!me) {
    await answerCallback(q.id, 'Спершу увійдіть: /login пошта пароль');
    return;
  }

  if (!planFeatures(me.club.plan).telegram) {
    await answerCallback(q.id, 'Telegram-бот доступний після підключення тарифу.');
    return;
  }

  /* Налаштування розбираємо ДО перевірки ролі нижче: екран доступний і
     тренеру, а та перевірка відсікає його від звітів. */
  const setting = parseSettingsAction(q.data);
  if (setting) {
    if (setting.kind === 'toggle' && !canToggle(me.role, setting.key)) {
      /* Кнопка зі старого повідомлення, надісланого до зміни ролі. */
      await answerCallback(q.id, 'Цей перемикач вам не доступний');
      return;
    }

    const current = await notifySettings(me.id);
    const data = setting.kind === 'lead'
      ? { tgRemindMinutes: setting.minutes }
      : { [setting.key]: !current[setting.key] };

    const next = await prisma.user.update({
      where: { id: me.id },
      data,
      select: {
        tgNotifyBookings: true,
        tgNotifyTournaments: true,
        tgNotifyGroups: true,
        tgNotifySessions: true,
        tgRemindMinutes: true,
      },
    });

    /* Перемальовуємо на місці: десять натискань не мають лишити десять
       однакових екранів у стрічці. */
    if (q.message) {
      await editMessageText(
        chatId, q.message.message_id,
        settingsText(me.role, next), settingsKeyboard(me.role, next),
      );
    }
    await answerCallback(q.id);
    return;
  }

  const action = parseAction(q.data);
  if (!action) {
    /* Кнопка зі старого повідомлення або чужі дані. Мовчки гасимо
       годинник: пояснювати тут нічого, а падати тим більше. */
    await answerCallback(q.id);
    return;
  }

  /* Модератор грошових зведень не бачить (рішення власника 2026-09-28). */
  if (me.role === 'TRAINER' || me.role === 'ADMIN') {
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
  // Group chats receive notifications only; a group id is never a staff identity.
  if (u.callback_query?.message && String(u.callback_query.message.chat.id) !== String(u.callback_query.from?.id)) return;
  if (u.message && (u.message.chat.type !== 'private' || u.message.chat.id !== u.message.from?.id)) {
    if (/^\/(login|newpassword|start)(@\w+)?\b/i.test(u.message.text ?? '')) {
      await deleteMessage(String(u.message.chat.id), u.message.message_id);
      await sendMessage(String(u.message.chat.id), 'Вхід і керування акаунтом доступні лише в особистому чаті з ботом.');
    }
    return;
  }
  if (u.callback_query) {
    await handleCallback(u.callback_query);
    return;
  }

  const msg = u.message;
  if (!msg) return;

  const chatId = String(msg.chat.id);

  /* Покроковий вхід гравця в профіль. До перевірки тексту: номер телефону
     приходить контактом, у якого тексту немає зовсім. */
  if (msg.chat.type === 'private' && await handlePlayerLoginMessage(msg)) return;

  const raw = msg.text?.trim();
  if (!raw) return;

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
    /* Інший акаунт у тому ж чаті не має успадкувати розмову попереднього. */
    await resetContext(chatId);
    const me = await userByChat(chatId);

    if (me) {
      const analytics = telegramAnalytics(me.club.plan);
      await setMyCommands(commandsFor(me.role, analytics), chatId);
      await sendMessage(chatId, reply, replyKeyboard(me.role, analytics));
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
    await sendMessage(chatId, reply, me ? replyKeyboard(me.role, telegramAnalytics(me.club.plan)) : undefined);
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

  /* Перший /start гравця: один рядок із посиланням на Політику. */
  if (cmd === '/start' && msg.chat.type === 'private') {
    await resetContext(chatId);
    await sendPrivacyNoticeOnce(chatId).catch((e) => console.warn('[bot] privacy notice', (e as Error).message));
  }

  /* Гравець: /start p_<код> з профілю у віджеті. Раніше за /start із кодом
     персоналу — інакше код гравця пішов би шукатись серед кодів кабінету й
     повернувся б «Такого коду немає». Сам код чат не привʼязує: далі бот
     просить підтвердити номер кнопкою Telegram (lib/playerLogin.ts). */
  const linkCode = cmd === '/start' ? codeFromStartPayload(args[0]) : null;
  if (linkCode) {
    if (msg.chat.type !== 'private') {
      await sendMessage(chatId, 'Підключення гравця працює тільки в особистому чаті з ботом.');
      return;
    }
    await startLinkByCode(chatId, linkCode);
    return;
  }

  /* /my і /stop гравця. */
  if (await handlePlayerCommand(chatId, cmd, args)) return;

  /* Вхід гравця в профіль, створений на сайті клубу: /profile або пряме
     посилання клубу t.me/<бот>?start=login_<slug>. Тільки в особистому
     чаті — ділитись номером у груповому чаті клубу ніхто не має. */
  const loginSlug = cmd === '/start' ? loginSlugFromStartPayload(args[0]) : null;
  if (loginSlug || cmd === '/profile') {
    if (msg.chat.type !== 'private') {
      await sendMessage(chatId, 'Вхід гравця працює тільки в особистому чаті з ботом.');
      return;
    }
    const slug = loginSlug ?? (args[0] && /^[a-z0-9][a-z0-9-]{1,47}$/.test(args[0]) ? args[0] : null);
    if (slug) await startPlayerLogin(chatId, slug);
    else await playerLoginClubChoice(chatId);
    return;
  }

  /* Підбір партнерів із віджета: t.me/<бот>?start=games. Гравець приходить
     сюди вже з наміром, тому показуємо ігри одразу, а не меню. Якщо чат ще
     не привʼязаний до картки — пропонуємо вхід, бо без картки ми не знаємо
     ні клубу, ні рівня, а показати «всі ігри світу» гірше, ніж нічого. */
  if (cmd === '/start' && args[0] === 'games') {
    if (msg.chat.type !== 'private') {
      await sendMessage(chatId, 'Підбір гри працює тільки в особистому чаті з ботом.');
      return;
    }
    if (await handlePlayerCommand(chatId, '/games', [])) return;
    await playerLoginClubChoice(chatId);
    return;
  }

  const startClub = cmd === '/start' ? slugFromStartPayload(args[0]) : null;
  if (startClub) {
    if (!await showBookingClub(chatId, startClub)) {
      await sendMessage(chatId, 'Цей клуб не знайдено або онлайн-бронювання вимкнене.');
      await showClubChoice(chatId);
    }
    return;
  }

  /* /start із кодом — сумісність із кнопкою кабінету. */
  if (cmd === '/start' && args[0]) {
    const reply = await linkByCode(chatId, args[0]);
    const linked = await userByChat(chatId);

    if (linked) {
      const analytics = telegramAnalytics(linked.club.plan);
      await setMyCommands(commandsFor(linked.role, analytics), chatId);
      await sendMessage(chatId, reply, replyKeyboard(linked.role, analytics));
    } else {
      await sendMessage(chatId, reply);
    }
    return;
  }

  const me = await userByChat(chatId);

  if (!me) {
    if (cmd === '/start' || cmd === '/book') {
      await setMyCommands(COMMANDS_GUEST, chatId);
      /* Підключений гравець одразу потрапляє у свій клуб — список усіх
         клубів платформи йому не потрібен. */
      if (!await sendOwnClubHome(chatId)) await showClubChoice(chatId);
      return;
    }
    /* Голий код без /start теж приймаємо: людина частіше просто вставляє
       його в чат, ніж пише команду з аргументом. */
    if (/^[A-Z0-9]{6}$/i.test(raw)) {
      await sendMessage(chatId, await linkByCode(chatId, raw.toUpperCase()));
      return;
    }
    /* Вільний текст від чужого чату: людина, що пише «привіт», не просила довідку на екран — підказуємо лише вхід.
       Це не звернення до ІІ. Гравець із привʼязаною карткою потрапляє до помічника (якщо клуб його ввімкнув). */
    if (!text.startsWith('/')) {
      if (!await handlePlayerAiText(chatId, raw)) await sendMessage(chatId, UNKNOWN_HINT);
      return;
    }
    await sendMessage(chatId, HELP);
    return;
  }

  /* Персонал, який і сам грає: якщо в нього є картка гравця, /book веде в
     головну її клубу, а не у список. */
  if (cmd === '/book') {
    if (!await sendOwnClubHome(chatId)) await showClubChoice(chatId);
    return;
  }

  if (cmd !== '/logout' && !planFeatures(me.club.plan).telegram) {
    await sendMessage(chatId, 'Telegram-бот доступний після підключення тарифу.', removeKeyboard);
    return;
  }

  const analyticsOk = telegramAnalytics(me.club.plan);
  const keyboard = replyKeyboard(me.role, analyticsOk);
  const menu = menuFor(me.role, analyticsOk);

  if (cmd === '/analytics') {
    if (!analyticsOk) {
      await sendMessage(chatId, 'Аналітика в Telegram входить у тариф «Аналітика».', keyboard);
      return;
    }
    if (msg.chat.type !== 'private' || me.role !== 'OWNER') {
      await sendMessage(chatId, 'Аналітика доступна власнику лише в особистому чаті з ботом.');
      return;
    }
    const messages = await botAnalytics(me.club.id, args.join(' '));
    for (const text of messages) await sendMessage(chatId, text, keyboard);
    return;
  }

  /* Доступний усім ролям, включно з тренером: це налаштування власного
     чату, а не доступ до чогось клубного. Набір рядків у ньому все одно
     залежить від ролі — див. botSettings.rowsFor. */
  if (cmd === '/settings') {
    const s = await notifySettings(me.id);
    await sendMessage(chatId, settingsText(me.role, s), settingsKeyboard(me.role, s));
    return;
  }

  if (cmd === '/help' || cmd === '/start') {
    await setMyCommands(commandsFor(me.role, analyticsOk), chatId);
    await sendMessage(chatId, `Клуб <b>${telegramHtml(me.club.name)}</b>.\n\n${menu}`, keyboard);
    return;
  }

  if (cmd === '/logout') {
    await logout(chatId);
    await resetContext(chatId);
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

    if (me.role === 'ADMIN') {
      await sendMessage(chatId, `Ця команда доступна власнику клубу.

${menu}`, keyboard);
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
    if (me.role === 'TRAINER' || me.role === 'ADMIN') {
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

  /* Не команда й не підпис кнопки — вільне запитання до ІІ-менеджера (з правами цієї ролі). */
  if (!text.startsWith('/')) {
    await handleStaffAiText(chatId, raw, me, { menu, keyboard });
    return;
  }

  await sendMessage(chatId, `Не знаю такої команди.\n\n${menu}`, keyboard);
}
