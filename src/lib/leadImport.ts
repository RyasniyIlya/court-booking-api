import { normalizePhone } from './phone';

/**
 * Мапінг рядка імпорту в поля Lead. Чиста функція без бази — щоб її можна
 * було тестувати на справжніх рядках з вивантаження YouControl
 * (court-booking-web/clean_leads.json) і щоб dryRun та реальний імпорт
 * рахували рівно те саме.
 *
 * Приймаємо і наші назви полів (name, edrpou, phone…), і ключі експорту
 * YouControl («Компанія», «Код», «Телефон»…): оператор може завантажити
 * файл як є, а може підготувати свій.
 */

export type LeadImportData = {
  name: string;
  legalName: string | null;
  edrpou: string | null;
  city: string | null;
  region: string | null;
  address: string | null;
  sport: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  instagram: string | null;
  contactName: string | null;
  contactRole: string | null;
  courtsCount: number | null;
  currentSystem: string | null;
  planInterest: string | null;
  note: string | null;
  priority: string | null;
  marketScore: string | null;
  finScore: string | null;
  revenueYear: bigint | null;
  tags: string[];
  source: string;
};

export type MapResult =
  | { ok: true; data: LeadImportData }
  | { ok: false; error: string };

/* -------------------------------------------------------------------------- */
/* Дрібні утиліти                                                             */
/* -------------------------------------------------------------------------- */

/** Будь-яке значення з файлу -> обрізаний рядок або null. Числа теж рядки. */
export function str(v: unknown, max = 200): string | null {
  if (v == null) return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.slice(0, max);
}

/** Слова без голосних (ФК, СК, ТК, ССК) у реєстрі пишуться капсом — лишаємо. */
const KEEP_UPPER = new Set(['ФК', 'СК', 'ТК', 'ССК', 'КСК', 'ДЮСШ', 'ДЮСК', 'ТОВ', 'ПП', 'ФОП', 'УКР', 'США', 'НВП', 'ФСК']);

function isMostlyUpper(s: string): boolean {
  const letters = s.replace(/[^A-Za-zА-Яа-яІіЇїЄєҐґ]/g, '');
  if (!letters) return false;
  const upper = letters.replace(/[^A-ZА-ЯІЇЄҐ]/g, '').length;
  return upper / letters.length > 0.7;
}

