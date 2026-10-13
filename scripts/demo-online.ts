/**
 * Демо-світ для онлайн-бази (ПЛАН-ДЕМО-ОНЛАЙН.md): 3 демо-клуби, федерація, партнер, гравці, турніри.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/demo-online.ts [--dry-run|--reset|--cleanup]
 *
 *   (без прапорців)  засіяти; якщо демо-клуби / partner@demo.test уже є — повідомлення й вихід 1
 *   --reset          спершу очистка демо-даних, потім сід (в одній транзакції)
 *   --cleanup        лише видалити демо-дані
 *   --dry-run        виконати все в ОДНІЙ транзакції й відкотити; у базу нічого не пишеться
 *                    (можна поєднувати з --reset / --cleanup)
 *
 * Уся робота — одна інтерактивна транзакція: збій посередині не залишає напівзасіяних даних.
 * Чіпаються лише: (а) федерація squash-demo (пароль federation@demo.test + підтверджені
 * партнерства з демо-клубами), (б) дані, які створює цей скрипт. Решта бази недоторкана.
 * Плани (Plan) беруться наявні за кодом base/team/pro; SellerProfile, ClubInvoice, PartnerAct,
 * PartnerPayout, PaymentReceipt НЕ створюються.
 *
 * Усі демо-сутності позначені: слаги demo-*, пошти *@demo.test, телефони +38000000NNNN,
 * назви з «· ДЕМО». Пароль для всіх демо-входів: DemoOnly-2026!
 */
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { Prisma, PrismaClient } from '@prisma/client';

import { hashPassword } from '../src/lib/passwordHash';
import { normalizePhone } from '../src/lib/phone';
import { LEGAL_VERSION } from '../src/lib/legal';
import { buildBracket, planPropagation, applyPatches, type BracketMatch, type SetScore } from '../src/lib/tournamentBracket';
import { buildTournamentSettings, isSetComplete, type TournamentSettings } from '../src/lib/sportRules';
import { tournamentTitle } from '../src/lib/tournamentPay';
import { finalizeTournament } from '../src/lib/tournamentRating';

/* ═══════════════════════════ Константи й маркери ═══════════════════════════ */

const DEMO_PASSWORD = 'DemoOnly-2026!';
const TZ = 'Europe/Kyiv';
const FED_CODE = 'squash-demo';
const FED_NAME = 'Федерація сквошу · ДЕМО';
const FED_EMAIL = 'federation@demo.test';
const PARTNER_EMAIL = 'partner@demo.test';
const PHONE_PREFIX = '+38000000';
const SLUGS = ['demo-squash-kyiv', 'demo-squash-lviv', 'demo-squash-dnipro'] as const;
const WEB = 'https://court-booking-webb.vercel.app';
const ACC: Record<string, string> = { CASH: 'Каса', CARD: 'Термінал', TRANSFER: 'Рахунок клубу' };

type Tx = Prisma.TransactionClient;

class DryRunRollback extends Error {
  constructor(public readonly report: Report) { super('DRY_RUN_ROLLBACK'); }
}
export class PreflightError extends Error {}

export type Report = {
  counts: Record<string, number>;
  logins: { role: string; email: string; where: string }[];
  urls: string[];
  notes: string[];
  deleted?: Record<string, number>;
};

const ph = (n: number) => `${PHONE_PREFIX}${String(n).padStart(4, '0')}`;
const uuid = () => randomUUID();
const chunks = <T>(a: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const log = (...a: unknown[]) => console.log(...a);

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const rint = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
function pickW<T>(rng: Rng, items: T[], weights: number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r < 0) return items[i]; }
  return items[items.length - 1];
}

/* ═════════════════════════════ Вхідні дані (вигадані) ═════════════════════════════ */

type Person = { name: string; g: 'M' | 'F' };
const KYIV_PEOPLE: Person[] = [
  { name: 'Олег Коваленко', g: 'M' }, { name: 'Марія Шевчук', g: 'F' }, { name: 'Дмитро Бондар', g: 'M' }, { name: 'Анна Мельник', g: 'F' },
  { name: 'Сергій Ткаченко', g: 'M' }, { name: 'Катерина Кравченко', g: 'F' }, { name: 'Володимир Олійник', g: 'M' }, { name: 'Наталя Лисенко', g: 'F' },
  { name: 'Богдан Савчук', g: 'M' }, { name: 'Юлія Руденко', g: 'F' }, { name: 'Павло Мороз', g: 'M' }, { name: 'Тетяна Гончар', g: 'F' },
  { name: 'Роман Василенко', g: 'M' }, { name: 'Оксана Паламарчук', g: 'F' }, { name: 'Іван Кушнір', g: 'M' }, { name: 'Світлана Білик', g: 'F' },
  { name: 'Артем Яременко', g: 'M' }, { name: 'Леся Клименко', g: 'F' }, { name: 'Тарас Демʼяненко', g: 'M' }, { name: 'Віра Степаненко', g: 'F' },
  { name: 'Денис Харченко', g: 'M' }, { name: 'Ольга Сидоренко', g: 'F' }, { name: 'Микита Пономаренко', g: 'M' }, { name: 'Єва Гриценко', g: 'F' },
];
/** Клієнти Львова: 4 спільні з Києвом (індекси 4–7 київського списку) + 10 своїх. */
const SHARED_KYIV_IDX = [4, 5, 6, 7];
const LVIV_OWN: Person[] = [
  { name: 'Андрій Гнатюк', g: 'M' }, { name: 'Софія Яворська', g: 'F' }, { name: 'Остап Левицький', g: 'M' }, { name: 'Ірина Бойко', g: 'F' },
  { name: 'Мирослав Стадник', g: 'M' }, { name: 'Олександра Тарнавська', g: 'F' }, { name: 'Юрій Процюк', g: 'M' }, { name: 'Христина Данилів', g: 'F' },
  { name: 'Назар Кульчицький', g: 'M' }, { name: 'Марта Гавриляк', g: 'F' },
];
const DNIPRO_PEOPLE: Person[] = [
  { name: 'Максим Зінченко', g: 'M' }, { name: 'Дарина Литвиненко', g: 'F' }, { name: 'Валерій Шаповал', g: 'M' }, { name: 'Аліна Коротун', g: 'F' },
  { name: 'Георгій Мартинюк', g: 'M' }, { name: 'Поліна Рогоза', g: 'F' }, { name: 'Едуард Пилипенко', g: 'M' }, { name: 'Злата Присяжна', g: 'F' },
  { name: 'Кирило Сердюк', g: 'M' }, { name: 'Діана Лозовська', g: 'F' },
];

/** Телефони. Київ 0001–0024, Львів 0101–0110 (+4 спільні з Києвом), Дніпро 0201–0210. */
const KYIV_PHONES = KYIV_PEOPLE.map((_, i) => ph(1 + i));
const LVIV_PHONES = [...SHARED_KYIV_IDX.map(i => KYIV_PHONES[i]), ...LVIV_OWN.map((_, i) => ph(101 + i))];
const LVIV_PEOPLE: Person[] = [...SHARED_KYIV_IDX.map(i => KYIV_PEOPLE[i]), ...LVIV_OWN];
/** Гравці Львова: 4 спільні + 4 власні (перші 4 з LVIV_OWN). */
const LVIV_PLAYER_PHONES = [...SHARED_KYIV_IDX.map(i => KYIV_PHONES[i]), ...[101, 102, 103, 104].map(ph)];
const DNIPRO_PHONES = DNIPRO_PEOPLE.map((_, i) => ph(201 + i));

/** Гравці федерації: Київ 0–11 (12), Львів власні 0–3 (4), Дніпро 0–1 (2) = 18 гравців; 4 спільні Київ+Львів. */
type PlayerMeta = { phone: string; person: Person; skill: string; age: string; bio: string | null; birthYear: number };
const KYIV_SKILL = ['A', 'B+', 'B', 'B', 'B+', 'C', 'C', 'B', 'A', 'B+', 'C', 'B'];
const KYIV_AGE = ['Дорослі', 'Дорослі', '40+', 'Дорослі', 'Дорослі', 'Дорослі', 'U19', 'Дорослі', '40+', 'Дорослі', 'Дорослі', 'Дорослі'];
const BIOS = [
  'Грає у сквош понад п’ять років. Улюблений удар — дроп у передню стінку.',
  'Прийшов зі швидкого тенісу, швидко освоїв подачу та гру по бокових стінах.',
  'Тренується тричі на тиждень, готується до першого офіційного турніру.',
  'Захоплюється командними форматами, грає за збірну клубу.',
  null, 'Виступає у категорії 40+, любить довгі розиграші.',
];
const PLAYERS: PlayerMeta[] = [
  ...KYIV_PEOPLE.slice(0, 12).map((p, i): PlayerMeta => ({ phone: KYIV_PHONES[i], person: p, skill: KYIV_SKILL[i], age: KYIV_AGE[i], bio: BIOS[i % BIOS.length], birthYear: 1985 + (i * 3) % 14 })),
  ...LVIV_OWN.slice(0, 4).map((p, i): PlayerMeta => ({ phone: ph(101 + i), person: p, skill: ['B+', 'C', 'B', 'C'][i], age: ['Дорослі', 'Дорослі', '40+', 'U19'][i], bio: BIOS[(i + 2) % BIOS.length], birthYear: [1992, 1996, 1979, 2008][i] })),
  ...DNIPRO_PEOPLE.slice(0, 2).map((p, i): PlayerMeta => ({ phone: ph(201 + i), person: p, skill: ['B', 'C'][i], age: 'Дорослі', bio: BIOS[(i + 4) % BIOS.length], birthYear: [1990, 1994][i] })),
];
const STRENGTH_BY_SKILL: Record<string, number> = { A: 1600, 'B+': 1500, B: 1420, C: 1330 };

/* ═════════════════════════════ Опис клубів ═════════════════════════════ */

type ClubKey = 'kyiv' | 'lviv' | 'dnipro';
interface GroupSpec { title: string; dayOffset: number; hour: number; court: number; seats: number; capacity: number; price: number; paid: number }
interface ClubSpec {
  key: ClubKey; slug: string; name: string; city: string; address: string; phone: string; email: string; brandColor: string;
  planCode: 'pro' | 'team' | 'base';
  courts: { name: string; price: number }[];
  people: Person[]; phones: string[];
  staff: { role: 'OWNER' | 'ADMIN' | 'TRAINER' | 'ACCOUNTANT'; email: string; name: string }[];
  trainer?: { name: string; phone: string; price: number; note: string };
  histDays: number; withTomorrow: boolean; fill: number;
  passes: boolean; promo: boolean; inventory: boolean; expenses: [string, string, number][] | null;
  groups: GroupSpec[];
  partnerAttachedDaysAgo: number; shareStats: boolean;
  seed: number; legalCode: string;
}

