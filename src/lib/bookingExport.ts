import { DateTime } from 'luxon';
import { prisma } from './db';
import type { CellValue, SheetSpec } from './xlsx';
import { bookingLabel } from './bookingLabel';
import { totals } from './settlements';
import { METHOD_LABEL, CASH_METHODS, type CashMethod } from './cashbook';
import { CHANNEL_LABELS, type TrafficChannel } from './attribution';
import { csvCell } from './customerRoster';

/**
 * Вивантаження всіх броней клубу файлом — той самий сценарій «якщо ми
 * зникнемо», що й картотека клієнтів (customerRoster.ts), тільки про броні:
 * власник має піти з системи з повною історією записів, а не лише з
 * контактами.
 *
 * ── Чому окремий модуль, а не розширення customerRoster.ts ──────────────
 *
 * Картотека рахує ЛЮДЕЙ (одна картка на клієнта, візити — агрегат).
 * Тут рахуються ЗАПИСИ (один рядок на бронь), і в кожного своя ціна,
 * свій статус оплати й своя історія скасувань. Спільного між ними — лише
 * низькорівневий письменник .xlsx (`lib/xlsx.ts`), тому й ділять вони
 * тільки його.
 *
 * ── Групові заняття: два аркуші, а не два рядки на один запис ───────────
 *
 * Групове заняття — ОДНА бронь корту (Booking.capacity), а платить кожен
 * учасник окремо (BookingSeat). Якби місця лягали в ту саму таблицю, що й
 * приватні броні, довелось би або дублювати рядок контейнера на кожного
 * учасника (і суми «Броней за період» роздвоїлись би), або ховати учасників
 * узагалі (і бухгалтер не звів би виручку групи). Замість цього:
 *
 *   - аркуш «Бронювання» — один рядок на бронь корту, приватну чи групову.
 *     Для групи «Ціна» — це вартість корту (що коштує клубу година), а не
 *     сума з учасників: так само, як це поле означає в самій базі
 *     (Booking.priceTotal у групи — ціна корту, Booking.pricePerSeat —
 *     ціна місця). Реальна виручка групи — окрема колонка
 *     «Виручка з місць» тут і по рядку на людину на другому аркуші;
 *   - аркуш «Місця в групових заняттях» — по рядку на кожного, хто
 *     записався, з власною ціною, оплатою й статусом.
 *
 * Це те саме рішення, що вже прийняте для кабінету (AdminBookingPanel) і
 * каси (lib/cashbook.ts, source: 'BOOKING' | 'SEAT'): контейнер і місця —
 * різні джерела грошей, і звіт не повинен їх зливати.
 *
 * ── Пагінація читання ─────────────────────────────────────────────────────
 *
 * Клуб може попросити «весь час» — це буквально вся історія броней.
 * Один запит із вкладеними seats/ledgerEntries/payment на роки записів —
 * це запит, який чекає весь пул з'єднань бази, поки будується. Тому броні
 * читаються сторінками (`EXPORT_CHUNK`), а не одним include на все.
 */

const EXPORT_CHUNK = 500;

const money = (kopecks: number) => Math.round(kopecks) / 100;

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Очікує підтвердження',
  CONFIRMED: 'Підтверджено',
  CANCELLED: 'Скасовано',
  EXPIRED: 'Час звільнено',
};

const SEAT_STATUS_LABELS: Record<string, string> = {
  BOOKED: 'Записаний',
  PENDING: 'Очікує оплати',
  CANCELLED: 'Скасував',
  EXPIRED: 'Не встиг оплатити',
};

/** Технічне джерело броні — те саме, що BookingSource у схемі. */
const SOURCE_LABELS: Record<string, string> = {
  WIDGET: 'Сайт/віджет',
  ADMIN: 'Ресепшен',
  TELEGRAM_BOT: 'Telegram-бот',
  PLAYER_APP: 'Кабінет гравця',
};

const ATTENDANCE_LABELS: Record<string, string> = {
  UNKNOWN: 'Без відмітки',
  ARRIVED: 'Прийшов',
  NO_SHOW: 'Не прийшов',
};

