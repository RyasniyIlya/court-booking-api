import { planFeatures } from './plans';
import { telegramHtml } from './telegramHtml';
import bcrypt from 'bcryptjs';
import { checkPassword } from './passwordCheck';

import { prisma } from './db';

/**
 * Вхід у бота поштою і паролем кабінету.
 *
 * Один акаунт — і кабінет, і бот: окремий пароль для Telegram означав би
 * ще одне поле в базі, ще один екран у налаштуваннях і ще один пароль,
 * який власник забуде. Тому звіряємось із тим самим User.passwordHash.
 *
 * Пароль приїжджає звичайним повідомленням, тому виклик у botHandlers
 * одразу прибирає його з чату. Тут же лишається друга частина захисту —
 * лічильник невдалих спроб: без нього чат із ботом був би відкритою
 * формою входу без жодного обмеження швидкості.
 */

/**
 * Хеш неіснуючого пароля — щоб відповідь на невідому пошту забирала
 * стільки ж часу, скільки й на відому. Інакше різниця в часі відповіді
 * сама по собі каже, чи є така пошта в клубі.
 */
const DUMMY_HASH = '$2b$10$XLHocTuqWFFCGzIIYiLXi.LZ9/1G/pTeoFKFKBYmi5L4Ss8pZJRFq';

/** Скільки помилок підряд дозволяємо одному чату */
const MAX_FAILS = 5;

/** І на скільки замикаємо після цього */
const LOCK_MS = 15 * 60_000;

/**
 * Лічильник живе в памʼяті процесу, а не в базі.
 *
 * Причина проста: у нас один процес API, тож загальний лічильник тут той
 * самий, що й у базі, але без міграції і без
 * походу в Postgres на кожну спробу входу. Рестарт скидає блокування —
 * це прийнятно: перебір пароля рестартом сервера не прискорити.
 */
const fails = new Map<string, { count: number; until: number }>();

/** Скільки мілісекунд ще триває блокування цього чату. 0 — не заблокований. */
export function lockRemaining(chatId: string, now = Date.now()): number {
  const rec = fails.get(chatId);
  if (!rec || rec.until <= now) return 0;
  return rec.until - now;
}

/** Невдала спроба. Повертає, чи чат щойно замкнувся. */
export function noteFail(chatId: string, now = Date.now()): boolean {
  const rec = fails.get(chatId);
  const count = (rec?.count ?? 0) + 1;
  const locked = count >= MAX_FAILS;
  fails.set(chatId, { count: locked ? 0 : count, until: locked ? now + LOCK_MS : 0 });
  return locked;
}

/** Успішний вхід стирає історію промахів. */
export function clearFails(chatId: string) {
  fails.delete(chatId);
}

/** Тільки для тестів: чистий старт між кейсами. */
export function resetThrottle() {
  fails.clear();
}

/**
 * Довідка після входу.
 *
 * Названо кнопками, а не командами: людина натискає саме їх. Команда
 * лишається поруч тим самим рядком — щоб не пояснювати одне й те саме
 * двома окремими списками.
 */
const MENU_OWNER = [
  '🔎 <b>Аналітика</b> — корти, суми, завантаження, оплати й скасування',
  '<code>/analytics today</code> · <code>/analytics yesterday</code>',
  '<code>/analytics week</code> · <code>/analytics month</code> · <code>/analytics YYYY-MM-DD</code>',
  '📊 <b>Сьогодні</b> — виручка, броні, нові клієнти',
  '📅 <b>Вчора</b> — те саме за попередній день',
  '📈 <b>Тиждень</b> — графік із перемикачем на 2 і 4 тижні',
  '💰 <b>Виручка</b> — звідки беруться гроші: корти, тренери, групові',
  '👥 <b>Персонал</b> — хто скільки провів занять і заробив',
  '',
  '<i>Кнопки під полем вводу роблять те саме, що /today, /yesterday і /week.</i>',
  '<i>Щовечора зведення дня приходить саме, без запиту.</i>',
  '⚙️ <b>Сповіщення</b> — нові броні, нагадування про турніри й групові',
  '',
  '<i>Кожна нова бронь приходить сюди одразу, а перед турніром і груповим</i>',
  '<i>я нагадаю завчасно. Що саме приходить і за скільки хвилин — /settings.</i>',
  '',
  '/settings — налаштувати сповіщення',
  '/newpassword новий пароль — змінити пароль кабінету',
  '/logout — відключити цей чат',
].join('\n');