const SPECS: ClubSpec[] = [
  {
    key: 'kyiv', slug: SLUGS[0], name: 'Squash Arena Kyiv · ДЕМО', city: 'Київ', address: 'вул. Вигадана, 12, Київ (демо)',
    phone: ph(10), email: 'club.kyiv@demo.test', brandColor: '#1f7a5c', planCode: 'pro',
    courts: [{ name: 'Корт 1', price: 45000 }, { name: 'Корт 2', price: 45000 }, { name: 'Корт 3', price: 45000 }, { name: 'Корт 4', price: 50000 }, { name: 'Центральний корт', price: 70000 }],
    people: KYIV_PEOPLE, phones: KYIV_PHONES,
    staff: [
      { role: 'OWNER', email: 'owner@demo.test', name: 'Олена Демченко (власник)' },
      { role: 'ADMIN', email: 'admin@demo.test', name: 'Максим Адмінько (адміністратор)' },
      { role: 'TRAINER', email: 'trainer@demo.test', name: 'Андрій Тренер' },
      { role: 'ACCOUNTANT', email: 'accountant@demo.test', name: 'Ірина Бухгалтер' },
    ],
    trainer: { name: 'Андрій Тренер', phone: ph(901), price: 60000, note: 'Індивідуальні заняття зі сквошу' },
    histDays: 30, withTomorrow: true, fill: 0.42, passes: true, promo: true, inventory: true,
    expenses: [['RENT', 'Оренда приміщення', 8500000], ['SALARY', 'Зарплата адміністраторів', 6000000], ['UTILITIES', 'Комунальні послуги', 1200000],
      ['MARKETING', 'Реклама (Instagram)', 800000], ['BANK_FEE', 'Комісія еквайрингу', 150000], ['TAX', 'Єдиний податок + ЄСВ', 1100000], ['EQUIPMENT', 'М’ячі та ракетки', 350000]],
    groups: [
      { title: 'Група новачків', dayOffset: 1, hour: 17, court: 3, seats: 4, capacity: 6, price: 15000, paid: 3 },
      { title: 'Вечірній спаринг', dayOffset: -3, hour: 19, court: 3, seats: 5, capacity: 6, price: 15000, paid: 5 },
      { title: 'Група новачків', dayOffset: -10, hour: 18, court: 3, seats: 6, capacity: 6, price: 15000, paid: 6 },
    ],
    partnerAttachedDaysAgo: 150, shareStats: true, seed: 101, legalCode: '3000000011',
  },
  {
    key: 'lviv', slug: SLUGS[1], name: 'Lviv Squash Club · ДЕМО', city: 'Львів', address: 'вул. Придумана, 5, Львів (демо)',
    phone: ph(20), email: 'club.lviv@demo.test', brandColor: '#b5532a', planCode: 'team',
    courts: [{ name: 'Корт 1', price: 38000 }, { name: 'Корт 2', price: 38000 }, { name: 'Корт 3', price: 42000 }],
    people: LVIV_PEOPLE.concat([]), phones: LVIV_PHONES,
    staff: [
      { role: 'OWNER', email: 'owner.lviv@demo.test', name: 'Роман Галицький (власник)' },
      { role: 'ADMIN', email: 'admin.lviv@demo.test', name: 'Соломія Адмін (адміністратор)' },
    ],
    trainer: { name: 'Тарас Левицький', phone: ph(902), price: 50000, note: 'Дитячі та дорослі групи' },
    histDays: 14, withTomorrow: true, fill: 0.32, passes: false, promo: false, inventory: false,
    expenses: [['RENT', 'Оренда приміщення', 4200000], ['SALARY', 'Зарплата адміністратора', 3000000], ['UTILITIES', 'Комунальні послуги', 600000], ['MARKETING', 'Реклама', 300000]],
    groups: [
      { title: 'Ранкова група', dayOffset: 1, hour: 18, court: 1, seats: 3, capacity: 6, price: 12000, paid: 2 },
      { title: 'Група початківців', dayOffset: -4, hour: 19, court: 1, seats: 4, capacity: 6, price: 12000, paid: 4 },
    ],
    partnerAttachedDaysAgo: 90, shareStats: true, seed: 202, legalCode: '3000000012',
  },
  {
    key: 'dnipro', slug: SLUGS[2], name: 'Dnipro Squash · ДЕМО', city: 'Дніпро', address: 'просп. Уявний, 7, Дніпро (демо)',
    phone: ph(30), email: 'club.dnipro@demo.test', brandColor: '#2e5aa8', planCode: 'base',
    courts: [{ name: 'Корт 1', price: 32000 }, { name: 'Корт 2', price: 32000 }],
    people: DNIPRO_PEOPLE, phones: DNIPRO_PHONES,
    staff: [{ role: 'OWNER', email: 'owner.dnipro@demo.test', name: 'Віталій Дніпров (власник)' }],
    histDays: 7, withTomorrow: false, fill: 0.32, passes: false, promo: false, inventory: false, expenses: null, groups: [],
    partnerAttachedDaysAgo: 10, shareStats: false, seed: 303, legalCode: '3000000013',
  },
];

/* ═════════════════════════════ Планувальник зайнятості ═════════════════════════════ */

class Occ {
  private m = new Map<string, [number, number][]>();
  free(key: string, s: number, e: number) { return !(this.m.get(key) ?? []).some(([a, b]) => s < b && a < e); }
  take(key: string, s: number, e: number) { const l = this.m.get(key) ?? []; l.push([s, e]); this.m.set(key, l); }
}

type Pay = 'CASH' | 'CARD' | 'TRANSFER' | 'ONLINE' | null;
interface Planned {
  id: string; court: number; start: DateTime; dur: number; cust: number; pay: Pay; trainer: boolean; cancelled: boolean; dayOffset: number;
}

/* ═════════════════════════════ Очистка ═════════════════════════════ */

async function cleanup(tx: Tx): Promise<Record<string, number>> {
  const del: Record<string, number> = {};
  const add = (k: string, n: number) => { if (n) del[k] = (del[k] ?? 0) + n; };

  const clubs = await tx.club.findMany({ where: { slug: { in: [...SLUGS] } }, select: { id: true } });
  const clubIds = clubs.map(c => c.id);
  const fed = await tx.federation.findUnique({ where: { code: FED_CODE }, select: { id: true } });
  const players = await tx.player.findMany({
    where: { phone: { startsWith: PHONE_PREFIX }, OR: [{ federationId: null }, ...(fed ? [{ federationId: fed.id }] : [])] },
    select: { id: true },
  });
  const playerIds = players.map(p => p.id);
  const partner = await tx.partner.findUnique({ where: { email: PARTNER_EMAIL }, select: { id: true } });

  if (partner) {
    const foreign = await tx.club.count({ where: { partnerId: partner.id, slug: { notIn: [...SLUGS] } } });
    if (foreign) throw new PreflightError(`Партнер ${PARTNER_EMAIL} привʼязаний до недемо-клубів (${foreign}) — очистка зупинена.`);
  }
  if (playerIds.length) {
    const foreignEntries = await tx.tournamentEntry.count({
      where: { OR: [{ playerId: { in: playerIds } }, { partnerPlayerId: { in: playerIds } }], booking: { clubId: { notIn: clubIds } } },
    });
    if (foreignEntries) throw new PreflightError(`Демо-гравці беруть участь у ${foreignEntries} записах турнірів недемо-клубів — очистка зупинена.`);
  }

  const inClubs = clubIds.length ? { in: clubIds } : { in: [] as string[] };
  const inPlayers = playerIds.length ? { in: playerIds } : { in: [] as string[] };

  /* 1. Федеративні/клубні рейтинги й журнал (Restrict на Player/Club): реверсали → решта. */
  const rcWhere: Prisma.RatingChangeWhereInput = { OR: [{ clubId: inClubs }, { playerId: inPlayers }, { match: { clubId: inClubs } }] };
  /* RatingChange — незмінний журнал (тригер rating_change_append_only забороняє UPDATE/DELETE), а на Player/Club він
     посилається через RESTRICT. Скрипт цей захист НЕ обходить: якщо в базі такий тригер є й демо-рядки журналу існують
     (після фіналізації турнірів), безпечно прибрати гравців/клуби неможливо — очистка зупиняється, транзакція відкочується. */
  try {
    add('RatingChange (reversals)', (await tx.ratingChange.deleteMany({ where: { AND: [rcWhere, { reversesId: { not: null } }] } })).count);
    add('RatingChange', (await tx.ratingChange.deleteMany({ where: rcWhere })).count);
  } catch (e) {
    if (/append-only/i.test(String((e as Error)?.message))) {
      throw new PreflightError('Очистка неможлива: журнал RatingChange append-only (тригер rating_change_append_only), а в ньому є демо-записи '
        + '(рейтинги фіналізованих турнірів); Player/Club посилаються на нього через RESTRICT. Скрипт цей захист не обходить — '
        + 'прибрати такі записи може лише власник БД свідомим окремим кроком. Нічого не змінено.');
    }
    throw e;
  }
  add('FederationPlayerRating', (await tx.federationPlayerRating.deleteMany({ where: { playerId: inPlayers } })).count);
  add('ClubPlayerRating', (await tx.clubPlayerRating.deleteMany({ where: { OR: [{ clubId: inClubs }, { playerId: inPlayers }] } })).count);
  add('TournamentClub', (await tx.tournamentClub.deleteMany({ where: { OR: [{ clubId: inClubs }, { booking: { clubId: inClubs } }] } })).count);
  /* 2. Каса й прокат (Restrict/NoAction на Club/Booking/Customer): повернення → оплати. */
  add('BookingLedgerEntry (refunds)', (await tx.bookingLedgerEntry.deleteMany({ where: { clubId: inClubs, originalId: { not: null } } })).count);
  add('BookingLedgerEntry', (await tx.bookingLedgerEntry.deleteMany({ where: { clubId: inClubs } })).count);
  add('CustomerReward', (await tx.customerReward.deleteMany({ where: { clubId: inClubs } })).count);
  add('BookingRental', (await tx.bookingRental.deleteMany({ where: { clubId: inClubs } })).count);
  /* 3. Партнерства федерації лише ДЕМО-клубів (squash-arena / racket-demo не чіпаємо). */
  add('ClubFederation', (await tx.clubFederation.deleteMany({ where: { clubId: inClubs } })).count);
  /* 4. Ліди партнера (SetNull на Partner, але це наші демо-ліди). */
  if (partner) add('Lead', (await tx.lead.deleteMany({ where: { partnerId: partner.id } })).count);
  /* 5. Клуби: Cascade прибирає корти, броні, оплати, місця, турнірні матчі/учасників, клієнтів, персонал тощо. */
  if (clubIds.length) {
    add('Booking (cascade)', await tx.booking.count({ where: { clubId: inClubs } }));
    add('Customer (cascade)', await tx.customer.count({ where: { clubId: inClubs } }));
    add('User (cascade)', await tx.user.count({ where: { clubId: inClubs } }));
    add('Club', (await tx.club.deleteMany({ where: { id: inClubs } })).count);
  }
  /* 6. Гравці (усі Restrict-посилання вже знято). */
  if (playerIds.length) add('Player', (await tx.player.deleteMany({ where: { id: inPlayers } })).count);
  /* 7. Партнер (Cascade на виплати/акти/заявки; клуби вже видалені). */
  if (partner) add('Partner', (await tx.partner.deleteMany({ where: { id: partner.id } })).count);
  return del;
}

