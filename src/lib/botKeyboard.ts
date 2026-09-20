/**
 * Кнопки бота.
 *
 * Три різні речі, які легко сплутати між собою:
 *
 *   1. Постійна клавіатура під полем вводу (reply keyboard) — те, чим
 *      людина користується щодня. Натискання приходить звичайним
 *      текстовим повідомленням, тому кожна кнопка має підпис, який ми
 *      вміємо розібрати назад у команду.
 *   2. Кнопки під конкретним повідомленням (inline) — перемикачі періоду
 *      і оновлення. Приходять окремим типом оновлення з callback_data.
 *   3. Синє меню «/» — просто список команд, який Telegram показує сам.
 *
 * Усе тут — чисті функції без походів у мережу: саме тому їх видно в
 * тестах повністю, а botHandlers лишається про логіку, а не про розмітку.
 */

export type Role = 'OWNER' | 'ADMIN' | 'TRAINER' | string;

const isTrainer = (role: Role) => role === 'TRAINER';

/* ── Постійна клавіатура ─────────────────────────────────────────────── */

const BTN_TODAY = '📊 Сьогодні';
const BTN_YESTERDAY = '📅 Вчора';
const BTN_WEEK = '📈 Тиждень';
const BTN_REVENUE = '💰 Виручка';
const BTN_STAFF = '👥 Персонал';
const BTN_SESSIONS = '📋 Мої заняття';
const BTN_HELP = '❓ Довідка';
const BTN_ANALYTICS = '🔎 Аналітика';
const BTN_SETTINGS = '⚙️ Сповіщення';

/**
 * Підпис кнопки -> команда.
 *
 * Кнопка reply-клавіатури не має жодного технічного ідентифікатора: у
 * бота вона приїжджає як текст, який людина ніби набрала руками. Тому
 * таблиця тут — єдине, що звʼязує напис на кнопці з обробником, і міняти
 * підпис можна тільки разом із нею.
 */
const BY_LABEL: Record<string, string> = {
  '🎾 Забронювати': '/book',
  '📋 Мої записи': '/my',
  '🤝 Знайти гру': '/games',
  '👤 Мій профіль': '/profile',
  '👤 Увійти в профіль': '/profile',
  '🚪 Вийти з профілю': '/stop',
  [BTN_TODAY]: '/today',
  [BTN_YESTERDAY]: '/yesterday',
  [BTN_WEEK]: '/week',
  [BTN_REVENUE]: '/revenue',
  [BTN_STAFF]: '/staff',
  [BTN_SESSIONS]: '/today',
  [BTN_HELP]: '/help',
  [BTN_ANALYTICS]: '/analytics',
  [BTN_SETTINGS]: '/settings',
};

/** Команда за натиснутою кнопкою, або null, якщо це звичайний текст */
export function commandForLabel(text: string): string | null {
  return BY_LABEL[text.trim()] ?? null;
}