const MENU_TRAINER = [
  '📋 <b>Мої заняття</b> — ваш розклад на сьогодні',
  '',
  '<i>Кнопка під полем вводу робить те саме, що /today.</i>',
  '⚙️ <b>Сповіщення</b> — що приходить і за скільки хвилин',
  '',
  '<i>Коли вас записують на заняття або знімають з нього — я скажу одразу.</i>',
  '<i>І нагадаю за чверть години до початку, щоб не тримати це в голові.</i>',
  '',
  '/settings — налаштувати сповіщення',
  '/newpassword новий пароль — змінити пароль кабінету',
  '/logout — відключити цей чат',
].join('\n');

export const menuFor = (role: string) => (role === 'TRAINER' ? MENU_TRAINER : MENU_OWNER);

/**
 * Перевірити пошту з паролем і привʼязати чат до акаунта.
 *
 * Відповідь на невідому пошту і на невірний пароль однакова навмисно:
 * інакше бот перетворюється на довідник «хто з цією поштою у нас є».
 */
export async function loginByPassword(
  chatId: string,
  email: string,
  password: string,
): Promise<string> {
  if (!/^[1-9]\d*$/.test(chatId)) return 'Відкрийте особистий чат із ботом.';
  const wait = lockRemaining(chatId);
  if (wait > 0) {
    return `Забагато невдалих спроб. Спробуйте через ${Math.ceil(wait / 60_000)} хв.`;
  }

  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: {
      id: true,
      role: true,
      passwordHash: true,
      club: { select: { name: true, plan: true } },
    },
  });

  /* bcrypt.compare проти справжнього хеша навіть тоді, коли акаунта немає:
     інакше відповідь на неіснуючу пошту приходила б помітно швидше, і за
     часом відповіді можна було б перебрати список адрес клубу. */
  const check = user ? await checkPassword('user', user.id, password) : null;
  if (!user) await bcrypt.compare(password.slice(0, 128), DUMMY_HASH);
  const ok = check?.ok === true;

  if (!user || !ok) {
    const locked = noteFail(chatId);
    return locked
      ? 'Невірна пошта або пароль. Спроби вичерпано — наступна через 15 хв.'
      : 'Невірна пошта або пароль.';
  }

  clearFails(chatId);

  /* Бухгалтер — веб-роль: фінанси дивляться в кабінеті, а не в чаті.
     menuFor нижче знає лише два меню (тренерське й «усе інше»), і без
     цього відсікання «усе інше» дісталось би й бухгалтеру. */
  if (user.role === 'ACCOUNTANT') return 'Ця роль працює тільки в кабінеті на сайті. Фінанси — у розділі «Каса».';

  if (!planFeatures(user.club.plan).telegram) return 'Telegram-бот доступний лише в максимальному пакеті.';

  /* Чат міг належати іншій людині клубу. Відвʼязуємо старого власника
     мовчки: unique-індекс на tgChatId інакше просто впаде, і людина
     побачила б незрозумілу помилку замість входу. */
  await prisma.user.updateMany({ where: { tgChatId: chatId }, data: { tgChatId: null } });
  await prisma.user.update({
    where: { id: user.id },
    data: { tgChatId: chatId, tgLinkCode: null, tgLinkUntil: null },
  });

  return [
    `✅ Вхід виконано`,
    `🎾 <b>${telegramHtml(user.club.name)}</b>`,
    '',
    menuFor(user.role),
  ].join('\n');
}

/** Відвʼязати чат. Повертає, чи справді щось відвʼязали. */
export async function logout(chatId: string): Promise<boolean> {
  const r = await prisma.user.updateMany({
    where: { tgChatId: chatId },
    data: { tgChatId: null, tgLinkCode: null, tgLinkUntil: null },
  });
  return r.count > 0;
}