const PASS_TYPE_LABELS: Record<string, string> = {
  PACKAGE: 'Пакет занять',
  UNLIMITED: 'Безліміт',
};

/** ISO-дата клубу, зведена до півночі UTC: так xlsx показує дату без часу. */
function localDate(date: Date, tz: string): Date {
  const local = DateTime.fromJSDate(date).setZone(tz);
  return new Date(Date.UTC(local.year, local.month - 1, local.day));
}

/** Час у таймзоні клубу текстом: xlsx-стилю під «дата+час» тут свідомо
    немає (lib/xlsx.ts зроблено під дату без часу), тому час — рядком. */
function localTime(date: Date, tz: string): string {
  return DateTime.fromJSDate(date).setZone(tz).toFormat('HH:mm');
}

/** Дата+час текстом — для «створено» і «скасовано», де сама доба неважлива. */
function localStamp(date: Date | null, tz: string): string {
  if (!date) return '';
  return DateTime.fromJSDate(date).setZone(tz).toFormat('dd.LL.yyyy HH:mm');
}

function methodLabel(method: string): string {
  const key = (CASH_METHODS.includes(method as CashMethod) ? method : 'UNSPECIFIED') as CashMethod;
  return METHOD_LABEL[key];
}

type LedgerLine = { kind: string; method: string; amount: number };
type PaymentInfo = { status: string; amount: number } | null;

/**
 * Скільки сплачено (за вирахуванням повернень) і чим саме.
 *
 * `totals()` — той самий розрахунок, що й у lib/bookingPaymentStatus.ts:
 * онлайн-оплата рахується в «отримано» лише в стані PAID, тому повністю
 * повернений онлайн-платіж дає чистий нуль сам собою, без окремої гілки.
 * Суму самого повернення для колонки «Повернення» довертаємо окремо —
 * totals() її для онлайн-оплат не знає, бо не мусить.
 */
function moneySummary(entries: LedgerLine[], payment: PaymentInfo) {
  const onlinePaidForNet = payment?.status === 'PAID' ? payment.amount : 0;
  const t = totals(entries, onlinePaidForNet);
  const onlineRefunded = payment?.status === 'REFUNDED' ? payment.amount : 0;

  const methods = new Set<string>();
  for (const e of entries) if (e.kind === 'PAYMENT') methods.add(methodLabel(e.method));
  if (payment && (payment.status === 'PAID' || payment.status === 'REFUNDED')) {
    methods.add(METHOD_LABEL.ONLINE);
  }

  return { paid: t.net, refunded: t.refunded + onlineRefunded, methods: [...methods].join(', ') };
}

type CancelledBySnapshot = { role: string; name?: string; email?: string } | null;

const ROLE_NAMES: Record<string, string> = {
  OWNER: 'Власник',
  ADMIN: 'Адміністратор',
  TRAINER: 'Тренер',
  ACCOUNTANT: 'Бухгалтер',
};

/** Хто скасував бронь — знімок ролі й пошти на момент дії (Booking.cancelledBy). */
function cancelledByLabel(status: string, cancelledBy: unknown): string {
  if (status === 'EXPIRED') return 'Автоматично — протермінована оплата';
  if (status !== 'CANCELLED') return '';
  const by = cancelledBy as CancelledBySnapshot;
  if (!by) return 'Клієнт / без відмітки в кабінеті';
  const roleName = ROLE_NAMES[by.role] ?? by.role;
  return by.email ? `${roleName} (${by.email})` : roleName;
}

/* ── Рядки ────────────────────────────────────────────────────────────── */

export type BookingExportRow = {
  startTime: Date;
  endTime: Date;
  courtName: string;
  isGroup: boolean;
  seatsBooked: number | null;
  capacity: number | null;
  status: string;
  label: string;
  phone: string;
  source: string;
  channel: TrafficChannel | null;
  priceTotal: number;
  trainerPrice: number;
  rentalTotal: number;
  seatsRevenue: number | null;
  promoNames: string[];
  promoDiscount: number;
  paid: number;
  methods: string;
  passUsed: string;
  refunded: number;
  cancelledByLabel: string;
  cancelledAt: Date | null;
  attendance: string | null;
  createdAt: Date;
};

