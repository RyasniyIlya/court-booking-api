import { prisma } from './db';
import { planFeatures } from './plans';
import { sendMessage, deleteMessage, type TgUpdate } from './telegram';
import { verifyCustomerPassword } from './customerPassword';
import { playerKeyboard } from './botKeyboard';
import { normalizePhone } from './phone';
import { bookingUrl } from './botBooking';
import { html, linkChatToCustomer, PLAYER_LINK_MINUTES, sendPrivacyNoticeOnce } from './playerBot';
import { askMarketingConsent, sendClubHome } from './playerHome';

/**
 * Основний вхід: телефон і пароль профілю, створеного на сайті клубу.
 * Пароль перевіряє спільний із вебвходом сервіс із блокуванням спроб.
 * Одноразове посилання з авторизованого вебпрофілю зберігає окремий
 * шлях привʼязки через підтверджений Telegram-контакт.
 *
 * ── Перевірка для одноразового посилання ────────────────────────────────
 *
 * Профіль гравця створюється на сайті клубу, і номер там ніхто не
 * перевіряє: будь-хто може зареєструвати чужий телефон зі своєю датою
 * народження. Сам по собі профіль на сайті мало що дає, але привʼязаний до
 * нього Telegram — дає: нагадування про чужі ігри з кнопкою «Скасувати».
 *
 * За одноразовим посиланням чат привʼязується, коли людина поділилась
 * номером кнопкою request_contact і цей номер збігається з номером картки.
 * Telegram віддає номер, на який зареєстрований САМ акаунт, і
 * contact.user_id дорівнює автору повідомлення — підробити це з клієнта
 * неможливо. Набраний руками номер не приймається зовсім, тож і дату
 * народження перебирати нема де.
 *
 * ── Два входи, одна перевірка ───────────────────────────────────────────
 *
 *   • /profile, кнопка під карткою клубу, t.me/<бот>?start=login_<slug> —
 *     перевіряємо телефон і пароль наявного акаунта;
 *   • «Підключити Telegram» у профілі на сайті (start=p_<код>) — картка вже
 *     відома з коду, і номер Telegram має збігтися саме з нею.
 */

export const LOGIN_TTL_MINUTES = 30;
export const BTN_SHARE_PHONE = '📱 Надіслати мій номер';
export const BTN_CANCEL = 'Скасувати';

type LoginData = {
  clubId: string;
  /** Прийшли за кодом із профілю — номер має збігтися саме з цією карткою */
  customerId?: string;
  phone?: string;
};

type Msg = NonNullable<TgUpdate['message']>;
type Club = { id: string; slug: string; name: string };

const FLOW = 'player-login';
const removeKeyboard = { remove_keyboard: true };

const phoneKeyboard = () => ({
  keyboard: [[{ text: BTN_SHARE_PHONE, request_contact: true }], [{ text: BTN_CANCEL }]],
  resize_keyboard: true,
});

/** Клуб, у профіль якого можна увійти через бота */
async function loginClub(where: { slug: string } | { id: string }) {
  const club = await prisma.club.findFirst({
    where: { ...where, isActive: true, approvedAt: { not: null } },
    select: { id: true, slug: true, name: true, plan: true },
  });
  return club && planFeatures(club.plan).telegram ? club : null;
}

async function saveDialog(chatId: string, data: LoginData, step = 'phone') {
  const expiresAt = new Date(Date.now() + LOGIN_TTL_MINUTES * 60_000);
  await prisma.tgDialog.upsert({
    where: { chatId },
    create: { chatId, flow: FLOW, step, data, expiresAt },
    update: { flow: FLOW, step, data, expiresAt },
  });
}

const dropDialog = (chatId: string) => prisma.tgDialog.deleteMany({ where: { chatId } });

/** Кнопка на сторінку клубу — там створюють профіль і міняють у ньому номер */
function siteKeyboard(slug: string, text: string) {
  const url = bookingUrl(slug);
  if (!url) return removeKeyboard;
  const button = url.startsWith('https://') ? { text, web_app: { url } } : { text, url };
  return { inline_keyboard: [[button]] };
}

/** «+380671112233» → «•• 33»: досить, щоб упізнати свій, і не видає чужий */
export const phoneHint = (e164: string) => `•• ${e164.slice(-2)}`;