/* ═════════════════════════════ Preflight ═════════════════════════════ */

async function preflight(tx: Tx) {
  const clubs = await tx.club.findMany({ where: { slug: { in: [...SLUGS] } }, select: { slug: true } });
  const partner = await tx.partner.findUnique({ where: { email: PARTNER_EMAIL }, select: { id: true } });
  if (clubs.length || partner) {
    throw new PreflightError(`Демо-дані вже існують (${[...clubs.map(c => c.slug), ...(partner ? [PARTNER_EMAIL] : [])].join(', ')}). `
      + 'Запустіть з --reset (очистка + сід) або --cleanup.');
  }
  const emails = SPECS.flatMap(s => s.staff.map(u => u.email));
  const taken = await tx.user.findMany({ where: { email: { in: emails } }, select: { email: true } });
  if (taken.length) throw new PreflightError(`Пошти персоналу вже зайняті поза демо-клубами: ${taken.map(t => t.email).join(', ')}. Автоматично не видаляю.`);
  const phones = await tx.player.count({ where: { phone: { startsWith: PHONE_PREFIX } } });
  if (phones) throw new PreflightError(`Є гравці з телефонами ${PHONE_PREFIX}…, що не відповідають критерію очистки (інша федерація). Автоматично не видаляю.`);
}

/* ═════════════════════════════ Симуляція турнірів ═════════════════════════════ */

function genSets(rng: Rng, winnerIsA: boolean, setsToWin: number, ptw: number, settings: TournamentSettings): SetScore[] {
  const loserSets = setsToWin >= 3 ? pickW(rng, [0, 1, 2], [25, 35, 40]) : pickW(rng, [0, 1], [55, 45]);
  const seq: boolean[] = [];
  for (let i = 0; i < setsToWin; i++) seq.push(true);
  for (let i = 0; i < loserSets; i++) seq.push(false);
  // перемішуємо, але останній сет виграє переможець матчу
  for (let i = seq.length - 2; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [seq[i], seq[j]] = [seq[j], seq[i]]; }
  const lastTrue = seq.lastIndexOf(true);
  if (lastTrue !== seq.length - 1) { [seq[lastTrue], seq[seq.length - 1]] = [seq[seq.length - 1], seq[lastTrue]]; }
  return seq.map(winnerWinsSet => {
    const extended = rng() < 0.18;
    const lo = extended ? ptw - 1 + rint(rng, 0, 2) : pickW(rng, [1, 2, 3, 4, 5, 6, 7, 8, 9], [3, 5, 7, 9, 10, 10, 9, 8, 6]);
    const hi = extended ? lo + 2 : ptw;
    const setWinnerIsA = winnerWinsSet ? winnerIsA : !winnerIsA;
    const s: SetScore = setWinnerIsA ? { a: hi, b: lo } : { a: lo, b: hi };
    if (!isSetComplete('SQUASH', settings, s.a, s.b)) throw new Error(`Некоректний сет ${s.a}:${s.b}`);
    return s;
  });
}

type MatchMeta = { startedAt: Date | null; finishedAt: Date | null; scheduledAt: Date | null; courtId: string | null; version: number };

function playMatches(a: {
  matches: BracketMatch[]; strength: Map<string, number>; thirdPlace: boolean; rng: Rng;
  setsToWin: number; ptw: number; settings: TournamentSettings; maxRound: number; t0: DateTime; stepMin: number; courtId: string;
}): Map<string, MatchMeta> {
  const meta = new Map<string, MatchMeta>();
  const order = [...a.matches].sort((x, y) => x.round - y.round || x.slot - y.slot);
  let k = 0;
  for (const m of order) {
    if (m.round > a.maxRound) break;
    if (m.status !== 'PENDING' || !m.entryAId || !m.entryBId) continue;
    const sa = a.strength.get(m.entryAId) ?? 1300, sb = a.strength.get(m.entryBId) ?? 1300;
    const pA = 1 / (1 + 10 ** ((sb - sa) / 400));
    const winA = a.rng() < 0.15 + 0.7 * pA;
    const winnerId = winA ? m.entryAId : m.entryBId, loserId = winA ? m.entryBId : m.entryAId;
    m.sets = genSets(a.rng, winA, a.setsToWin, a.ptw, a.settings);
    m.winnerEntryId = winnerId;
    m.status = 'DONE';
    const fin = a.t0.plus({ minutes: (k + 1) * a.stepMin + rint(a.rng, 0, 6) });
    meta.set(m.id, { startedAt: fin.minus({ minutes: 24 }).toJSDate(), finishedAt: fin.toJSDate(), scheduledAt: fin.minus({ minutes: 35 }).toJSDate(), courtId: a.courtId, version: 1 });
    applyPatches(a.matches, planPropagation(a.matches, m.id, winnerId, loserId, a.thirdPlace).patches);
    k++;
  }
  return meta;
}

interface TournamentSpec {
  scope: 'FEDERATION' | 'CLUB';
  clubId: string; courtId: string; courtIdx: number; title: string; description: string;
  start: DateTime; end: DateTime; capacity: number; rated: boolean;
  setsToWin: number; ptw: number; thirdPlace: boolean;
  /** DRAFT — лише учасники; RUNNING — сітка зі зіграними раундами ≤ playRounds; FINISHED — усе зіграно й нараховано рейтинг. */
  status: 'DRAFT' | 'RUNNING' | 'FINISHED';
  playRounds?: number;
  entries: { playerId: string; name: string; customerId?: string | null; strength: number }[];
  federationId?: string; code?: string; createdBy: string; finalizeActor?: string; rng: Rng;
  /** Для RUNNING: стан півфіналів після зіграних раундів. */
  liveSemi?: { liveSlot: number; scheduledSlot: number; now: DateTime };
}

async function createTournament(tx: Tx, t: TournamentSpec, report: Report): Promise<string> {
  const built = buildTournamentSettings('SQUASH', { settings: { teamSize: 1, setsToWin: t.setsToWin, pointsToWin: t.ptw } });
  if (!built.ok || !built.settings) throw new Error(`Налаштування турніру: ${built.ok ? 'null' : built.error}`);
  const settings = built.settings;
  const bookingId = uuid();
  const pastCreatedAt = t.start.toMillis() < Date.now() ? t.start.minus({ days: 21 }).toJSDate() : undefined;
  const common = {
    id: bookingId, clubId: t.clubId, courtId: t.courtId, title: tournamentTitle(t.title), capacity: t.capacity,
    startTime: t.start.toJSDate(), endTime: t.end.toJSDate(), status: 'CONFIRMED' as const, source: 'ADMIN' as const,
    priceTotal: 0, pricePerSeat: 0, listPrice: 0,
    tournamentSport: 'SQUASH' as const, tournamentTeamSize: 1, tournamentSetsToWin: built.setsToWin, tournamentSettings: settings as unknown as Prisma.InputJsonValue,
    tournamentDescription: t.description, tournamentFormat: 'SINGLE_ELIM',
    createdBy: t.createdBy, confirmedBy: t.createdBy, confirmedAt: pastCreatedAt ?? new Date(),
    ...(pastCreatedAt ? { createdAt: pastCreatedAt } : {}),
  };
  const startStatus = t.status === 'DRAFT' ? 'DRAFT' as const : 'RUNNING' as const;
  await tx.booking.create({
    data: t.scope === 'FEDERATION'
      ? { ...common, tournamentScope: 'FEDERATION', tournamentRated: true, federationId: t.federationId!, federationCode: t.code ?? null, tournamentStatus: startStatus, thirdPlace: t.status !== 'DRAFT' && t.thirdPlace }
      : { ...common, tournamentScope: 'CLUB', tournamentRated: t.rated, tournamentStatus: startStatus, thirdPlace: t.status !== 'DRAFT' && t.thirdPlace },
  });
  const entryIds = t.entries.map(() => uuid());
  if (t.entries.length) {
    await tx.tournamentEntry.createMany({
      data: t.entries.map((e, i) => ({
        id: entryIds[i], bookingId, clubId: t.clubId, name: e.name, seed: i + 1, playerId: e.playerId, customerId: e.customerId ?? null,
        createdAt: pastCreatedAt ? t.start.minus({ days: 10 }).toJSDate() : undefined,
      })),
    });
  }
  report.counts.tournamentEntries = (report.counts.tournamentEntries ?? 0) + t.entries.length;
  if (t.status === 'DRAFT') return bookingId;

  /* Старт: сітка з тими самими buildBracket, що в роутах, далі — зіграні раунди. */
  const matches = buildBracket(entryIds, t.thirdPlace);
  const strength = new Map(entryIds.map((id, i) => [id, t.entries[i].strength]));
  const rounds = Math.max(...matches.map(m => m.round));
  const maxRound = t.status === 'FINISHED' ? rounds : (t.playRounds ?? 1);
  const meta = playMatches({ matches, strength, thirdPlace: t.thirdPlace, rng: t.rng, setsToWin: t.setsToWin, ptw: t.ptw, settings, maxRound, t0: t.start.plus({ minutes: 15 }), stepMin: 26, courtId: t.courtId });

  const byRS = (r: number, s: number) => matches.find(m => m.round === r && m.slot === s);
  if (t.status === 'RUNNING' && t.liveSemi) {
    const live = byRS(maxRound + 1, t.liveSemi.liveSlot), sch = byRS(maxRound + 1, t.liveSemi.scheduledSlot);
    if (live && live.entryAId && live.entryBId) {
      live.status = 'LIVE';
      live.sets = [{ a: 11, b: 8 }];
      meta.set(live.id, { startedAt: t.liveSemi.now.minus({ minutes: 12 }).toJSDate(), finishedAt: null, scheduledAt: t.liveSemi.now.minus({ minutes: 20 }).toJSDate(), courtId: t.courtId, version: 1 });
    }
    if (sch && sch.entryAId && sch.entryBId) {
      sch.status = 'SCHEDULED';
      meta.set(sch.id, { startedAt: null, finishedAt: null, scheduledAt: t.liveSemi.now.plus({ minutes: 45 }).toJSDate(), courtId: t.courtId, version: 0 });
    }
  }
  await tx.tournamentMatch.createMany({
    data: matches.map(m => {
      const mm = meta.get(m.id);
      return {
        id: m.id, bookingId, clubId: t.clubId, round: m.round, slot: m.slot, entryAId: m.entryAId, entryBId: m.entryBId,
        sets: m.sets as unknown as Prisma.InputJsonValue, winnerEntryId: m.winnerEntryId, status: m.status,
        courtId: mm?.courtId ?? null, scheduledAt: mm?.scheduledAt ?? null, startedAt: mm?.startedAt ?? null, finishedAt: mm?.finishedAt ?? null,
        version: mm?.version ?? 0, updatedBy: t.createdBy,
      };
    }),
  });
  report.counts.tournamentMatches = (report.counts.tournamentMatches ?? 0) + matches.length;
  const bWins = matches.filter(m => m.winnerEntryId && m.winnerEntryId === m.entryBId).length;
  const played = matches.filter(m => m.winnerEntryId).length;
  report.notes.push(`турнір «${t.title}»: ${t.status}, матчів ${matches.length}, зіграно ${played}, перемог сторони B: ${bWins}`);

  if (t.status === 'FINISHED') {
    await finalizeTournament(tx, bookingId, t.finalizeActor ?? t.createdBy);
    /* RatingChange незмінний (append-only), тому його мітки часу лишаються «зараз». Дати турніру, матчів
       і Booking.ratingsAppliedAt / ClubPlayerRating.lastMatchAt переносимо на час турніру. */
    const endDate = t.end.toJSDate();
    if (t.scope === 'CLUB') {
      await tx.clubPlayerRating.updateMany({ where: { clubId: t.clubId, playerId: { in: t.entries.map(e => e.playerId) }, lastMatchAt: { not: null } }, data: { lastMatchAt: endDate } });
    }
    await tx.booking.update({ where: { id: bookingId }, data: { ratingsAppliedAt: endDate } });
  }
  return bookingId;
}