function capWord(w: string): string {
  if (!w) return w;
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/**
 * «ЄМАНОВ ВЛАДИСЛАВ ВІКТОРОВИЧ» -> «Єманов Владислав Вікторович».
 * Дефіс і апостроф не розривають слово: «Кузьмін-Ходаков», «Мар'ян».
 * Рядок, що вже написаний нормальним регістром, не чіпаємо.
 */
export function titleCase(s: string): string {
  if (!isMostlyUpper(s)) return s;
  return s
    .split(' ')
    .map((word) => {
      if (KEEP_UPPER.has(word)) return word;
      if (/^[^A-Za-zА-Яа-яІіЇїЄєҐґ]*$/.test(word)) return word; // цифри, тире
      return word
        .split(/(?<=[-/])/)
        .map(capWord)
        .join('');
    })
    .join(' ');
}

const LEGAL_FORMS_LONG = [
  'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ',
  'ТОВАРИСТВО З ДОДАТКОВОЮ ВІДПОВІДАЛЬНІСТЮ',
  'ПРИВАТНЕ ПІДПРИЄМСТВО',
  'ГРОМАДСЬКА ОРГАНІЗАЦІЯ',
  'ФІЗИЧНА ОСОБА-ПІДПРИЄМЕЦЬ',
  'ФІЗИЧНА ОСОБА - ПІДПРИЄМЕЦЬ',
];
const LEGAL_FORMS_SHORT = ['ТОВ', 'ТзОВ', 'ТЗОВ', 'ПП', 'ФОП', 'ГО', 'ГС', 'КП', 'ПрАТ', 'ПРАТ', 'ПАТ', 'АТ', 'ФГ'];

/**
 * Юридична назва -> назва, як клуб називають люди.
 *
 * З реєстру приходить `ТОВ "ФІТНЕС ЦЕНТР "БЛОКБАСТЕР"` або
 * `СПОРТИВНИЙ КЛУБ "АКВА-СПОРТ"-ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ`
 * (форма — в кінці). Забираємо форму власності з обох країв, лапки всіх
 * видів і, якщо все капсом, робимо Title Case. Якщо після чистки нічого не
 * лишилось — краще показати юрназву як є, ніж порожнє ім'я.
 */
export function deriveName(legalName: string): string {
  let s = legalName.replace(/\s+/g, ' ').trim();

  // Форма в кінці: «…"-ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ»
  for (const form of LEGAL_FORMS_LONG) {
    const re = new RegExp(`[\\s"«»“”„'’-]*${form}\\s*$`, 'i');
    s = s.replace(re, '');
  }
  // Форма на початку: повна або скорочена
  for (const form of LEGAL_FORMS_LONG) {
    const re = new RegExp(`^${form}(?=[\\s"«“„'’-]|$)[\\s-]*`, 'i');
    s = s.replace(re, '');
  }
  // Скорочені форми в реєстрі пишуться капсом — без прапора i, щоб не з'їсти «Гол…».
  const shortRe = new RegExp(`^(?:${LEGAL_FORMS_SHORT.join('|')})(?=[\\s"«“„'’]|$)\\s*`);
  s = s.replace(shortRe, '');

  // Подвійні лапки всіх видів зникають; типографський апостроф зводимо до
  // звичайного («Мар'ян»), а одинарні лапки на краях слова — це вже лапки.
  s = s.replace(/["«»“”„`]/g, '').replace(/[’ʼ]/g, "'");
  s = s.replace(/(^|\s)'+|'+(\s|$)/g, '$1$2').replace(/\s+/g, ' ').replace(/^[\s\-–—]+|[\s\-–—]+$/g, '');

  if (!s) return legalName.replace(/\s+/g, ' ').trim().slice(0, 200);
  return titleCase(s).slice(0, 200);
}

/**
 * Перший номер із поля «+380312641111, +380503716551».
 * Нормалізуємо в E.164; те, що не вдалося розпізнати, не зберігаємо —
 * сміття в phone ламає дедуплікацію по номеру.
 */
export function firstPhone(raw: unknown): string | null {
  const s = str(raw, 300);
  if (!s) return null;
  for (const part of s.split(/[,;\n\r|/]|\s+(?:або|та)\s+/i)) {
    const n = normalizePhone(part.trim());
    if (n) return n.e164;
  }
  return null;
}

function cleanEmail(raw: unknown): string | null {
  const s = str(raw, 300);
  if (!s) return null;
  const first = s.split(/[,;\s]+/)[0].toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(first)) return null;
  return first.slice(0, 200);
}

/**
 * ЄДРПОУ — рядок із цифр. Якщо файл (Excel/JSON) зберіг код числом,
 * провідні нулі вже втрачено: 8-значний код доповнюємо до 8 знаків.
 */
export function cleanEdrpou(raw: unknown): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 12) return null;
  if (typeof raw === 'number' && digits.length < 8) return digits.padStart(8, '0');
  return digits;
}

const KVED_SHORT: Record<string, string> = {
  'діяльність спортивних клубів': 'спортклуб',
  'функціювання спортивних споруд': 'споруди',
  'діяльність фітнес-центрів': 'фітнес',
};

/** Довгий опис КВЕД -> короткий тег для фільтра; невідомий просто скорочуємо. */
export function shortTag(raw: unknown): string | null {
  const s = str(raw, 200);
  if (!s) return null;
  const key = s.toLowerCase();
  return KVED_SHORT[key] ?? key.slice(0, 40);
}

/** Що клуб грає. Кілька видів у назві — «мульти». */
export function guessSport(...texts: (string | null | undefined)[]): string | null {
  const hay = texts.filter(Boolean).join(' ').toLowerCase();
  const found: string[] = [];
  if (/падел|padel/.test(hay)) found.push('падел');
  if (/теніс|tennis/.test(hay)) found.push('теніс');
  if (/сквош|squash/.test(hay)) found.push('сквош');
  if (/бадмінтон|badminton/.test(hay)) found.push('бадмінтон');
  if (found.length === 0) return null;
  return found.length === 1 ? found[0] : 'мульти';
}

function cleanTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;]/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const t = str(item, 40);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function cleanRevenue(raw: unknown): bigint | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return BigInt(Math.round(n));
}

function cleanCourts(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 200) return null;
  return n;
}

function cleanPriority(raw: unknown): string | null {
  const s = str(raw, 5)?.toUpperCase();
  return s === 'A' || s === 'B' || s === 'C' ? s : null;
}

/** Перше непорожнє значення з переліку ключів: наше ім'я, потім YouControl. */
function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v != null && !(typeof v === 'string' && v.trim() === '')) return v;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Головна функція                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Один рядок імпорту -> дані ліда. `priority: null` означає «у рядку не
 * вказано» (для нового ліда підставиться 'B', для наявного не чіпаємо).
 */