async function askPhone(chatId: string, head: string) {
  await sendMessage(
    chatId,
    [
      head,
      '',
      `Натисніть «${BTN_SHARE_PHONE}» нижче. Telegram передасть номер, на який зареєстрований ваш акаунт, — він має збігатися з номером у профілі гравця.`,
      '',
      '<i>Набраний вручну номер не приймаємо: так ніхто не підключиться до чужого профілю.</i>',
    ].join('\n'),
    phoneKeyboard(),
  );
}

/* ── Старт ─────────────────────────────────────────────────────────────── */

/** /profile, кнопка під карткою клубу, /start login_<slug> */
export async function startPlayerLogin(chatId: string, slug: string): Promise<void> {
  const club = await loginClub({ slug });
  if (!club) {
    await sendMessage(chatId, 'Вхід гравця через Telegram у цьому клубі зараз недоступний.');
    return;
  }

  const existing = await prisma.customer.findFirst({
    where: { clubId: club.id, telegramChatId: chatId },
    select: { id: true },
  });
  if (existing) {
    /* Уже в профілі — нічого не перепитуємо, а показуємо клуб: саме цього
       людина чекає від кнопки «Мій профіль». */
    await sendClubHome(chatId, club.id, existing.id);
    return;
  }

  await saveDialog(chatId, { clubId: club.id }, 'account-phone');
  await sendMessage(chatId,
    `👤 <b>${html(club.name)} · Вхід</b>\n\nКрок 1 з 2 — телефон.\nВведіть номер із профілю на сайті. Далі введіть пароль цього профілю. Номер Telegram може відрізнятися.`,
    { keyboard: [[{ text: BTN_CANCEL }]], resize_keyboard: true });
  await sendMessage(chatId, 'Ще немає профілю? Спочатку зареєструйтеся на сайті клубу.', siteKeyboard(club.slug, 'Створити профіль на сайті'));
}

/**
 * /start p_<код> — кнопка «Підключити Telegram» у профілі на сайті.
 *
 * Код гаситься одразу: посилання одноразове навіть тоді, коли номер не
 * збігся. Картку тримає діалог, тож поділитись номером можна ще раз.
 */
export async function startLinkByCode(chatId: string, code: string): Promise<void> {
  const customer = await prisma.customer.findUnique({
    where: { tgLinkCode: code },
    select: { id: true, clubId: true, telegramChatId: true, tgLinkUntil: true, club: { select: { slug: true, name: true } } },
  });

  if (!customer) {
    await sendMessage(chatId, 'Посилання вже використане або недійсне. Відкрийте профіль на сайті клубу й натисніть «Підключити Telegram» ще раз.');
    return;
  }

  await prisma.customer.update({
    where: { id: customer.id },
    data: { tgLinkCode: null, tgLinkUntil: null },
  });

  if (!customer.tgLinkUntil || customer.tgLinkUntil < new Date()) {
    await sendMessage(chatId, `Посилання протухло — воно живе ${PLAYER_LINK_MINUTES} хвилин. Натисніть «Підключити Telegram» у профілі ще раз.`);
    return;
  }

  const club = await loginClub({ id: customer.clubId });
  if (!club) {
    await sendMessage(chatId, 'Цей клуб поки не надсилає сповіщення в Telegram.');
    return;
  }

  /* Цей чат уже привʼязаний до цієї картки (людина натиснула посилання з
     профілю вдруге): номер уже підтверджено, повторювати нічого. */
  if (customer.telegramChatId === chatId) {
    await sendClubHome(chatId, club.id, customer.id);
    return;
  }

  await saveDialog(chatId, { clubId: club.id, customerId: customer.id });
  await askPhone(chatId, `🔗 <b>Підключення Telegram · ${html(club.name)}</b>\n\nОстанній крок — підтвердіть номер.`);
}

/* ── Відповідь на запит номера ─────────────────────────────────────────── */

/**
 * Повідомлення в межах діалогу входу. false — діалогу немає, повідомлення
 * розбирає звичайний обробник.
 */