/* ═════════════════════════════ Сід ═════════════════════════════ */

async function seed(tx: Tx, report: Report) {
  const t0 = Date.now();
  const lap = (s: string) => log(`  · ${s} (${((Date.now() - t0) / 1000).toFixed(1)} с)`);
  const now = DateTime.now().setZone(TZ);
  const day0 = now.startOf('day');
  const counts = report.counts;
  const bump = (k: string, n: number) => { counts[k] = (counts[k] ?? 0) + n; };

  const passwordHash = await hashPassword(DEMO_PASSWORD, 10);
  const plans = await tx.plan.findMany({ where: { code: { in: ['base', 'team', 'pro'] } } });
  const planBy = new Map(plans.map(p => [p.code, p]));
  for (const c of ['base', 'team', 'pro']) if (!planBy.has(c)) throw new PreflightError(`Немає плану ${c} у базі`);

  /* ── Федерація squash-demo: існує → лише пароль акаунта; немає → створюємо ── */
  let fed = await tx.federation.findUnique({ where: { code: FED_CODE } });
  if (!fed) {
    fed = await tx.federation.create({ data: { name: FED_NAME, code: FED_CODE, sport: 'SQUASH' } });
    report.notes.push('федерацію squash-demo створено (її не було)');
  }
  const acc = await tx.federationAccount.findUnique({ where: { email: FED_EMAIL } });
  if (acc && acc.federationId !== fed.id) throw new PreflightError(`${FED_EMAIL} належить іншій федерації`);
  if (acc) await tx.federationAccount.update({ where: { id: acc.id }, data: { passwordHash, active: true, loginFails: 0, lockedUntil: null } });
  else await tx.federationAccount.create({ data: { federationId: fed.id, email: FED_EMAIL, name: 'Оператор Федерації · ДЕМО', passwordHash } });
  const federationId = fed.id;
  report.notes.push(`пароль ${FED_EMAIL} встановлено на демо-пароль`);

  /* ── Гравці федерації (18) ── */
  const rngP = mulberry32(777);
  const playerId = new Map<string, string>();
  const strengthByPhone = new Map<string, number>();
  for (const p of PLAYERS) {
    const norm = normalizePhone(p.phone);
    if (!norm || norm.e164 !== p.phone) throw new Error(`Телефон не нормалізується: ${p.phone}`);
    playerId.set(p.phone, uuid());
    strengthByPhone.set(p.phone, (STRENGTH_BY_SKILL[p.skill] ?? 1350) + rint(rngP, -45, 45));
  }
  await tx.player.createMany({
    data: PLAYERS.map(p => ({
      id: playerId.get(p.phone)!, phone: p.phone, name: p.person.name, federationId,
      gender: p.person.g === 'M' ? 'MALE' : 'FEMALE', ageCategory: p.age, skillLevel: p.skill, bio: p.bio,
      birthDate: new Date(Date.UTC(p.birthYear, (p.birthYear * 7) % 12, 1 + (p.birthYear * 3) % 27)), publicProfile: true,
      createdAt: day0.minus({ days: 60 }).toJSDate(),
    })),
  });
  bump('Player', PLAYERS.length);

  /* ── Партнер ── */
  let refCode = 'demobud1';
  if (await tx.partner.findUnique({ where: { refCode } })) refCode = `demobud${rint(mulberry32(5), 2, 9)}${rint(mulberry32(6), 10, 99)}`;
  const partner = await tx.partner.create({
    data: {
      name: 'Олег Будівельник · ДЕМО', company: 'ТОВ «Демо Буд»', email: PARTNER_EMAIL, phone: ph(90), passwordHash, refCode,
      note: 'Демо-партнер: усе вигадане',
    },
  });
  bump('Partner', 1);

  /* ── Клуби ── */
  const clubIds = new Map<ClubKey, string>();
  const courtIds = new Map<ClubKey, string[]>();
  const customerIds = new Map<string, string>(); // `${club}:${phone}` -> customer.id
  const adminOf = new Map<ClubKey, { id: string; email: string; role: string }>();
  const ownerOf = new Map<ClubKey, { id: string; email: string; role: string }>();
  const trainerOf = new Map<ClubKey, string>();

  for (const spec of SPECS) {
    log(`Клуб ${spec.slug}`);
    const plan = planBy.get(spec.planCode)!;
    const club = await tx.club.create({
      data: {
        name: spec.name, slug: spec.slug, timezone: TZ, phone: spec.phone, address: spec.address, city: spec.city,
        sports: ['SQUASH'], defaultSetsToWin: 3, slotMinutes: 60, leadTimeMinutes: 30, horizonDays: 14, autoConfirm: true,
        passesEnabled: spec.passes, planId: plan.id, planPrice: plan.price,
        paidUntil: now.plus({ days: 60 }).toJSDate(), approvedAt: now.toJSDate(),
        offerAcceptedAt: now.toJSDate(), offerVersion: LEGAL_VERSION,
        taxRegime: 'FOP_3', email: spec.email, legalName: `ФОП Демо ${spec.city} (ДЕМО)`, legalCode: spec.legalCode,
        legalAddress: spec.address, brandColor: spec.brandColor, crmTags: ['демо'],
        partnerId: partner.id, partnerAttachedAt: now.minus({ days: spec.partnerAttachedDaysAgo }).toJSDate(),
        shareStatsWithPartner: spec.shareStats, shareStatsChangedAt: spec.shareStats ? now.toJSDate() : null,
      },
    });
    clubIds.set(spec.key, club.id);
    bump('Club', 1);
    await tx.clubHours.createMany({
      data: Array.from({ length: 7 }, (_, weekday) => ({
        clubId: club.id, weekday, openMinute: weekday === 0 || weekday === 6 ? 9 * 60 : 8 * 60, closeMinute: weekday === 0 || weekday === 6 ? 21 * 60 : 22 * 60,
      })),
    });
    const cIds = spec.courts.map(() => uuid());
    await tx.court.createMany({ data: spec.courts.map((c, i) => ({ id: cIds[i], clubId: club.id, name: c.name, pricePerHour: c.price, sortOrder: i + 1 })) });
    courtIds.set(spec.key, cIds);
    bump('Court', cIds.length);

    let trainerId: string | null = null;
    if (spec.trainer) {
      const tid = uuid();
      trainerId = tid;
      await tx.trainer.create({ data: { id: tid, clubId: club.id, name: spec.trainer.name, phone: spec.trainer.phone, pricePerHour: spec.trainer.price, note: spec.trainer.note, sortOrder: 1 } });
      await tx.trainerHours.createMany({
        data: [1, 2, 3, 4, 5, 6, 0].map(weekday => ({ trainerId: tid, weekday, openMinute: 10 * 60, closeMinute: 20 * 60, isClosed: weekday === 0 })),
      });
      trainerOf.set(spec.key, tid);
      bump('Trainer', 1);
    }
    for (const u of spec.staff) {
      const id = uuid();
      await tx.user.create({ data: { id, clubId: club.id, email: u.email, name: u.name, role: u.role, passwordHash, trainerId: u.role === 'TRAINER' ? trainerId : null } });
      if (u.role === 'OWNER') ownerOf.set(spec.key, { id, email: u.email, role: 'OWNER' });
      if (u.role === 'ADMIN') adminOf.set(spec.key, { id, email: u.email, role: 'ADMIN' });
      bump('User', 1);
    }
    if (!adminOf.has(spec.key)) adminOf.set(spec.key, ownerOf.get(spec.key)!);

    /* Клієнти */
    const n = spec.people.length;
    const early = Math.ceil(n * 0.6);
    const channels = ['DIRECT', 'SOCIAL', 'SEARCH', 'REFERRAL', 'RECEPTION', 'BOT', 'ADS', 'MESSAGING'] as const;
    const skillEnum = ['D', 'C', 'C_PLUS', 'B', 'B_PLUS'] as const;
    const skillMap: Record<string, (typeof skillEnum)[number]> = { A: 'B_PLUS', 'B+': 'B_PLUS', B: 'B', C: 'C_PLUS' };
    const rows: Prisma.CustomerCreateManyInput[] = spec.people.map((p, i) => {
      const phone = spec.phones[i];
      const norm = normalizePhone(phone)!;
      const joinOffset = i < early ? spec.histDays + 15 + i * 3 : Math.max(1, Math.round(spec.histDays * (1 - (i - early + 1) / (n - early + 1))));
      const meta = PLAYERS.find(x => x.phone === phone);
      const id = uuid();
      customerIds.set(`${spec.key}:${phone}`, id);
      const bd = (i === 2 && spec.key === 'kyiv') ? day0.plus({ days: 3 }) : (i === 9 && spec.key === 'kyiv') ? day0.plus({ days: 12 }) : null;
      return {
        id, clubId: club.id, name: p.name, phone: norm.e164, phoneTail: norm.tail,
        email: i % 3 === 0 ? `player.${spec.key}${i + 1}@demo.test` : null,
        skillLevel: meta ? skillMap[meta.skill] : skillEnum[i % 5],
        firstChannel: channels[(i + spec.seed) % channels.length],
        createdAt: day0.minus({ days: joinOffset }).set({ hour: 10 }).toJSDate(),
        termsAcceptedAt: now.toJSDate(), termsVersion: LEGAL_VERSION,
        playerId: meta ? playerId.get(phone)! : null,
        birthDate: bd ? new Date(Date.UTC(1990, bd.month - 1, bd.day)) : null,
        tags: i % 7 === 0 ? ['постійний'] : [],
        marketingConsentAt: i % 4 === 0 ? now.toJSDate() : null,
      };
    });
    await tx.customer.createMany({ data: rows });
    bump('Customer', rows.length);
    lap('клуб + клієнти');
  }

  /* ── Членство гравців у клубах (ClubPlayerRating) ── */
  const memberships: Prisma.ClubPlayerRatingCreateManyInput[] = [];
  const GROUPS = ['Основна', 'Вечірня', 'Ранкова'];
  for (const spec of SPECS) {
    spec.phones.forEach((phone, i) => {
      const meta = PLAYERS.find(x => x.phone === phone);
      if (!meta) return;
      const cat = meta.skill === 'A' ? 'Pro' : meta.skill === 'B+' ? 'Advanced' : 'Amateur';
      const extra: Partial<Prisma.ClubPlayerRatingCreateManyInput> = {};
      if (phone === ph(1) && spec.key === 'kyiv') Object.assign(extra, { title: 'Капітан команди', achievements: ['Учасник осіннього кубка', 'Фіналіст клубного турніру 2025'] });
      if (phone === ph(9) && spec.key === 'kyiv') Object.assign(extra, { title: 'Чемпіон клубу 2025', achievements: ['Переможець клубного чемпіонату 2025'] });
      if (phone === ph(101)) Object.assign(extra, { title: 'Тренер-інструктор', achievements: ['Інструктор дитячої групи'] });
      memberships.push({
        clubId: clubIds.get(spec.key)!, playerId: playerId.get(phone)!, sport: 'SQUASH', group: GROUPS[(i + spec.seed) % 3], category: cat,
        status: i % 5 === 4 ? 'Новачок' : 'Активний', active: true, ...extra,
      });
    });
  }
  await tx.clubPlayerRating.createMany({ data: memberships });
  bump('ClubPlayerRating', memberships.length);

  /* ── Партнерства федерації (CONFIRMED) ── */
  await tx.clubFederation.createMany({
    data: SPECS.map(s => ({ clubId: clubIds.get(s.key)!, federationId, status: 'CONFIRMED' as const, confirmedAt: now.toJSDate(), confirmedBy: 'demo-online' })),
  });
  bump('ClubFederation', SPECS.length);

  /* ── Партнер: ліди та заявки ── */
  await tx.lead.createMany({
    data: [
      { name: 'Tennis Academy Kharkiv (ДЕМО)', city: 'Харків', phone: ph(91), contactName: 'Максим (демо)', courtsCount: 5, source: 'partner', partnerId: partner.id, stage: 'DEMO', note: 'Демо призначено, планується показ можливостей' },
      { name: 'Squash Club Odesa (ДЕМО)', city: 'Одеса', phone: ph(92), contactName: 'Роман (демо)', courtsCount: 3, source: 'partner', partnerId: partner.id, stage: 'PROPOSAL', note: 'Надіслано комерційну пропозицію, чекаємо на рішення' },
    ],
  });
  bump('Lead', 2);
  await tx.serviceRequest.createMany({
    data: [
      { clubId: clubIds.get('kyiv')!, partnerId: partner.id, courtId: courtIds.get('kyiv')![0], kind: 'surface', message: 'Демо-запит: потрібен огляд покриття на корті 1', status: 'NEW', contactName: 'Максим Адмінько', contactPhone: ph(10) },
      { clubId: clubIds.get('lviv')!, partnerId: partner.id, courtId: courtIds.get('lviv')![1], kind: 'lighting', message: 'Демо-запит: потрібна заміна ламп освітлення на корті 2', status: 'IN_PROGRESS', partnerNote: 'Виїзд майстра заплановано на цьому тижні', contactName: 'Соломія Адмін', contactPhone: ph(20) },
    ],
  });
  bump('ServiceRequest', 2);
  lap('гравці, членство, партнер');

  /* ── Активність клубів ── */
  const occByClub = new Map<ClubKey, Occ>();
  for (const spec of SPECS) occByClub.set(spec.key, new Occ());

  /* Резерв під турніри (до генерації броней, щоб EXCLUDE не спрацював). */
  const tw = (dayOffset: number, h1: number, h2: number) => ({ start: day0.plus({ days: dayOffset }).set({ hour: h1 }), end: day0.plus({ days: dayOffset }).set({ hour: h2 }) });
  const T = {
    fed1: tw(-40, 10, 15), fed2: tw(-20, 11, 16), clubK: tw(-10, 10, 14), fed3: tw(-1, 10, 18), clubL: tw(-1, 12, 18),
    friendly: tw(5, 11, 15), fed4: tw(30, 10, 16),
  };
  const reserve = (key: ClubKey, court: number, w: { start: DateTime; end: DateTime }) =>
    occByClub.get(key)!.take(`c${court}`, w.start.toMillis(), w.end.toMillis());
  reserve('kyiv', 4, T.fed1); reserve('kyiv', 4, T.clubK); reserve('kyiv', 4, T.fed3); reserve('kyiv', 4, T.friendly);
  reserve('lviv', 2, T.fed2); reserve('lviv', 2, T.clubL); reserve('dnipro', 0, T.fed4);

  for (const spec of SPECS) {
    await seedActivity(tx, spec, {
      now, day0, clubId: clubIds.get(spec.key)!, courtIds: courtIds.get(spec.key)!, trainerId: trainerOf.get(spec.key) ?? null,
      admin: adminOf.get(spec.key)!, owner: ownerOf.get(spec.key)!, customerIds, occ: occByClub.get(spec.key)!, bump, planId: planBy.get(spec.planCode)!.id,
    });
    lap(`активність ${spec.key}`);
  }

  /* ── Турніри (в кінці: finalizeTournament бере advisory-lock, тримаємо його якнайкоротше) ── */
  log('Турніри');
  const kyivId = clubIds.get('kyiv')!, lvivId = clubIds.get('lviv')!, dniproId = clubIds.get('dnipro')!;
  const kc = courtIds.get('kyiv')!, lc = courtIds.get('lviv')!, dc = courtIds.get('dnipro')!;
  const pl = (phone: string) => {
    const m = PLAYERS.find(x => x.phone === phone)!;
    return { playerId: playerId.get(phone)!, name: m.person.name, strength: strengthByPhone.get(phone)! };
  };
  /** Посів федерації за поточним ELO (як роут PUT /federation/tournaments/:id/entries), tie → сила. */
  const seedByElo = async (phones: string[]) => {
    const ps = phones.map(pl);
    const rows = await tx.federationPlayerRating.findMany({ where: { federationId, playerId: { in: ps.map(p => p.playerId) } } });
    const elo = new Map(rows.map(r => [r.playerId, r.elo]));
    return ps.sort((a, b) => (elo.get(b.playerId) ?? 1200) - (elo.get(a.playerId) ?? 1200) || b.strength - a.strength);
  };
  const byStrength = (phones: string[], clubKey: ClubKey) =>
    phones.map(phone => ({ ...pl(phone), customerId: customerIds.get(`${clubKey}:${phone}`)! })).sort((a, b) => b.strength - a.strength);
  const kp = (idx: number[]) => idx.map(i => KYIV_PHONES[i]);
  const FED_ACTOR = FED_EMAIL;

  await createTournament(tx, {
    scope: 'FEDERATION', clubId: kyivId, courtId: kc[4], courtIdx: 4, title: 'Кубок Федерації · Київ',
    description: 'Офіційний турнір Федерації сквошу: сітка на вибування, матчі до трьох виграних сетів. Усі дані вигадані.',
    start: T.fed1.start, end: T.fed1.end, capacity: 8, rated: true, setsToWin: 3, ptw: 11, thirdPlace: true, status: 'FINISHED',
    entries: await seedByElo(kp([0, 1, 2, 3, 4, 5, 6, 7])), federationId, code: 'DEMO-KYIV-CUP', createdBy: FED_ACTOR, rng: mulberry32(4001),
  }, report);
  await createTournament(tx, {
    scope: 'FEDERATION', clubId: lvivId, courtId: lc[2], courtIdx: 2, title: 'Відкритий турнір · Львів',
    description: 'Відкритий турнір Федерації у Львові. Рейтинг ELO рахується за результатами матчів.',
    start: T.fed2.start, end: T.fed2.end, capacity: 8, rated: true, setsToWin: 3, ptw: 11, thirdPlace: true, status: 'FINISHED',
    entries: await seedByElo([...LVIV_PLAYER_PHONES]), federationId, code: 'DEMO-LVIV-OPEN', createdBy: FED_ACTOR, rng: mulberry32(4002),
  }, report);
  await createTournament(tx, {
    scope: 'CLUB', clubId: kyivId, courtId: kc[4], courtIdx: 4, title: 'Клубний чемпіонат Squash Arena Kyiv',
    description: 'Клубний чемпіонат: нараховуються клубні очки за перемоги та призові місця.',
    start: T.clubK.start, end: T.clubK.end, capacity: 8, rated: true, setsToWin: 2, ptw: 11, thirdPlace: true, status: 'FINISHED',
    entries: byStrength(kp([1, 2, 4, 6, 8, 9, 10, 11]), 'kyiv'), createdBy: ownerOf.get('kyiv')!.email, finalizeActor: ownerOf.get('kyiv')!.id, rng: mulberry32(4003),
  }, report);
  await createTournament(tx, {
    scope: 'FEDERATION', clubId: kyivId, courtId: kc[4], courtIdx: 4, title: 'Осінній кубок сквошу · Київ',
    description: 'Триває: чвертьфінали зіграно, півфінали попереду. Рахунок вносить власник або адміністратор приймаючого клубу.',
    start: T.fed3.start, end: T.fed3.end, capacity: 8, rated: true, setsToWin: 3, ptw: 11, thirdPlace: false, status: 'RUNNING', playRounds: 1,
    entries: await seedByElo(kp([2, 3, 4, 5, 8, 9, 10, 11])), federationId, code: 'DEMO-AUTUMN-CUP', createdBy: FED_ACTOR, rng: mulberry32(4004),
    liveSemi: { liveSlot: 0, scheduledSlot: 1, now },
  }, report);
  await createTournament(tx, {
    scope: 'CLUB', clubId: lvivId, courtId: lc[2], courtIdx: 2, title: 'Клубний турнір Lviv Squash · осінь',
    description: 'Клубний турнір вихідного дня. Чвертьфінали зіграно, півфінали попереду.',
    start: T.clubL.start, end: T.clubL.end, capacity: 8, rated: true, setsToWin: 2, ptw: 11, thirdPlace: false, status: 'RUNNING', playRounds: 1,
    entries: byStrength([...LVIV_PLAYER_PHONES], 'lviv'), createdBy: ownerOf.get('lviv')!.email, rng: mulberry32(4005),
    liveSemi: { liveSlot: 99, scheduledSlot: 0, now },
  }, report);
  await createTournament(tx, {
    scope: 'CLUB', clubId: kyivId, courtId: kc[4], courtIdx: 4, title: 'Товариський турнір вихідного дня',
    description: 'Товариський формат без рейтингу: рейтинг федерації та клубні очки не змінюються.',
    start: T.friendly.start, end: T.friendly.end, capacity: 8, rated: false, setsToWin: 2, ptw: 11, thirdPlace: false, status: 'DRAFT',
    entries: byStrength(kp([0, 3, 5, 7, 8, 11]), 'kyiv'), createdBy: ownerOf.get('kyiv')!.email, rng: mulberry32(4006),
  }, report);
  await createTournament(tx, {
    scope: 'FEDERATION', clubId: dniproId, courtId: dc[0], courtIdx: 0, title: 'Відкритий чемпіонат Дніпра',
    description: 'Турнір для демонстрації реєстрації гравців і посіву за ELO: склад Федерація обирає на місці.',
    start: T.fed4.start, end: T.fed4.end, capacity: 16, rated: true, setsToWin: 3, ptw: 11, thirdPlace: false, status: 'DRAFT',
    entries: [], federationId, code: 'DEMO-DNIPRO-OPEN', createdBy: FED_ACTOR, rng: mulberry32(4007),
  }, report);
  bump('Tournament (Booking)', 7);
  lap('турніри');

  /* ── Підсумкові підрахунки з бази (в межах транзакції) ── */
  const inClubs = { in: [...clubIds.values()] };
  const q: Record<string, number> = {
    'Booking (усі, з турнірами та групами)': await tx.booking.count({ where: { clubId: inClubs } }),
    'BookingSeat': await tx.bookingSeat.count({ where: { booking: { clubId: inClubs } } }),
    'BookingLedgerEntry': await tx.bookingLedgerEntry.count({ where: { clubId: inClubs } }),
    'Payment (provider demo)': await tx.payment.count({ where: { clubId: inClubs } }),
    'Block': await tx.block.count({ where: { clubId: inClubs } }),
    'Pass': await tx.pass.count({ where: { clubId: inClubs } }),
    'ClubExpense': await tx.clubExpense.count({ where: { clubId: inClubs } }),
    'TrainerRating': await tx.trainerRating.count({ where: { clubId: inClubs } }),
    'RatingChange (FEDERATION)': await tx.ratingChange.count({ where: { ratingType: 'FEDERATION', player: { phone: { startsWith: PHONE_PREFIX } } } }),
    'RatingChange (CLUB)': await tx.ratingChange.count({ where: { ratingType: 'CLUB', clubId: inClubs } }),
    'FederationPlayerRating': await tx.federationPlayerRating.count({ where: { player: { phone: { startsWith: PHONE_PREFIX } } } }),
  };
  Object.assign(counts, q);

  report.logins = [
    { role: 'Власник Київ (OWNER)', email: 'owner@demo.test', where: `${WEB}/admin` },
    { role: 'Адміністратор Київ (ADMIN)', email: 'admin@demo.test', where: `${WEB}/admin` },
    { role: 'Тренер Київ (TRAINER)', email: 'trainer@demo.test', where: `${WEB}/admin` },
    { role: 'Бухгалтер Київ (ACCOUNTANT)', email: 'accountant@demo.test', where: `${WEB}/admin` },
    { role: 'Власник Львів (OWNER)', email: 'owner.lviv@demo.test', where: `${WEB}/admin` },
    { role: 'Адміністратор Львів (ADMIN)', email: 'admin.lviv@demo.test', where: `${WEB}/admin` },
    { role: 'Власник Дніпро (OWNER)', email: 'owner.dnipro@demo.test', where: `${WEB}/admin` },
    { role: 'Федерація сквошу (пароль перевстановлено)', email: FED_EMAIL, where: `${WEB}/federation/login` },
    { role: 'Партнер-будівельник', email: PARTNER_EMAIL, where: `${WEB}/partner` },
  ];
  report.urls = [
    `${WEB}/f/${FED_CODE}  (публічна сторінка федерації)`,
    ...SPECS.map(s => `${WEB}/c/${s.slug}  (віджет бронювання: ${s.name})`),
    `Пароль для всіх демо-входів: ${DEMO_PASSWORD}`,
  ];
}