export function mapImportRow(raw: unknown, defaultSource = 'youcontrol'): MapResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'NOT_AN_OBJECT' };
  }
  const row = raw as Record<string, unknown>;

  const legalName = str(pick(row, 'legalName', 'Компанія'));
  const explicitName = str(pick(row, 'name'));
  const name = explicitName ?? (legalName ? deriveName(legalName) : null);
  const edrpou = cleanEdrpou(pick(row, 'edrpou', 'Код'));
  const phone = firstPhone(pick(row, 'phone', 'Телефон'));

  // Без назви лід не показати у списку, а без жодного ключа дедуплікації
  // (ЄДРПОУ, телефон) повторний імпорт наплодив би дублікатів.
  if (!name) return { ok: false, error: 'NAME_REQUIRED' };
  if (!edrpou && !phone) return { ok: false, error: 'NO_DEDUPE_KEY' };

  const director = str(pick(row, 'contactName', 'Директор'));
  const contactName = director ? titleCase(director) : null;
  const explicitRole = str(pick(row, 'contactRole'), 100);

  const kved = str(pick(row, 'КВЕД'));
  const sphere = str(pick(row, 'Сфера'));
  const tags = cleanTags(row.tags);
  // «Спортивні організації» стоїть у кожного рядка вибірки — як тег він
  // нічого не відрізняє і лише засмічує фільтр, тому сферу беремо, тільки
  // коли вона інша.
  const sphereTag = sphere && sphere.toLowerCase() !== 'спортивні організації' ? shortTag(sphere) : null;
  for (const t of [shortTag(kved), sphereTag]) {
    if (t && !tags.some((x) => x.toLowerCase() === t)) tags.push(t);
  }

  const sport =
    str(pick(row, 'sport'), 50) ?? guessSport(name, legalName, kved);

  const city = str(pick(row, 'city', 'Місто'), 100);
  const region = str(pick(row, 'region', 'Регіон'), 100);

  return {
    ok: true,
    data: {
      name,
      legalName,
      edrpou,
      city: city ? titleCase(city) : null,
      region: region ? titleCase(region) : null,
      address: str(pick(row, 'address', 'Адреса')),
      sport,
      phone,
      email: cleanEmail(pick(row, 'email', 'Email')),
      website: str(pick(row, 'website', 'Веб-сайт')),
      instagram: str(pick(row, 'instagram')),
      contactName,
      contactRole: explicitRole ?? (contactName ? 'директор' : null),
      courtsCount: cleanCourts(pick(row, 'courtsCount')),
      currentSystem: str(pick(row, 'currentSystem')),
      planInterest: str(pick(row, 'planInterest'), 50),
      note: str(pick(row, 'note', 'Причина'), 2000),
      priority: cleanPriority(pick(row, 'priority', 'Пріоритет')),
      marketScore: str(pick(row, 'marketScore', 'MarketScore'), 20),
      finScore: str(pick(row, 'finScore', 'FinScore'), 20),
      revenueYear: cleanRevenue(pick(row, 'revenueYear', 'Дохід 2025, грн')),
      tags,
      source: str(pick(row, 'source'), 50) ?? defaultSource,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Злиття з наявним лідом                                                     */
/* -------------------------------------------------------------------------- */

/** Поля, які імпорт має право заповнити, якщо в лідa вони порожні. */
const FILLABLE = [
  'legalName', 'edrpou', 'city', 'region', 'address', 'sport', 'phone', 'email',
  'website', 'instagram', 'contactName', 'contactRole', 'courtsCount',
  'currentSystem', 'planInterest', 'note', 'marketScore', 'finScore', 'revenueYear',
] as const;

export type ExistingLead = { tags: string[] } & Partial<Record<(typeof FILLABLE)[number], unknown>>;

function isEmpty(v: unknown): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Що імпорт допише в наявний лід. Тільки порожні поля: етап, пріоритет,
 * джерело, nextAction, вже написана примітка й усе, що поставив оператор,
 * лишаються недоторканими. Теги — лише додаються (union), чужі не видаляємо.
 * Порожній результат означає «нічого нового» — такий рядок рахуємо skipped.
 */
export function buildFillPatch(
  existing: ExistingLead,
  incoming: LeadImportData,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of FILLABLE) {
    const next = incoming[key];
    if (isEmpty(existing[key]) && !isEmpty(next)) patch[key] = next;
  }
  const have = new Set(existing.tags.map((t) => t.toLowerCase()));
  const added = incoming.tags.filter((t) => !have.has(t.toLowerCase()));
  if (added.length) patch.tags = [...existing.tags, ...added].slice(0, 20);
  return patch;
}