export type SeatExportRow = {
  bookingTitle: string | null;
  startTime: Date;
  endTime: Date;
  courtName: string;
  status: string;
  customerName: string;
  phone: string;
  source: string;
  price: number;
  paid: number;
  methods: string;
  refunded: number;
  createdAt: Date;
  cancelledAt: Date | null;
};

export type BookingExportFilter = { from?: Date; to?: Date };

/**
 * Зібрати всі броні клубу за період (або за весь час, коли межі не задані).
 *
 * Сторінками по `EXPORT_CHUNK`: див. коментар модуля про пагінацію.
 * PassUsage читається окремим запитом на кожну сторінку — лише за id
 * броней цієї сторінки, а не за весь клуб одразу.
 */
export async function loadBookingExport(
  clubId: string,
  filter: BookingExportFilter,
): Promise<{ bookings: BookingExportRow[]; seats: SeatExportRow[] }> {
  const bookings: BookingExportRow[] = [];
  const seats: SeatExportRow[] = [];

  let skip = 0;
  for (;;) {
    const page = await prisma.booking.findMany({
      where: {
        clubId,
        ...(filter.from || filter.to
          ? {
            startTime: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lte: filter.to } : {}),
            },
          }
          : {}),
      },
      orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
      skip,
      take: EXPORT_CHUNK,
      select: {
        id: true, startTime: true, endTime: true, status: true, capacity: true, title: true,
        customerName: true, customerPhone: true, source: true, trafficChannel: true,
        priceTotal: true, trainerPrice: true, rentalTotal: true, promoNames: true, promoDiscount: true,
        attendance: true, createdAt: true, cancelledAt: true, cancelledBy: true,
        court: { select: { name: true } },
        payment: { select: { status: true, amount: true } },
        /* seatId: null — рахунки самого корту, без рядків окремих місць:
           ті йдуть у seats нижче, кожен зі своєю оплатою. */
        ledgerEntries: { where: { seatId: null }, select: { kind: true, method: true, amount: true } },
        seats: {
          select: {
            customerName: true, customerPhone: true, status: true, source: true, price: true,
            createdAt: true, cancelledAt: true,
            payment: { select: { status: true, amount: true } },
            ledgerEntries: { select: { kind: true, method: true, amount: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (page.length === 0) break;

    const ids = page.map((b) => b.id);
    /* Абонемент списується лише на рівень усієї броні (PassUsage.bookingId),
       місця в групі свій абонемент не мають — платять поштучно грошима. */
    const usages = await prisma.passUsage.findMany({
      where: { bookingId: { in: ids }, revertedAt: null },
      select: { bookingId: true, pass: { select: { type: true } } },
    });
    const passByBooking = new Map(usages.map((u) => [u.bookingId as string, u.pass.type]));

    for (const b of page) {
      const m = moneySummary(b.ledgerEntries, b.payment);
      const isGroup = b.capacity != null;
      const seatsBooked = isGroup ? b.seats.filter((s) => s.status === 'BOOKED').length : null;
      const seatsRevenue = isGroup
        ? b.seats
          .filter((s) => s.status !== 'CANCELLED' && s.status !== 'EXPIRED')
          .reduce((sum, s) => sum + s.price, 0)
        : null;
      const passType = passByBooking.get(b.id);

      bookings.push({
        startTime: b.startTime,
        endTime: b.endTime,
        courtName: b.court.name,
        isGroup,
        seatsBooked,
        capacity: b.capacity,
        status: b.status,
        label: bookingLabel(b),
        phone: b.customerPhone ?? '',
        source: b.source,
        channel: b.trafficChannel,
        priceTotal: b.priceTotal,
        trainerPrice: b.trainerPrice,
        rentalTotal: b.rentalTotal,
        seatsRevenue,
        promoNames: b.promoNames,
        promoDiscount: b.promoDiscount,
        paid: m.paid,
        methods: m.methods,
        passUsed: passType ? (PASS_TYPE_LABELS[passType] ?? 'Так') : '',
        refunded: m.refunded,
        cancelledByLabel: cancelledByLabel(b.status, b.cancelledBy),
        cancelledAt: b.cancelledAt,
        /* Групові заняття відмітку відвідування не підтримують узагалі
           (lib/attendance.ts: GROUP_ATTENDANCE_NOT_SUPPORTED) — порожньо,
           а не UNKNOWN, щоб не виглядало забутою галочкою. */
        attendance: isGroup ? null : b.attendance,
        createdAt: b.createdAt,
      });

      for (const s of b.seats) {
        const sm = moneySummary(s.ledgerEntries, s.payment);
        seats.push({
          bookingTitle: b.title,
          startTime: b.startTime,
          endTime: b.endTime,
          courtName: b.court.name,
          status: s.status,
          customerName: s.customerName,
          phone: s.customerPhone,
          source: s.source,
          price: s.price,
          paid: sm.paid,
          methods: sm.methods,
          refunded: sm.refunded,
          createdAt: s.createdAt,
          cancelledAt: s.cancelledAt,
        });
      }
    }

    if (page.length < EXPORT_CHUNK) break;
    skip += EXPORT_CHUNK;
  }

  return { bookings, seats };
}

/* ── Колонки ──────────────────────────────────────────────────────────── */

type BookingColumn = { header: string; width: number; cell: (r: BookingExportRow) => CellValue };
type SeatColumn = { header: string; width: number; cell: (r: SeatExportRow) => CellValue };

function bookingColumns(tz: string): BookingColumn[] {
  return [
    { header: 'Дата', width: 12, cell: (r) => localDate(r.startTime, tz) },
    { header: 'Початок', width: 9, cell: (r) => localTime(r.startTime, tz) },
    { header: 'Кінець', width: 9, cell: (r) => localTime(r.endTime, tz) },
    { header: 'Корт', width: 18, cell: (r) => r.courtName },
    { header: 'Тип', width: 11, cell: (r) => (r.isGroup ? 'Групове' : 'Приватна') },
    { header: 'Статус', width: 24, cell: (r) => STATUS_LABELS[r.status] ?? r.status },
    { header: 'Клієнт / заняття', width: 26, cell: (r) => r.label },
    /* Телефон рядком, як у customerRoster.ts: числом Excel зʼїсть «+». */
    { header: 'Телефон', width: 16, cell: (r) => r.phone },
    { header: 'Місць зайнято', width: 13, cell: (r) => r.seatsBooked ?? '' },
    { header: 'Місткість', width: 11, cell: (r) => r.capacity ?? '' },
    { header: 'Джерело', width: 15, cell: (r) => SOURCE_LABELS[r.source] ?? r.source },
    { header: 'Канал трафіку', width: 15, cell: (r) => (r.channel ? CHANNEL_LABELS[r.channel].name : '') },
    { header: 'Ціна, грн', width: 12, cell: (r) => money(r.priceTotal) },
    { header: 'з них корт, грн', width: 14, cell: (r) => money(r.priceTotal - r.trainerPrice - r.rentalTotal) },
    { header: 'з них тренер, грн', width: 15, cell: (r) => money(r.trainerPrice) },
    { header: 'з них прокат, грн', width: 15, cell: (r) => money(r.rentalTotal) },
    { header: 'Виручка з місць, грн', width: 17, cell: (r) => (r.seatsRevenue != null ? money(r.seatsRevenue) : '') },
    { header: 'Акції', width: 24, cell: (r) => r.promoNames.join(', ') },
    { header: 'Знижка за акціями, грн', width: 18, cell: (r) => money(r.promoDiscount) },
    { header: 'Сплачено, грн', width: 13, cell: (r) => money(r.paid) },
    { header: 'Спосіб оплати', width: 20, cell: (r) => r.methods },
    { header: 'Абонемент', width: 16, cell: (r) => r.passUsed },
    { header: 'Повернення, грн', width: 14, cell: (r) => money(r.refunded) },
    { header: 'Скасував', width: 26, cell: (r) => r.cancelledByLabel },
    { header: 'Скасовано', width: 16, cell: (r) => localStamp(r.cancelledAt, tz) },
    { header: 'Відвідування', width: 14, cell: (r) => (r.attendance ? ATTENDANCE_LABELS[r.attendance] : '') },
    { header: 'Створено', width: 16, cell: (r) => localStamp(r.createdAt, tz) },
  ];
}

function seatColumns(tz: string): SeatColumn[] {
  return [
    { header: 'Дата', width: 12, cell: (r) => localDate(r.startTime, tz) },
    { header: 'Початок', width: 9, cell: (r) => localTime(r.startTime, tz) },
    { header: 'Кінець', width: 9, cell: (r) => localTime(r.endTime, tz) },
    { header: 'Корт', width: 18, cell: (r) => r.courtName },
    { header: 'Заняття', width: 22, cell: (r) => r.bookingTitle ?? '' },
    { header: 'Статус місця', width: 18, cell: (r) => SEAT_STATUS_LABELS[r.status] ?? r.status },
    { header: 'Клієнт', width: 24, cell: (r) => r.customerName },
    { header: 'Телефон', width: 16, cell: (r) => r.phone },
    { header: 'Джерело', width: 15, cell: (r) => SOURCE_LABELS[r.source] ?? r.source },
    { header: 'Ціна, грн', width: 12, cell: (r) => money(r.price) },
    { header: 'Сплачено, грн', width: 13, cell: (r) => money(r.paid) },
    { header: 'Спосіб оплати', width: 20, cell: (r) => r.methods },
    { header: 'Повернення, грн', width: 14, cell: (r) => money(r.refunded) },
    { header: 'Створено', width: 16, cell: (r) => localStamp(r.createdAt, tz) },
    { header: 'Скасовано', width: 16, cell: (r) => localStamp(r.cancelledAt, tz) },
  ];
}

/* ── Книга і CSV ──────────────────────────────────────────────────────── */

export type BookingExportMeta = {
  clubName: string;
  timezone: string;
  now: Date;
  /** null = без нижньої межі: «весь час». */
  from: Date | null;
  /** null = без верхньої межі: по сьогодні. */
  to: Date | null;
};

function periodLabel(meta: BookingExportMeta): string {
  if (!meta.from && !meta.to) return 'весь час';
  const d = (date: Date) => DateTime.fromJSDate(date).setZone(meta.timezone).toFormat('dd.LL.yyyy');
  return `${meta.from ? d(meta.from) : 'початок'} — ${meta.to ? d(meta.to) : 'сьогодні'}`;
}

/**
 * Книга Excel: броні, місця в групових заняттях і аркуш «Як читати».
 *
 * Третій аркуш — з тієї ж причини, що й у картотеки клієнтів
 * (customerRoster.ts): файл переживе вкладку браузера, і без пояснення
 * «чому в групи Ціна не збігається з виручкою» бухгалтер зведе цифри
 * неправильно рівно там, де це найдорожче.
 */
export function bookingExportWorkbookSheets(
  data: { bookings: BookingExportRow[]; seats: SeatExportRow[] },
  meta: BookingExportMeta,
): SheetSpec[] {
  const bCols = bookingColumns(meta.timezone);
  const sCols = seatColumns(meta.timezone);

  const paidTotal = data.bookings.reduce((s, r) => s + r.paid, 0) + data.seats.reduce((s, r) => s + r.paid, 0);
  const refundedTotal = data.bookings.reduce((s, r) => s + r.refunded, 0) + data.seats.reduce((s, r) => s + r.refunded, 0);

  const guide: CellValue[][] = [
    ['Клуб', meta.clubName],
    ['Вивантажено', localStamp(meta.now, meta.timezone)],
    ['Період', periodLabel(meta)],
    ['Часовий пояс дат і часу у файлі', meta.timezone],
    ['Рядків у «Бронювання»', data.bookings.length],
    ['Рядків у «Місця в групових заняттях»', data.seats.length],
    ['Сплачено разом, грн', money(paidTotal)],
    ['Повернено разом, грн', money(refundedTotal)],
    [],
    ['Як читати «Бронювання»', ''],
    ['Один рядок', 'Одна бронь корту — приватна або контейнер групового заняття.'],
    [
      'Для групового заняття',
      '«Ціна» — вартість корту (що коштує клубу ця година), а не гроші з учасників: так само, як це поле означає в самій системі. Реальна виручка групи — колонка «Виручка з місць» тут і по рядку на кожну людину на аркуші «Місця в групових заняттях».',
    ],
    ['з них корт / тренер / прокат', 'Розкладка «Ціни» на складові. Акції й персональні знижки вже враховані в самій «Ціні», а не в розкладці.'],
    ['Сплачено', 'Гроші, що фактично надійшли й лишаються в клубі — за вирахуванням повернень. Не каса й не банківська виписка.'],
    ['Абонемент', 'Заповнено, коли візит списано з абонемента клієнта, а не оплачено грошима.'],
    ['Скасував', '«Клієнт / без відмітки в кабінеті» — скасовано за посиланням клієнтом або автоматично, без дії персоналу клубу.'],
    [],
    ['Як читати «Місця в групових заняттях»', ''],
    [
      'Навіщо окремий аркуш',
      'Групове заняття — одна бронь корту, а платить кожен учасник окремо. «Бронювання» показує заняття цілком, цей аркуш — кожну людину, яка записалась, з її ціною й оплатою.',
    ],
    ['Абонемент у групі', 'Не рахується: місця в групових заняттях оплачуються тільки грошима, списання з абонемента веде через усю бронь, не через місце.'],
    [],
    ['Персональні дані', 'Файл містить телефони й імена клієнтів вашого клубу. Зберігайте його як персональні дані: не пересилайте відкритими каналами і не лишайте на спільному комп’ютері.'],
  ];

  return [
    {
      name: 'Бронювання',
      headers: bCols.map((c) => c.header),
      widths: bCols.map((c) => c.width),
      rows: data.bookings.map((row) => bCols.map((c) => c.cell(row))),
    },
    {
      name: 'Місця в групових заняттях',
      headers: sCols.map((c) => c.header),
      widths: sCols.map((c) => c.width),
      rows: data.seats.map((row) => sCols.map((c) => c.cell(row))),
    },
    {
      name: 'Як читати',
      headers: ['Показник', 'Значення'],
      widths: [34, 100],
      rows: guide,
    },
  ];
}

/* ── CSV ──────────────────────────────────────────────────────────────── */

const SEP = ';';

/**
 * Броні в CSV — лише аркуш «Бронювання».
 *
 * CSV не має аркушів, а місця в групових заняттях — інший розріз даних
 * (людина, а не заняття): змішати їх у ті самі рядки означало б або
 * дублювати бронь на кожного учасника, або губити учасників зовсім.
 * Хто хоче звести і те, і те, — завантажує xlsx із двома аркушами.
 */
export function bookingExportCsv(rows: BookingExportRow[], meta: BookingExportMeta): string {
  const cols = bookingColumns(meta.timezone);
  const fmt = (value: CellValue): string => {
    if (value instanceof Date) return DateTime.fromJSDate(value, { zone: 'utc' }).toFormat('dd.LL.yyyy');
    if (value == null) return '';
    return String(value);
  };
  const body = [
    cols.map((c) => c.header),
    ...rows.map((row) => cols.map((c) => fmt(c.cell(row)))),
  ];
  return '﻿' + body.map((row) => row.map(csvCell).join(SEP)).join('\r\n');
}

/** Назва файла: клуб, період і дата вивантаження — щоб кілька файлів не злиплися. */
export function bookingsFileName(meta: BookingExportMeta, extension: 'csv' | 'xlsx'): string {
  const slug = (text: string) =>
    text.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40);
  const stamp = (date: Date) => DateTime.fromJSDate(date).setZone(meta.timezone).toFormat('yyyy-LL-dd');

  const parts = ['броні', slug(meta.clubName)];
  parts.push(
    meta.from || meta.to
      ? `${meta.from ? stamp(meta.from) : 'початок'}_${meta.to ? stamp(meta.to) : 'сьогодні'}`
      : 'весь-час',
  );
  parts.push(stamp(meta.now));
  return `${parts.filter(Boolean).join('-')}.${extension}`;
}
