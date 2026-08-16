import 'dotenv/config';
import { randomInt } from 'node:crypto';
import { prisma } from '../src/lib/db';
import {
  createClub,
  ClubExistsError,
  EmailTakenError,
  type NewCourt,
  type Window,
} from '../src/lib/createClub';

/**
 * Заведення клубу з командного рядка. Один запуск = одне впровадження.
 *
 *   npm run club:new -- \
 *     --name "Падел Клуб" \
 *     --slug padel-club \
 *     --email owner@padel.ua \
 *     --courts "Корт 1:450, Корт 2:450, VIP:600" \
 *     --hours 08:00-22:00 \
 *     --weekend 09:00-21:00
 *
 * Пароль не задається у файлі: якщо не передати --password, скрипт згенерує
 * випадковий і покаже один раз. Захардкоджених паролів у репозиторії немає.
 */

const HELP = `
Заведення нового клубу.

  npm run club:new -- --name "Назва" --slug slug --email owner@club.ua --courts "Корт 1:450"

Обовʼязкові:
  --name     Назва клубу, як її бачить гравець
  --slug     Латиниця, цифри, дефіс. Стає адресою: /api/public/clubs/<slug>
  --email    Пошта власника для входу в кабінет
  --courts   Через кому, у форматі "Назва:ціна". Ціна — гривні за годину.
             Приклад: "Корт 1:450, Корт 2:450, VIP корт:600"

Необовʼязкові:
  --hours    Робочі години Пн–Пт. За замовчуванням 08:00-22:00
  --weekend  Робочі години Сб–Нд. За замовчуванням дорівнює --hours
  --tz       IANA-таймзона. За замовчуванням Europe/Kyiv
  --phone    Телефон адміністратора. Показується у шапці віджета
  --address  Адреса клубу для шапки віджета
  --logo     https-URL логотипа для шапки віджета
  --password Пароль власника. Без нього — згенерується випадковий
  --slot     Крок сітки у хвилинах. За замовчуванням 60
  --lead     За скільки хвилин до старту ще можна бронювати. За замовчуванням 60
  --horizon  На скільки днів уперед відкрита сітка. За замовчуванням 14
`.trim();

type Args = Record<string, string | true>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function int(args: Args, key: string, fallback: number): number {
  const v = str(args, key);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) die(`--${key} має бути числом, а не "${v}"`);
  return n;
}

function die(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

/** '08:00-22:00' -> хвилини від опівночі */
function parseWindow(raw: string, key: string): Window {
  const m = raw.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) die(`--${key} має бути у форматі 08:00-22:00, а не "${raw}"`);

  const openMinute = Number(m[1]) * 60 + Number(m[2]);
  const closeMinute = Number(m[3]) * 60 + Number(m[4]);

  if (Number(m[2]) > 59 || Number(m[4]) > 59) die(`--${key}: хвилини поза межами`);
  if (openMinute >= closeMinute) die(`--${key}: відкриття має бути раніше за закриття`);
  if (closeMinute > 1680) die(`--${key}: закриття не може бути пізніше 28:00`);

  return { openMinute, closeMinute };
}

/** 'Корт 1:450, VIP:600' -> корти з цінами в копійках */
function parseCourts(raw: string): NewCourt[] {
  const courts = raw
    .split(',')
    .map((chunk, i) => {
      const at = chunk.lastIndexOf(':');
      if (at === -1) die(`Корт "${chunk.trim()}" без ціни. Формат: "Назва:450"`);

      const name = chunk.slice(0, at).trim();
      const priceRaw = chunk.slice(at + 1).trim().replace(',', '.');
      const grn = Number.parseFloat(priceRaw);

      if (!name) die(`Корт без назви у "${chunk.trim()}"`);
      if (!Number.isFinite(grn) || grn < 0) die(`Ціна "${priceRaw}" для корту "${name}" не число`);

      return { name, pricePerHour: Math.round(grn * 100), sortOrder: i + 1 };
    });

  if (courts.length === 0) die('Потрібен хоча б один корт');
  return courts;
}

/** Без схожих символів: 0/O, 1/l/I. Пароль часто диктують у слухавку. */
const ABC = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';

function genPassword(len = 14): string {
  return Array.from({ length: len }, () => ABC[randomInt(ABC.length)]).join('');
}

const hrn = (kop: number) => `${(kop / 100).toLocaleString('uk-UA')} грн`;
const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || Object.keys(args).length === 0) {
    console.log(`\n${HELP}\n`);
    return;
  }

  const name = str(args, 'name') ?? die('Не вказано --name');
  const slug = (str(args, 'slug') ?? die('Не вказано --slug')).toLowerCase();
  const email = str(args, 'email') ?? die('Не вказано --email');
  const courtsRaw = str(args, 'courts') ?? die('Не вказано --courts');

  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) {
    die(`--slug "${slug}": лише латиниця, цифри й дефіс, від 3 до 50 символів`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    die(`--email "${email}" не схожий на пошту`);
  }

  const weekday = parseWindow(str(args, 'hours') ?? '08:00-22:00', 'hours');
  const weekend = args.weekend ? parseWindow(str(args, 'weekend')!, 'weekend') : weekday;
  const courts = parseCourts(courtsRaw);

  // Логотип віддається у віджет як src картинки. Дозволяємо тільки https:
  // http зламає замок у браузері на сайті клубу, data: роздує відповідь API.
  const logoUrl = str(args, 'logo');
  if (logoUrl && !/^https:\/\/\S+$/.test(logoUrl)) {
    die(`--logo має бути https-посиланням, а не "${logoUrl}"`);
  }

  const generated = !str(args, 'password');
  const password = str(args, 'password') ?? genPassword();
  if (password.length < 8) die('--password коротший за 8 символів');

  try {
    const { club, courts: created } = await createClub({
      name,
      slug,
      timezone: str(args, 'tz') ?? 'Europe/Kyiv',
      phone: str(args, 'phone') ?? null,
      address: str(args, 'address') ?? null,
      logoUrl: logoUrl ?? null,
      slotMinutes: int(args, 'slot', 60),
      leadTimeMinutes: int(args, 'lead', 60),
      horizonDays: int(args, 'horizon', 14),
      weekday,
      weekend,
      courts,
      ownerEmail: email,
      ownerPassword: password,
    });

    console.log(`
  ✓ Клуб створено

    Назва      ${club.name}
    Адреса     /api/public/clubs/${club.slug}
    Таймзона   ${club.timezone}
    Пн–Пт      ${hhmm(weekday.openMinute)}–${hhmm(weekday.closeMinute)}
    Сб–Нд      ${hhmm(weekend.openMinute)}–${hhmm(weekend.closeMinute)}
    Крок       ${club.slotMinutes} хв

    Корти
${created.map((c) => `      · ${c.name} — ${hrn(c.pricePerHour)}/год`).join('\n')}

  Доступ до кабінету

    Пошта      ${email}
    Пароль     ${password}
${generated ? '\n  Пароль згенеровано і показано один раз — збережіть його зараз.\n  У базі лежить лише хеш, відновити не вийде.\n' : ''}`);
  } catch (e) {
    if (e instanceof ClubExistsError) {
      die(`Клуб "${slug}" уже існує. Оберіть інший --slug.`);
    }
    if (e instanceof EmailTakenError) {
      die(`Пошта ${email} уже зайнята. Оберіть іншу --email.`);
    }
    throw e;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