export async function handlePlayerLoginMessage(msg: Msg): Promise<boolean> {
  if (msg.chat.type !== 'private') return false;
  const chatId = String(msg.chat.id);
  const dialog = await prisma.tgDialog.findUnique({ where: { chatId } });
  if (!dialog || dialog.flow !== FLOW) return false;

  // Пароль не зберігаємо ні в діалозі, ні в історії чату.
  if (dialog.step === 'account-password' && msg.text) {
    const deleted = await deleteMessage(chatId, msg.message_id);
    if (!deleted) await sendMessage(chatId, 'Не вдалося видалити повідомлення. Видаліть його вручну, якщо воно містить пароль.');
  }

  if (dialog.expiresAt < new Date()) {
    await dropDialog(chatId);
    await sendMessage(chatId, 'Час входу минув. Почніть знову командою /profile.', removeKeyboard);
    return true;
  }

  const text = msg.text?.trim() ?? '';

  if (text === BTN_CANCEL || text.split('@')[0].toLowerCase() === '/cancel') {
    await dropDialog(chatId);
    await sendMessage(chatId, 'Скасовано. Почати знову — /profile.', removeKeyboard);
    return true;
  }

  /* Інша команда посеред входу — людина передумала. Закриваємо діалог і
     віддаємо команду звичайному обробнику. */
  if (text.startsWith('/') && dialog.step !== 'account-password') {
    await dropDialog(chatId);
    return false;
  }

  if (dialog.step === 'account-phone' || dialog.step === 'account-password') {
    const data = dialog.data as LoginData;
    const club = await loginClub({ id: data.clubId });
    if (!club) {
      await dropDialog(chatId);
      await sendMessage(chatId, 'Вхід у цьому клубі зараз недоступний.', removeKeyboard);
      return true;
    }
    if (dialog.step === 'account-phone') {
      const phone = normalizePhone(text);
      if (!phone) {
        await sendMessage(chatId, 'Введіть телефон профілю, наприклад +380671112233.');
        return true;
      }
      await saveDialog(chatId, { clubId: club.id, phone: phone.e164 }, 'account-password');
      await sendMessage(chatId, '🔐 <b>Крок 2 з 2 — пароль</b>\n\nНадішліть пароль профілю із сайту окремим повідомленням. Я спробую одразу видалити його з чату.');
      return true;
    }
    const password = msg.text ?? '';
    if (!password || password.length > 128) {
      await sendMessage(chatId, 'Надішліть пароль текстом (до 128 символів).');
      return true;
    }
    const customer = data.phone ? await prisma.customer.findUnique({
      where: { clubId_phone: { clubId: club.id, phone: data.phone } },
      select: { id: true, name: true },
    }) : null;
    const check = customer ? await verifyCustomerPassword(customer.id, password) : null;
    if (!customer || !check?.ok) {
      await dropDialog(chatId);
      await sendMessage(chatId,
        check && !check.ok && check.reason === 'LOCKED'
          ? 'Забагато спроб. Спробуйте через 15 хвилин.'
          : 'Не вдалося увійти. Перевірте телефон і пароль профілю на сайті.',
        { inline_keyboard: [[{ text: 'Спробувати ще раз', callback_data: `plogin:${club.slug}` }]] });
      return true;
    }
    await finish(chatId, club, customer.id, customer.name);
    return true;
  }

  const contact = msg.contact;
  if (!contact) {
    await sendMessage(
      chatId,
      `Номер приймаємо тільки кнопкою «${BTN_SHARE_PHONE}» — так ми знаємо, що він справді ваш.`,
      phoneKeyboard(),
    );
    return true;
  }

  if (!msg.from || contact.user_id !== msg.from.id) {
    await sendMessage(chatId, 'Це чужий контакт. Надішліть свій номер кнопкою нижче.', phoneKeyboard());
    return true;
  }

  const data = dialog.data as LoginData;
  const club = await loginClub({ id: data.clubId });
  if (!club) {
    await dropDialog(chatId);
    await sendMessage(chatId, 'Вхід у цьому клубі вже недоступний.', removeKeyboard);
    return true;
  }

  /* Telegram віддає номер контакту в міжнародному форматі без «+». */
  const phone = normalizePhone(`+${contact.phone_number.replace(/\D/g, '')}`);
  if (!phone) {
    await dropDialog(chatId);
    await sendMessage(chatId, 'Не вдалося розпізнати номер вашого Telegram. Зверніться, будь ласка, до адміністратора клубу.', removeKeyboard);
    return true;
  }

  if (data.customerId) return confirmKnownCustomer(chatId, club, data.customerId, phone.e164);
  return loginByPhone(chatId, club, phone.e164, phone.pretty);
}