/* ═════════════════════════════ Активність одного клубу ═════════════════════════════ */

async function seedActivity(tx: Tx, spec: ClubSpec, c: {
  now: DateTime; day0: DateTime; clubId: string; courtIds: string[]; trainerId: string | null;
  admin: { id: string; email: string; role: string }; owner: { id: string; email: string; role: string };
  customerIds: Map<string, string>; occ: Occ; bump: (k: string, n: number) => void; planId: string;
}) {
  const { now, day0, clubId, courtIds, trainerId, admin, occ, bump } = c;
  const rng = mulberry32(spec.seed * 7919);
  const nowMs = now.toMillis();
  const nCust = spec.people.length;
  const early = Math.ceil(nCust * 0.6);
  const joinOffset = (i: number) => (i < early ? spec.histDays + 15 + i * 3 : Math.max(1, Math.round(spec.histDays * (1 - (i - early + 1) / (nCust - early + 1)))));
  const custId = (i: number) => c.customerIds.get(`${spec.key}:${spec.phones[i]}`)!;
  const custBusy = new Occ();

  const hoursOf = (d: DateTime) => (d.weekday >= 6 ? [9, 21] : [8, 22]);
  const baseP = (h: number, weekend: boolean) => weekend ? (h >= 10 && h <= 18 ? 0.72 : 0.5) : h < 11 ? 0.3 : h < 17 ? 0.4 : h < 21 ? 0.85 : 0.5;
  const pickCust = (dayOffset: number, s: number, e: number): number => {
    const idx = [...Array(nCust).keys()].filter(i => dayOffset > 0 || joinOffset(i) >= -dayOffset);
    for (let tries = 0; tries < 8; tries++) {
      const i = pickW(rng, idx, idx.map(k => 1 / (k + 1) ** 0.8));
      if (custBusy.free(`u${i}`, s, e)) { custBusy.take(`u${i}`, s, e); return i; }
    }
    return idx[Math.floor(rng() * idx.length)];
  };
  const payFor = (past: boolean): Pay => {
    if (past) return rng() < 0.05 ? null : pickW<Pay>(rng, ['CASH', 'CARD', 'TRANSFER', 'ONLINE'], [20, 35, 10, 35]);
    return rng() < 0.45 ? pickW<Pay>(rng, ['CARD', 'ONLINE'], [50, 50]) : null;
  };

  /* Блокування */
  const blocksSpec: { d: number; court: number; from: number; to: number; reason: string }[] =
    spec.key === 'kyiv' ? [{ d: 0, court: 2, from: 12, to: 14, reason: 'Обслуговування покриття' }, { d: 2, court: 4, from: 10, to: 14, reason: 'Підготовка корту до турніру' }, { d: -5, court: 1, from: 9, to: 13, reason: 'Фарбування стін' }]
      : spec.key === 'lviv' ? [{ d: 1, court: 0, from: 12, to: 14, reason: 'Технічна перерва' }] : [];
  for (const b of blocksSpec) occ.take(`c${b.court}`, day0.plus({ days: b.d }).set({ hour: b.from }).toMillis(), day0.plus({ days: b.d }).set({ hour: b.to }).toMillis());

  /* Групові заняття (резервуємо раніше за звичайні броні) */
  for (const g of spec.groups) {
    const s = day0.plus({ days: g.dayOffset }).set({ hour: g.hour }).toMillis();
    occ.take(`c${g.court}`, s, s + 3600_000);
  }

  const planned: Planned[] = [];
  const lastDay = spec.withTomorrow ? 1 : 0;
  for (let d = -spec.histDays; d <= lastDay; d++) {
    const day = day0.plus({ days: d });
    const [open, close] = hoursOf(day);
    const weekend = day.weekday >= 6;
    /* Тренерські заняття */
    if (trainerId && spec.trainer && day.weekday !== 7) {
      const cnt = d === 0 ? 3 : d === 1 ? 2 : weekend ? 3 : (rng() < 0.8 ? 2 : 1);
      for (let k = 0, tries = 0; k < cnt && tries < 30; tries++) {
        const h = rint(rng, 10, 19), court = rint(rng, 0, courtIds.length - 1);
        const s = day.set({ hour: h }).toMillis(), e = s + 3600_000;
        if (!occ.free(`c${court}`, s, e) || !occ.free('trainer', s, e)) continue;
        occ.take(`c${court}`, s, e); occ.take('trainer', s, e);
        const cust = pickCust(d, s, e);
        const past = e <= nowMs;
        planned.push({ id: uuid(), court, start: day.set({ hour: h }), dur: 1, cust, pay: past ? (rng() < 0.9 ? 'CARD' : 'CASH') : (rng() < 0.5 ? 'CARD' : null), trainer: true, cancelled: false, dayOffset: d });
        k++;
      }
    }
    for (let h = open; h < close; h++) {
      for (let court = 0; court < courtIds.length; court++) {
        const s = day.set({ hour: h }).toMillis();
        if (!occ.free(`c${court}`, s, s + 3600_000)) continue;
        if (rng() >= Math.min(0.95, baseP(h, weekend) * spec.fill)) continue;
        const dur = rng() < 0.12 && h + 1 < close && occ.free(`c${court}`, s, s + 7200_000) ? 2 : 1;
        const e = s + dur * 3600_000;
        occ.take(`c${court}`, s, e);
        const cust = pickCust(d, s, e);
        const past = e <= nowMs;
        planned.push({ id: uuid(), court, start: day.set({ hour: h }), dur, cust, pay: payFor(past), trainer: false, cancelled: false, dayOffset: d });
      }
    }
  }
  /* Скасовані (минулі, неоплачені) — для статистики скасувань */
  for (const p of planned) if (p.dayOffset < 0 && !p.trainer && p.start.toMillis() + p.dur * 3600_000 <= nowMs && rng() < 0.05) { p.cancelled = true; p.pay = null; }

  /* Гарантії для демо: кандидат на повернення сьогодні/завтра (CARD, майбутній, без тренера) */
  const futureNoTrainer = planned.filter(p => p.dayOffset >= 0 && !p.trainer && p.start.toMillis() > nowMs && !p.cancelled);
  const refundIdx = futureNoTrainer.length ? Math.floor(futureNoTrainer.length / 3) : -1;
  const refundBooking = refundIdx >= 0 ? futureNoTrainer[refundIdx] : null;
  if (refundBooking) refundBooking.pay = 'CARD';

  const customersRows = await tx.customer.findMany({ where: { clubId }, select: { id: true, name: true, phone: true, firstChannel: true } });
  const cById = new Map(customersRows.map(r => [r.id, r]));

  const bookings: Prisma.BookingCreateManyInput[] = [];
  const payments: Prisma.PaymentCreateManyInput[] = [];
  const ledger: Prisma.BookingLedgerEntryCreateManyInput[] = [];
  const bookedAt = (p: Planned, startMs: number) => {
    const raw = startMs - rint(rng, 2, 60) * 3600_000;
    return new Date(Math.min(raw, nowMs - 5 * 60_000));
  };
  const COURT_PRICE = spec.courts.map(x => x.price);
  const promoId = spec.promo ? uuid() : null;
  const PROMO_NAME = 'Ранкова знижка -20%';
  let refundInfo: { bookingId: string; ledgerId: string; amount: number; customerId: string } | null = null;
  const trainerBookings: { id: string; custId: string; endMs: number }[] = [];
  const pastByCust0: { id: string; endMs: number }[] = [];
  const utmFor = (ch: string | null | undefined): Pick<Prisma.BookingCreateManyInput, 'utmSource' | 'utmMedium' | 'referrerHost'> =>
    ch === 'ADS' ? { utmSource: 'google', utmMedium: 'cpc' } : ch === 'SOCIAL' ? { utmSource: 'instagram', utmMedium: 'social' }
      : ch === 'SEARCH' ? { utmSource: 'google', utmMedium: 'organic' } : ch === 'MESSAGING' ? { utmSource: 'viber', utmMedium: 'messenger' }
        : ch === 'REFERRAL' ? { referrerHost: 'partner.example' } : {};

  for (const p of planned) {
    const customerId = custId(p.cust);
    const cust = cById.get(customerId)!;
    const start = p.start, end = start.plus({ hours: p.dur });
    const isPast = end.toMillis() <= nowMs;
    const courtPrice = COURT_PRICE[p.court] * p.dur;
    const trainerPrice = p.trainer && spec.trainer ? spec.trainer.price * p.dur : 0;
    const promoOn = !!promoId && start.weekday <= 5 && start.hour >= 8 && start.hour < 11 && !p.trainer;
    const discount = promoOn ? Math.round(courtPrice * 0.2) : 0;
    const priceTotal = courtPrice - discount + trainerPrice;
    const listPrice = courtPrice + trainerPrice;
    const paid = p.pay !== null && !p.cancelled;
    const noShow = isPast && !p.cancelled && !p.trainer && !paid && rng() < 0.55;
    const source = p.pay === 'ONLINE' ? (rng() < 0.2 ? 'PLAYER_APP' : 'WIDGET') : (rng() < 0.2 ? 'TELEGRAM_BOT' : 'ADMIN');
    const channel = source === 'ADMIN' ? 'RECEPTION' : source === 'TELEGRAM_BOT' ? 'BOT' : source === 'PLAYER_APP' ? 'DIRECT' : (cust.firstChannel ?? 'DIRECT');
    const createdAt = bookedAt(p, start.toMillis());
    const cancelledAt = p.cancelled ? new Date(start.toMillis() - 3 * 3600_000) : null;
    bookings.push({
      id: p.id, clubId, courtId: courtIds[p.court], customerId, customerName: cust.name, customerPhone: cust.phone,
      trainerId: p.trainer ? trainerId : null, trainerPrice,
      startTime: start.toJSDate(), endTime: end.toJSDate(), status: p.cancelled ? 'CANCELLED' : 'CONFIRMED', source,
      priceTotal, listPrice, promoNames: promoOn ? [PROMO_NAME] : [], promoDiscount: discount, promoIds: promoOn && promoId ? [promoId] : [],
      attendance: isPast && !p.cancelled ? (noShow ? 'NO_SHOW' : 'ARRIVED') : 'UNKNOWN',
      attendanceAt: isPast && !p.cancelled ? end.minus({ hours: 1 }).toJSDate() : null,
      attendanceBy: isPast && !p.cancelled ? admin.email : null,
      paymentPlan: (paid ? { method: p.pay === 'ONLINE' ? 'ONLINE' : p.pay, account: p.pay === 'ONLINE' ? '' : ACC[p.pay as string] } : { method: 'UNSPECIFIED', account: '' }) as Prisma.InputJsonValue,
      createdBy: source === 'ADMIN' ? admin.email : null, createdAt,
      trafficChannel: channel as Prisma.BookingCreateManyInput['trafficChannel'], ...(source === 'WIDGET' ? utmFor(channel) : {}),
      cancelledAt, cancelledBy: p.cancelled ? ({ role: 'ADMIN', email: admin.email } as Prisma.InputJsonValue) : Prisma.DbNull,
      comment: p.trainer ? 'Індивідуальне тренування' : null,
    });
    if (p.trainer && !p.cancelled) trainerBookings.push({ id: p.id, custId: customerId, endMs: end.toMillis() });
    if (p.cust === 0 && isPast && !p.cancelled && !p.trainer && !noShow) pastByCust0.push({ id: p.id, endMs: end.toMillis() });
    if (!paid || noShow) continue;
    const paidAtMs = isPast ? end.toMillis() - 50 * 60_000 : nowMs - 3600_000;
    const paidAt = new Date(Math.max(paidAtMs, createdAt.getTime() + 60_000));
    if (p.pay === 'ONLINE') {
      payments.push({ clubId, bookingId: p.id, provider: 'demo', providerRef: `demo-${p.id}`, amount: priceTotal, status: 'PAID', paidAt, providerAt: paidAt, createdAt });
    } else {
      const ledgerId = uuid();
      ledger.push({
        id: ledgerId, clubId, bookingId: p.id, customerId, requestId: uuid(), kind: 'PAYMENT', method: p.pay as string, amount: priceTotal,
        account: ACC[p.pay as string], note: '', actorId: admin.id, actorEmail: admin.email, actorRole: admin.role, createdAt: paidAt,
      });
      if (refundBooking && p.id === refundBooking.id) refundInfo = { bookingId: p.id, ledgerId, amount: priceTotal, customerId };
    }
  }
  /* Одне повернення: скасована платна бронь з ручним поверненням */
  if (refundInfo) {
    const ri = refundInfo as { bookingId: string; ledgerId: string; amount: number; customerId: string };
    const b = bookings.find(x => x.id === ri.bookingId)!;
    b.status = 'CANCELLED'; b.cancelledAt = now.toJSDate(); b.cancelledBy = { role: 'ADMIN', email: admin.email } as Prisma.InputJsonValue;
    ledger.push({
      id: uuid(), clubId, bookingId: ri.bookingId, customerId: ri.customerId, requestId: uuid(), kind: 'REFUND', method: 'CARD', amount: ri.amount,
      account: ACC.CARD, note: 'Клієнт захворів (демо)', originalId: ri.ledgerId, actorId: admin.id, actorEmail: admin.email, actorRole: admin.role,
      createdAt: new Date(nowMs - 20 * 60_000),
    });
  }

  /* Групові заняття + місця */
  const seats: Prisma.BookingSeatCreateManyInput[] = [];
  const groupIds: string[] = [];
  for (const g of spec.groups) {
    const start = day0.plus({ days: g.dayOffset }).set({ hour: g.hour }), end = start.plus({ hours: 1 });
    const isPast = end.toMillis() <= nowMs;
    const gid = uuid();
    groupIds.push(gid);
    bookings.push({
      id: gid, clubId, courtId: courtIds[g.court], capacity: g.capacity, title: g.title, pricePerSeat: g.price,
      startTime: start.toJSDate(), endTime: end.toJSDate(), status: 'CONFIRMED', source: 'ADMIN', priceTotal: 0, listPrice: 0,
      attendance: isPast ? 'ARRIVED' : 'UNKNOWN', attendanceAt: isPast ? end.toJSDate() : null,
      createdBy: admin.email, createdAt: new Date(Math.min(start.minus({ days: 5 }).toMillis(), nowMs - 60_000)),
    });
    for (let k = 0; k < g.seats; k++) {
      const ci = (nCust - 1 - k - g.dayOffset + 40) % nCust;
      const customerId = custId(ci), cust = cById.get(customerId)!;
      const seatId = uuid();
      seats.push({ id: seatId, bookingId: gid, customerId, customerName: cust.name, customerPhone: cust.phone, status: 'BOOKED', source: 'ADMIN', price: g.price, createdAt: new Date(Math.min(start.minus({ days: 3 }).toMillis(), nowMs - 60_000)) });
      if (k < g.paid) {
        const method = k === 0 ? 'CASH' : 'CARD';
        ledger.push({
          id: uuid(), clubId, bookingId: gid, seatId, customerId, requestId: uuid(), kind: 'PAYMENT', method, amount: g.price, account: ACC[method],
          note: 'Місце в групі', actorId: admin.id, actorEmail: admin.email, actorRole: admin.role,
          createdAt: new Date(Math.min(isPast ? end.toMillis() - 70 * 60_000 : nowMs - 2 * 3600_000, nowMs - 60_000)),
        });
      }
    }
  }

  for (const ch of chunks(bookings, 150)) await tx.booking.createMany({ data: ch });
  for (const ch of chunks(seats, 200)) await tx.bookingSeat.createMany({ data: ch });
  for (const ch of chunks(payments, 200)) await tx.payment.createMany({ data: ch });
  for (const ch of chunks(ledger, 200)) await tx.bookingLedgerEntry.createMany({ data: ch });
  bump('Booking (звичайні+групи)', bookings.length);

  /* Блокування */
  if (blocksSpec.length) {
    await tx.block.createMany({ data: blocksSpec.map(b => ({ clubId, courtId: courtIds[b.court], reason: b.reason, startTime: day0.plus({ days: b.d }).set({ hour: b.from }).toJSDate(), endTime: day0.plus({ days: b.d }).set({ hour: b.to }).toJSDate() })) });
  }

  /* Абонементи (лише клуб з passesEnabled) */
  if (spec.passes) {
    await tx.passPlan.createMany({
      data: [
        { clubId, name: 'Пакет 10 занять', type: 'PACKAGE', totalSessions: 10, days: 90, price: 400000, sortOrder: 1 },
        { clubId, name: 'Безліміт 30 днів', type: 'UNLIMITED', totalSessions: null, days: 30, price: 600000, sortOrder: 2 },
      ],
    });
    const used = pastByCust0.sort((a, b) => a.endMs - b.endMs).slice(0, 3);
    const passId = uuid();
    await tx.pass.create({
      data: {
        id: passId, clubId, customerId: custId(0), type: 'PACKAGE', totalSessions: 10, usedSessions: used.length,
        validFrom: day0.minus({ days: 25 }).toJSDate(), validUntil: day0.plus({ days: 65 }).toJSDate(), price: 400000, payMethod: 'CARD', payAccount: ACC.CARD,
        createdAt: day0.minus({ days: 25 }).toJSDate(),
      },
    });
    if (used.length) await tx.passUsage.createMany({ data: used.map(u => ({ passId, bookingId: u.id, by: admin.email, usedAt: new Date(u.endMs) })) });
    await tx.pass.create({
      data: {
        clubId, customerId: custId(4), type: 'UNLIMITED', validFrom: day0.minus({ days: 5 }).toJSDate(), validUntil: day0.plus({ days: 25 }).toJSDate(),
        price: 600000, payMethod: 'TRANSFER', payAccount: ACC.TRANSFER, createdAt: day0.minus({ days: 5 }).toJSDate(),
      },
    });
  }

  /* Витрати: попередній і поточний місяць */
  if (spec.expenses) {
    const m0 = now.startOf('month');
    const rows: Prisma.ClubExpenseCreateManyInput[] = [];
    for (const m of [m0.minus({ months: 1 }), m0]) for (const [category, label, amount] of spec.expenses) rows.push({ clubId, month: new Date(Date.UTC(m.year, m.month - 1, 1)), category: category as never, label, amount });
    await tx.clubExpense.createMany({ data: rows });
  }
  if (spec.promo && promoId) {
    await tx.promo.create({ data: { id: promoId, clubId, title: PROMO_NAME, kind: 'WEEKLY', weekdays: [1, 2, 3, 4, 5], startMinute: 8 * 60, endMinute: 11 * 60, discountType: 'PERCENT', discountValue: 20, courtIds: [] } });
  }
  if (spec.inventory) {
    await tx.inventoryItem.createMany({
      data: [
        { clubId, name: 'Ракетка для сквошу', category: 'Оренда', quantity: 12, unit: 'шт', rentPrice: 5000, rentMode: 'FIXED', sortOrder: 1 },
        { clubId, name: 'М’ячі (набір)', category: 'Продаж', quantity: 40, unit: 'шт', rentPrice: 15000, rentMode: 'FIXED', returnable: false, sortOrder: 2 },
        { clubId, name: 'Захисні окуляри', category: 'Оренда', quantity: 10, unit: 'шт', rentPrice: 3000, rentMode: 'FIXED', sortOrder: 3 },
      ],
    });
  }

  /* Оцінки тренера (лише минулі проведені заняття) */
  if (trainerId && trainerBookings.length) {
    const past = trainerBookings.filter(t => t.endMs <= nowMs - 3600_000).slice(-8);
    const comments = ['Дуже зрозуміло пояснює техніку', 'Чудове тренування, дякую!', null, 'Багато уваги до дрібниць', null, 'Рекомендую'];
    await tx.trainerRating.createMany({
      data: past.map((t, i) => ({
        clubId, trainerId, bookingId: t.id, customerId: t.custId, score: i === 3 ? 4 : 5, comment: comments[i % comments.length], source: 'WIDGET',
        createdAt: new Date(Math.min(t.endMs + 2 * 3600_000, nowMs - 60_000)), updatedAt: new Date(Math.min(t.endMs + 2 * 3600_000, nowMs - 60_000)),
      })),
    });
  }

  /* Закрита вчорашня зміна (лише Київ): знімок каси за журналом */
  if (spec.key === 'kyiv') {
    const opened = day0.minus({ days: 1 }).set({ hour: 8 }), closed = day0.minus({ days: 1 }).set({ hour: 22, minute: 10 });
    const inShift = ledger.filter(l => l.createdAt && new Date(l.createdAt as Date).getTime() >= opened.toMillis() && new Date(l.createdAt as Date).getTime() < closed.toMillis());
    const net = (m: string) => inShift.filter(l => l.method === m).reduce((s, l) => s + (l.kind === 'REFUND' ? -l.amount : l.amount), 0);
    const expCash = net('CASH'), expCard = net('CARD');
    await tx.shiftClose.create({
      data: {
        clubId, requestId: uuid(), openedAt: opened.toJSDate(), closedAt: closed.toJSDate(),
        expectedCash: expCash, countedCash: Math.max(0, expCash - 5000), expectedCard: expCard, countedCard: expCard,
        transferNet: net('TRANSFER'), bonusNet: 0, entriesCount: inShift.length, note: 'Недостача 50 грн готівкою — видано здачу без чека (демо)',
        actorId: admin.id, actorEmail: admin.email, actorName: null, actorRole: admin.role,
      },
    });
    bump('ShiftClose', 1);
  }
  void c.planId; void c.owner;
}

