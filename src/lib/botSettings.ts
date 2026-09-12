/**
 * Екран «Сповіщення»: що саме приходить у цей чат і за скільки хвилин.
 *
 * ── Чому окремий екран, а не команди на кожен вимикач ────────────────────
 *
 * Вимикачів пʼять, і командами це було б пʼять назв, які треба памʼятати
 * («а /groups — це нагадування чи список груп?»). Екран показує всі стани
 * одразу: людина бачить, що саме їй приходить, не вмикаючи навмання.
 *
 * Перемальовується на місці (editMessageText), як і звіти: десять
 * натискань не мають лишити десять однакових екранів у стрічці.
 *
 * ── Чому набір рядків залежить від ролі ─────────────────────────────────
 *
 * Тренеру немає чого вимикати нагадування про турніри — їх йому й так не
 * шлють. Показати вимкнений рядок, який нічого не робить, гірше, ніж не
 * показати: людина натисне і вирішить, що бот зламався.
 *
 * Тут — тільки розмітка й розбір натискань. Що з ними робити, вирішує
 * botHandlers; кого сповіщати — lib/remind.ts і lib/notifyBooking.ts.
 */

export type Role = 'OWNER' | 'ADMIN' | 'TRAINER' | string;

/** Рівно ті поля User, які показує екран. */
export type NotifySettings = {
  tgNotifyBookings: boolean;
  tgNotifyTournaments: boolean;
  tgNotifyGroups: boolean;
  tgNotifySessions: boolean;
  tgRemindMinutes: number;
};

const isTrainer = (role: Role) => role === 'TRAINER';

/**
 * Дозволені інтервали нагадування.
 *
 * Список, а не довільне число: по-перше, callback_data приходить від
 * клієнта і «за 900 хвилин» перетворило б нагадування на випадковий спам;
 * по-друге, чотири кнопки — це один дотик, а поле вводу — згадати
 * синтаксис, набрати, помилитись.
 *
 * 60 хвилин зверху не випадково: далі нагадування перестає бути
 * нагадуванням і стає розкладом, а розклад є в /today.
 */
export const LEAD_OPTIONS = [10, 15, 30, 60] as const;

export const isLeadOption = (n: number): boolean =>
  (LEAD_OPTIONS as readonly number[]).includes(n);

/* ── Які рядки бачить ця роль ─────────────────────────────────────────── */

/**
 * Ключ вимикача = імʼя колонки в User.
 *
 * Навмисно: botHandlers пише його в базу напряму, без таблиці відповідності
 * «кнопка -> поле», яку довелось би правити при кожному новому рядку.
 */
export type ToggleKey =
  | 'tgNotifyBookings'
  | 'tgNotifyTournaments'
  | 'tgNotifyGroups'
  | 'tgNotifySessions';

const LABEL: Record<ToggleKey, string> = {
  tgNotifyBookings: 'Нові броні та скасування',
  tgNotifyTournaments: 'Нагадування про турніри',
  tgNotifyGroups: 'Нагадування про групові',
  tgNotifySessions: 'Нагадування про мої заняття',
};

const STAFF_ROWS: ToggleKey[] = [
  'tgNotifyBookings',
  'tgNotifyTournaments',
  'tgNotifyGroups',
];

const TRAINER_ROWS: ToggleKey[] = [
  'tgNotifyBookings',
  'tgNotifySessions',
];

export const rowsFor = (role: Role): ToggleKey[] =>
  (isTrainer(role) ? TRAINER_ROWS : STAFF_ROWS);

/**
 * Чи має ця роль право чіпати цей вимикач.
 *
 * callback_data приходить від клієнта: кнопку можна підробити або натиснути
 * у старому повідомленні, надісланому до зміни ролі. Без перевірки тренер
 * зміг би вимкнути собі те, чого йому й так не шлють, — і потім не
 * зрозуміти, чому екран показує рядок, якого в ньому немає.
 */
export const canToggle = (role: Role, key: ToggleKey): boolean =>
  rowsFor(role).includes(key);

/* ── Розбір натискань ─────────────────────────────────────────────────── */

export type SettingsAction =
  | { kind: 'toggle'; key: ToggleKey }
  | { kind: 'lead'; minutes: number };

/**
 * `ntf:tgNotifyGroups` або `lead:30`.
 *
 * Префікс свій, не спільний із параметрами звітів (`week:7`): інакше стара
 * кнопка під торішнім звітом могла б потрапити в обробник налаштувань.
 */
export function parseSettingsAction(data: string | undefined): SettingsAction | null {
  if (!data) return null;
  const [prefix, raw] = data.split(':');

  if (prefix === 'ntf') {
    return raw in LABEL ? { kind: 'toggle', key: raw as ToggleKey } : null;
  }

  if (prefix === 'lead') {
    const n = Number(raw);
    return Number.isInteger(n) && isLeadOption(n) ? { kind: 'lead', minutes: n } : null;
  }

  return null;
}

/* ── Розмітка ─────────────────────────────────────────────────────────── */

export function settingsText(role: Role, s: NotifySettings): string {
  const lines = [
    '⚙️ <b>Сповіщення</b>',
    '',
    ...rowsFor(role).map((key) => `${s[key] ? '🔔' : '🔕'} ${LABEL[key]}`),
    '',
    `⏰ Нагадування за <b>${s.tgRemindMinutes} хв</b> до початку`,
    '',
    '<i>Натисніть рядок, щоб увімкнути або вимкнути.</i>',
  ];

  /* Найчастіше питання після вимкнення всього — «а бот ще працює?».
     Відповідаємо до того, як його встигнуть поставити. */
  const anyOn = rowsFor(role).some((key) => s[key]);
  if (!anyOn) {
    lines.push('<i>Зараз не приходить нічого. Звіти й /today лишаються.</i>');
  }

  return lines.join('\n');
}

export function settingsKeyboard(role: Role, s: NotifySettings) {
  /* Кожен вимикач окремим рядком: підписи довгі, і по двоє в ряд Telegram
     ріже їх на телефоні до нерозбірливого. */
  const toggles = rowsFor(role).map((key) => [{
    text: `${s[key] ? '🔔' : '🔕'} ${LABEL[key]}`,
    callback_data: `ntf:${key}`,
  }]);

  /* Інтервали в один ряд: вони короткі, і вибір із чотирьох читається
     саме як шкала, а не як чотири різні дії. Поточний позначено крапкою —
     інакше з чотирьох однакових кнопок не видно, на чому стоїш. */
  const lead = LEAD_OPTIONS.map((m) => ({
    text: m === s.tgRemindMinutes ? `· ${m} хв ·` : `${m} хв`,
    callback_data: `lead:${m}`,
  }));

  return { inline_keyboard: [...toggles, lead] };
}