/** Прийшли з профілю: номер Telegram має збігтися з карткою, що видала код */
async function confirmKnownCustomer(chatId: string, club: Club, customerId: string, phone: string) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, name: true, phone: true, clubId: true },
  });
  if (!customer || customer.clubId !== club.id) {
    await dropDialog(chatId);
    await sendMessage(chatId, 'Профіль не знайдено. Натисніть «Підключити Telegram» на сайті клубу ще раз.', removeKeyboard);
    return true;
  }

  if (customer.phone !== phone) {
    await dropDialog(chatId);
    await sendMessage(
      chatId,
      [
        `Номер вашого Telegram не збігається з номером у профілі (${phoneHint(customer.phone)}).`,
        '',
        'Підключити можна тільки той Telegram, що зареєстрований на номер профілю. Якщо в профілі старий номер — попросіть адміністратора клубу його змінити.',
      ].join('\n'),
      removeKeyboard,
    );
    return true;
  }

  await finish(chatId, club, customer.id, customer.name);
  return true;
}

/** /profile: шукаємо картку клубу за підтвердженим номером */
async function loginByPhone(chatId: string, club: Club, phone: string, pretty: string) {
  const customer = await prisma.customer.findUnique({
    where: { clubId_phone: { clubId: club.id, phone } },
    select: { id: true, name: true },
  });

  if (!customer) {
    await dropDialog(chatId);
    await sendMessage(chatId, `Профілю з номером ${pretty} у клубі <b>${html(club.name)}</b> ще немає.`, removeKeyboard);
    await sendMessage(
      chatId,
      'Створіть профіль на сайті клубу — з тим самим номером, що й у Telegram. Потім поверніться сюди й натисніть /profile.',
      siteKeyboard(club.slug, 'Створити профіль на сайті клубу'),
    );
    return true;
  }

  await finish(chatId, club, customer.id, customer.name);
  return true;
}

/**
 * Вхід вдався: привʼязати чат (див. linkChatToCustomer), коротко підтвердити
 * й одразу відкрити клуб — людина прийшла по нього, а не по інструкцію.
 * Згоду на акції питаємо останньою й лише раз.
 */
async function finish(chatId: string, club: Club, customerId: string, name: string) {
  await linkChatToCustomer(chatId, club.id, customerId);
  await dropDialog(chatId);

  /* Постійна клавіатура їде з цим коротким повідомленням: Telegram не
     дозволяє в одному повідомленні дати і її, і inline-кнопки — вони
     прийдуть у головній клубу. */
  await sendMessage(
    chatId,
    `✅ <b>Telegram підключено</b>\n\n${html(name)}, нагадаємо про гру за 3 години до початку.`,
    playerKeyboard(),
  );

  await sendPrivacyNoticeOnce(chatId).catch((e) => console.warn('[bot] privacy notice', (e as Error).message));
  await sendClubHome(chatId, club.id, customerId);
  await askMarketingConsent(chatId, customerId);
}

/* ── Точки входу з обробника ───────────────────────────────────────────── */

export const LOGIN_START_PREFIX = 'login_';

export function loginSlugFromStartPayload(payload: string | undefined): string | null {
  if (!payload?.startsWith(LOGIN_START_PREFIX)) return null;
  const slug = payload.slice(LOGIN_START_PREFIX.length);
  return /^[a-z0-9][a-z0-9-]{1,47}$/.test(slug) ? slug : null;
}

/** Кнопка «Увійти в профіль гравця» під карткою клубу — або null */
export async function playerLoginButtonFor(chatId: string, slug: string) {
  const club = await loginClub({ slug });
  if (!club) return null;
  const linked = await prisma.customer.findFirst({
    where: { clubId: club.id, telegramChatId: chatId },
    select: { id: true },
  });
  return { text: linked ? '👤 Мій профіль' : '👤 Увійти в профіль гравця', callback_data: `plogin:${slug}` };
}

/** /profile без параметра: один клуб — одразу, кілька — вибір */
export async function playerLoginClubChoice(chatId: string) {
  const clubs = await prisma.club.findMany({
    where: { isActive: true, approvedAt: { not: null } },
    select: { slug: true, name: true, plan: true },
    orderBy: { name: 'asc' },
    take: 30,
  });
  const open = clubs.filter((c) => planFeatures(c.plan).telegram);
  if (open.length === 0) {
    await sendMessage(chatId, 'Зараз немає клубів, у профіль яких можна увійти через Telegram.');
    return;
  }
  if (open.length === 1) {
    await startPlayerLogin(chatId, open[0].slug);
    return;
  }
  await sendMessage(chatId, 'У профіль якого клубу входимо?', {
    inline_keyboard: open.map((c) => [{ text: `🎾 ${c.name}`, callback_data: `plogin:${c.slug}` }]),
  });
}