/* ═════════════════════════════ Точка входу ═════════════════════════════ */

export type SeedOptions = { dryRun?: boolean; reset?: boolean; cleanupOnly?: boolean };

/**
 * Виконує очистку/сід одним викликом на переданому клієнті (одна транзакція).
 * Експортовано для scripts/demo-stand-reset.ts; при прямому запуску main() викликає її ж.
 * Повертає null, якщо спрацював PreflightError (повідомлення вже виведено, process.exitCode = 1).
 */
export async function runDemoWorld(prisma: PrismaClient, opts: SeedOptions = {}): Promise<Report | null> {
  const { dryRun = false, reset = false, cleanupOnly = false } = opts;
  const report: Report = { counts: {}, logins: [], urls: [], notes: [] };
  try {
    await prisma.$transaction(async tx => {
      if (reset || cleanupOnly) {
        log('Очистка демо-даних…');
        report.deleted = await cleanup(tx);
      }
      if (!cleanupOnly) {
        await preflight(tx);
        log('Сід…');
        await seed(tx, report);
      }
      if (dryRun) throw new DryRunRollback(report);
    }, { timeout: 600_000, maxWait: 60_000 });
  } catch (e) {
    if (e instanceof DryRunRollback) {
      printReport(e.report, true);
      return e.report;
    }
    if (e instanceof PreflightError) {
      console.error(`
${e.message}`);
      process.exitCode = 1;
      return null;
    }
    throw e;
  }
  printReport(report, false);
  return report;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const known = new Set(['--dry-run', '--reset', '--cleanup']);
  for (const a of args) if (!known.has(a)) { console.error(`Невідомий прапорець ${a}. Допустимі: ${[...known].join(' ')}`); process.exit(2); }
  const dryRun = args.has('--dry-run'), reset = args.has('--reset'), cleanupOnly = args.has('--cleanup');
  if (reset && cleanupOnly) { console.error('--reset і --cleanup разом не мають сенсу'); process.exit(2); }
  const host = (process.env.DATABASE_URL ?? '').replace(/^[^@]*@/, '').replace(/[/?].*$/, '');
  log(`Режим: ${dryRun ? 'DRY-RUN (відкат, нічого не пишеться)' : 'ЗАПИС'} · ${cleanupOnly ? 'лише очистка' : reset ? 'очистка + сід' : 'сід'} · БД: ${host || '(не задана)'}`);
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL не задано (.env)'); process.exit(2); }

  const prisma = new PrismaClient();
  try {
    await runDemoWorld(prisma, { dryRun, reset, cleanupOnly });
  } finally {
    await prisma.$disconnect();
  }
}