export function playerKeyboard() {
  return {
    keyboard: [
      [{ text: '🎾 Забронювати' }, { text: '📋 Мої записи' }],
      /* Підбір партнерів поруч із бронюванням: це два способи опинитись
         на корті, і другий потрібен саме тим, кому нема з ким грати. */
      [{ text: '🤝 Знайти гру' }],
      [{ text: '👤 Мій профіль' }, { text: '🚪 Вийти з профілю' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

/**
 * Клавіатура під полем вводу.
 *
 * resize_keyboard: без нього Telegram віддає кнопкам пів екрана на
 * телефоні. is_persistent — щоб вона не ховалась після кожного
 * натискання, це саме той випадок, коли нею користуються постійно.
 */
export function replyKeyboard(role: Role) {
  const rows = isTrainer(role)
    ? [[BTN_SESSIONS], [BTN_SETTINGS, BTN_HELP]]
    : [
      [BTN_TODAY, BTN_YESTERDAY],
      [BTN_WEEK, BTN_REVENUE],
      [BTN_STAFF, BTN_ANALYTICS],
      [BTN_SETTINGS, BTN_HELP],
    ];

  return {
    keyboard: rows.map((row) => row.map((text) => ({ text }))),
    resize_keyboard: true,
    is_persistent: true,
  };
}

/** Прибрати клавіатуру — після /logout вона не має лишатись висіти */
export const removeKeyboard = { remove_keyboard: true };

/* ── Кнопки під звітом ───────────────────────────────────────────────── */

/**
 * Що саме натиснули.
 *
 * `day:0` — сьогодні, `day:1` — вчора, `week:7` / `week:14` — період.
 * Формат навмисно короткий: Telegram обмежує callback_data 64 байтами, і
 * розкладати сюди JSON означало б упертись у межу на рівному місці.
 */
export type Action =
  | { kind: 'day'; offset: number }
  | { kind: 'week'; days: number }
  | { kind: 'staff'; days: number }
  | { kind: 'money'; days: number };

/** Розділи з тим самим перемикачем періоду, що й тижневий звіт */
const PERIODIC = ['week', 'staff', 'money'] as const;

export function parseAction(data: string | undefined): Action | null {
  if (!data) return null;
  const [kind, raw] = data.split(':');
  const n = Number(raw);

  /* Дані приходять від клієнта, тобто можуть бути будь-чим — включно зі
     старою кнопкою з торішнього повідомлення. Межі тут не формальність:
     без них «week:99999» перетворився б на запит по базі за триста років. */
  if (!Number.isInteger(n)) return null;
  if (kind === 'day' && n >= 0 && n <= 31) return { kind: 'day', offset: n };
  /* Періоди кратні тижню, і 28 замість 30 не випадково: довгі відрізки
     графік згортає по сім днів, і при 30 перший стовпчик виходив би з
     двох днів проти семи в решти — тобто читався б як провал, якого не
     було. */
  if (PERIODIC.includes(kind as (typeof PERIODIC)[number]) && (n === 7 || n === 14 || n === 28)) {
    return { kind: kind as 'week' | 'staff' | 'money', days: n };
  }

  return null;
}

/** Кнопки під зведенням дня */
export function dayButtons(offset: number) {
  return {
    inline_keyboard: [[
      offset === 0
        ? { text: '📅 Вчора', callback_data: 'day:1' }
        : { text: '📊 Сьогодні', callback_data: 'day:0' },
      { text: '📈 Тиждень', callback_data: 'week:7' },
      { text: '🔄', callback_data: `day:${offset}` },
    ]],
  };
}

/** Як називається кожен розділ на кнопці переходу */
const SECTION_LABEL = {
  week: '📈 Тиждень',
  staff: '👥 Персонал',
  money: '💰 Виручка',
} as const;

type Section = keyof typeof SECTION_LABEL;

/**
 * Кнопки під звітом розділу: перемикач періоду, переходи в сусідні
 * розділи й оновлення.
 *
 * Перехід зберігає ПЕРІОД: якщо власник дивився чотири тижні виручки й
 * тисне «Персонал», він хоче тих самих чотирьох тижнів. Скидання на
 * тиждень щоразу змушувало б перемикати період наново.
 */
export function periodButtons(section: Section, days: number) {
  const period = [
    { days: 7, label: 'Тиждень' },
    { days: 14, label: '2 тижні' },
    { days: 28, label: '4 тижні' },
  ].map(({ days: d, label }) => ({
    /* Поточний період позначено крапкою: інакше з трьох однакових кнопок
       не видно, на що саме дивишся. */
    text: d === days ? `· ${label} ·` : label,
    callback_data: `${section}:${d}`,
  }));

  const others = (Object.keys(SECTION_LABEL) as Section[])
    .filter((s) => s !== section)
    .map((s) => ({ text: SECTION_LABEL[s], callback_data: `${s}:${days}` }));

  return {
    inline_keyboard: [
      period,
      [...others, { text: '🔄', callback_data: `${section}:${days}` }],
    ],
  };
}

/* ── Синє меню «/» ───────────────────────────────────────────────────── */

const COMMANDS_OWNER = [
  { command: 'analytics', description: 'Детальний звіт по кортах за період або дату' },
  { command: 'today', description: 'Цифри за сьогодні' },
  { command: 'yesterday', description: 'За вчора' },
  { command: 'week', description: 'Тиждень із графіком' },
  { command: 'revenue', description: 'Звідки беруться гроші' },
  { command: 'staff', description: 'Тренери: заняття і гроші' },
  { command: 'help', description: 'Що я вмію' },
  { command: 'settings', description: 'Сповіщення: що приходить і за скільки хвилин' },
  { command: 'newpassword', description: 'Змінити пароль кабінету' },
  { command: 'logout', description: 'Відключити цей чат' },
];

const COMMANDS_TRAINER = [
  { command: 'today', description: 'Ваші заняття на сьогодні' },
  { command: 'help', description: 'Що я вмію' },
  { command: 'settings', description: 'Сповіщення: що приходить і за скільки хвилин' },
  { command: 'newpassword', description: 'Змінити пароль кабінету' },
  { command: 'logout', description: 'Відключити цей чат' },
];

/** Що показує меню незнайомому чату — тільки вхід, більше йому нічого не можна */
export const COMMANDS_GUEST = [
  { command: 'book', description: 'Забронювати корт' },
  { command: 'my', description: 'Мої записи' },
  { command: 'games', description: 'Знайти гру: хто шукає партнерів' },
  { command: 'profile', description: 'Увійти в профіль гравця' },
  { command: 'login', description: 'Увійти: /login пошта пароль' },
  { command: 'help', description: 'Що я вмію' },
];

export const commandsFor = (role: Role) => (isTrainer(role) ? COMMANDS_TRAINER : COMMANDS_OWNER);