function printReport(r: Report, dry: boolean) {
  const seeded = Object.keys(r.counts).length > 0;
  const title = dry
    ? `DRY-RUN: транзакцію ВІДКОЧЕНО, у базу нічого не записано.${seeded ? ' Було б створено:' : ' Було б видалено:'}`
    : seeded ? 'ГОТОВО. Створено:' : 'ГОТОВО.';
  log(`\n${'═'.repeat(78)}\n${title}\n${'═'.repeat(78)}`);
  if (r.deleted) {
    log('Очистка видалила:');
    for (const [k, v] of Object.entries(r.deleted)) log(`  ${k.padEnd(34)} ${v}`);
    if (!Object.keys(r.deleted).length) log('  (нічого — демо-даних не було)');
  }
  if (Object.keys(r.counts).length) {
    for (const [k, v] of Object.entries(r.counts)) log(`  ${k.padEnd(44)} ${v}`);
    log('\nПримітки:');
    for (const n of r.notes) log(`  - ${n}`);
    log('\nЛогіни (пароль для всіх: ' + DEMO_PASSWORD + ')');
    log(`  ${'Роль'.padEnd(44)} ${'Пошта'.padEnd(28)} Де входити`);
    for (const l of r.logins) log(`  ${l.role.padEnd(44)} ${l.email.padEnd(28)} ${l.where}`);
    log('\nПублічні адреси:');
    for (const u of r.urls) log(`  ${u}`);
  }
}

// Прямий запуск: .env підвантажуємо лише тут, щоб імпорт скрипта з demo-stand-reset.ts
// ніколи не тягнув за собою .env (там може бути прод-DATABASE_URL).
if (require.main === module) {
  require('dotenv/config');
  main().catch(e => { console.error(e); process.exitCode = 1; });
}
