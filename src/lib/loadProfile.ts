import { DateTime } from 'luxon';

/**
 * Профіль завантаження клубу: який день тижня і яка година доби реально
 * заповнені.
 *
 * ── Чому не просто «порахувати броні по годинах» ─────────────────────────
 *
 * Кількість броней на годину нічого не означає без місткості. 20:00 з трьома
 * бронями на шести кортах — це половина порожня, а 08:00 з двома на двох
 * відкритих кортах — це аншлаг. Тому все тут — дріб: продані хвилини поділені
 * на доступні. Доступні рахуються з ClubHours × активні корти − Block.
 *
 * ── Чому окремий файл і чиста функція ────────────────────────────────────
 *
 * Рівно з тієї ж причини, що й slots.ts: помилка в арифметиці часу тут
 * непомітна на око (графік буде красивий і неправильний), а перевірити її
 * можна лише тестом із фіксованим «зараз» і без бази.
 */

export type HoursRow = {
  /** 0 = неділя … 6 = субота, як у ClubHours */
  weekday: number;
  /** Хвилини від опівночі за локальним часом клубу */
  openMinute: number;
  /** Може бути > 1440, якщо клуб працює за північ (26*60 = 02:00) */
  closeMinute: number;
  isClosed: boolean;
};

/**
 * createdAt дозволяє не рахувати простій корту до того, як його завели.
 *
 * Необов'язковий: у моделі Court дати створення НЕМАЄ, і додати її
 * міграцією не можна чесно — наявним кортам проставилось би now(), тобто
 * весь минулий період вони б виглядали неіснуючими. Тому роут поле не
 * передає, а вікно натомість обрізається датою створення клубу.
 */
export type CourtRow = { id: string; createdAt?: Date };

/** courtId = null означає, що закрито весь клуб */
export type BlockRow = { courtId: string | null; startTime: Date; endTime: Date };

export type BookingRow = {
  courtId: string;
  startTime: Date;
  endTime: Date;
  /** Копійки, зафіксовані на момент броні (повна сума клієнта) */
  priceTotal: number;
  /** Виручка КОРТУ без тренера/прокату й за вартістю абонемента
      (lib/serviceValue.ts courtValueOf). Немає — береться priceTotal. */
  courtValue?: number;
};

export type LoadCell = {
  /** Доступні хвилини: відкриті години × корти − блокування */
  openMinutes: number;
  bookedMinutes: number;
  /** Скільки броней ПОЧАЛОСЬ у цій клітинці */
  bookings: number;
  /** Копійки. Уся сума броні йде в клітинку її початку */
  revenue: number;
};

export type LoadBucket = LoadCell & {
  /** bookedMinutes / openMinutes, 0..1 */
  occupancy: number;
};

export type LoadProfileInput = {
  /** Межі вікна, UTC */
  from: Date;
  to: Date;
  timezone: string;
  hours: HoursRow[];
  /** Тільки активні корти клубу */
  courts: CourtRow[];
  blocks: BlockRow[];
  /** Тільки CONFIRMED-броні у вікні */
  bookings: BookingRow[];
};

export type LoadProfile = {
  byWeekday: (LoadBucket & { weekday: number })[];
  byHour: (LoadBucket & { hour: number })[];
  /**
   * Уся матриця «день × година» пласким списком — для теплової карти.
   *
   * Тільки ті години, коли клуб хоч колись відчинений (ті самі, що в
   * byHour), зате ВСІ сім днів кожної з них. Клітинка з openMinutes = 0 —
   * це «зачинено», і карта має малювати її штриховкою, а не нулем:
   * порожня неділя і зачинена неділя — різні розмови.
   */
  cells: (LoadBucket & { weekday: number; hour: number })[];
  totals: LoadBucket;
};

const overlapMs = (aFrom: number, aTo: number, bFrom: number, bTo: number) =>
  Math.max(0, Math.min(aTo, bTo) - Math.max(aFrom, bFrom));

/**
 * З якої хвилини доба вважається «своєю».
 *
 * Клуб, що працює до 02:00, у п'ятницю ввечері продає години, які за
 * календарем уже субота. Для профілю днів тижня це п'ятниця: інакше
 * найдорожчі нічні години розмазуються на наступний день, і «субота»
 * виглядає популярнішою рівно тому, що п'ятниця пізно зачиняється.
 *
 * Поріг один на клуб (найпізніше закриття з усіх семи днів), а не свій на
 * кожен день: так одна й та сама хвилина завжди належить одному й тому ж
 * дню, з якого боку на неї не подивись.
 */
export function clubDayCutoff(hours: HoursRow[]): number {
  const latest = hours.reduce((m, h) => (h.isClosed ? m : Math.max(m, h.closeMinute)), 0);
  return Math.max(0, latest - 1440);
}

/** День тижня клубу (0=Нд) для моменту часу з урахуванням роботи за північ */
export function clubWeekday(dt: DateTime, cutoffMinute: number): number {
  const minuteOfDay = dt.hour * 60 + dt.minute;
  const day = minuteOfDay < cutoffMinute ? dt.minus({ days: 1 }) : dt;
  // Luxon: 1=Пн..7=Нд -> наша схема 0=Нд..6=Сб (той самий перерахунок, що в public.ts)
  return day.weekday % 7;
}

/**
 * Розкладає інтервал на відрізки по межах годин ЛОКАЛЬНОГО часу клубу.
 *
 * Це та частина, заради якої весь файл. Бронь 19:00–21:00, зарахована цілком
 * у «19», робить 20-ту годину порожньою на графіку — при тому, що корт
 * зайнятий. Хвилини мають лягати в кожну зачеплену годину.
 *
 * Довжина відрізка береться різницею моментів, а не відніманням номерів
 * годин: у ніч переходу на зимовий час 03:00 триває дві реальні години, і
 * тільки різниця моментів це помічає.
 */
export function eachHourSegment(
  startMs: number,
  endMs: number,
  timezone: string,
  visit: (hour: number, minutes: number, at: DateTime, first: boolean) => void,
): void {
  if (endMs <= startMs) return;

  let cursor = DateTime.fromMillis(startMs).setZone(timezone);
  const end = DateTime.fromMillis(endMs).setZone(timezone);
  let first = true;

  /* Запобіжник від нескінченного циклу: якщо Luxon раптом віддасть невалідну
     дату, plus() не зрушить курсор і цикл зависне назавжди. Коло тижнів
     вікна вистачає з великим запасом. */
  let guard = 0;

  while (cursor < end && guard < 100_000) {
    guard += 1;
    const nextHour = cursor.plus({ hours: 1 }).startOf('hour');
    const segEnd = nextHour < end ? nextHour : end;
    const minutes = segEnd.diff(cursor, 'minutes').minutes;
    if (minutes <= 0) break;
    visit(cursor.hour, minutes, cursor, first);
    first = false;
    cursor = segEnd;
  }
}

const emptyCell = (): LoadCell => ({
  openMinutes: 0,
  bookedMinutes: 0,
  bookings: 0,
  revenue: 0,
});

/**
 * Головна функція. Повертає два зрізи однієї матриці «день × година»:
 * по днях тижня і по годинах доби.
 *
 * Матриця будується цілком, а згортається двічі — щоб теплова карта
 * «день × година» колись з'явилась без другого проходу по даних.
 */
export function buildLoadProfile(input: LoadProfileInput): LoadProfile {
  const { from, to, timezone, hours, courts, blocks, bookings } = input;

  const cutoff = clubDayCutoff(hours);
  const hoursByWeekday = new Map(hours.map((h) => [h.weekday, h]));

  /** cells[weekday][hour] */
  const cells: LoadCell[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, emptyCell));

  const fromMs = from.getTime();
  const toMs = to.getTime();

  /* ── Знаменник: скільки хвилин клуб узагалі МІГ продати ──────────────── */

  const clubBlocks = blocks.filter((b) => b.courtId == null);
  const courtBlocks = new Map<string, BlockRow[]>();
  for (const b of blocks) {
    if (b.courtId == null) continue;
    const list = courtBlocks.get(b.courtId) ?? [];
    list.push(b);
    courtBlocks.set(b.courtId, list);
  }

  /* Починаємо на добу раніше вікна: у клуба, що працює за північ, робоче
     вікно попереднього дня заходить усередину нашого періоду. Усі відрізки
     все одно обрізаються по [from, to]. */
  const firstDay = DateTime.fromJSDate(from).setZone(timezone).startOf('day').minus({ days: 1 });
  const lastDay = DateTime.fromJSDate(to).setZone(timezone).startOf('day');

  for (let day = firstDay; day <= lastDay; day = day.plus({ days: 1 })) {
    const weekday = day.weekday % 7;
    const row = hoursByWeekday.get(weekday);
    if (!row || row.isClosed || row.closeMinute <= row.openMinute) continue;

    const winStart = day.plus({ minutes: row.openMinute });
    const winEnd = day.plus({ minutes: row.closeMinute });

    const segFrom = Math.max(winStart.toMillis(), fromMs);
    const segTo = Math.min(winEnd.toMillis(), toMs);
    if (segTo <= segFrom) continue;

    for (const court of courts) {
      /* Корт не міг простоювати до того, як його завели — якщо ми взагалі
         знаємо, коли це було (див. коментар до CourtRow). */
      const courtFrom = court.createdAt
        ? Math.max(segFrom, court.createdAt.getTime())
        : segFrom;
      if (segTo <= courtFrom) continue;

      const mine = courtBlocks.get(court.id) ?? [];

      eachHourSegment(courtFrom, segTo, timezone, (hour, minutes, at) => {
        const hFrom = at.toMillis();
        const hTo = hFrom + minutes * 60_000;

        let blocked = 0;
        for (const b of clubBlocks) {
          blocked += overlapMs(hFrom, hTo, b.startTime.getTime(), b.endTime.getTime());
        }
        for (const b of mine) {
          blocked += overlapMs(hFrom, hTo, b.startTime.getTime(), b.endTime.getTime());
        }

        /* Блокування клубу і блокування корту можуть накластись одне на
           одне — тоді сума перевищить сам відрізок. Обрізаємо, а не
           виловлюємо перетини: результат той самий, коду вдесятеро менше. */
        const open = Math.max(0, minutes - blocked / 60_000);
        cells[weekday][hour].openMinutes += open;
      });
    }
  }

  /* ── Чисельник: скільки з цього продано ─────────────────────────────── */

  for (const b of bookings) {
    const bFrom = Math.max(b.startTime.getTime(), fromMs);
    const bTo = Math.min(b.endTime.getTime(), toMs);
    if (bTo <= bFrom) continue;

    /* Заняття, що почалось ДО вікна й дотягнулось у нього, віддає нам свої
       хвилини, але не штуку й не гроші: продали його минулого разу. Без
       цієї перевірки перша година вікна отримувала б і чужу бронь, і чужу
       виручку цілком — а в сусідньому вікні ту саму бронь порахували б
       удруге. */
    const startedInside = b.startTime.getTime() >= fromMs;

    eachHourSegment(bFrom, bTo, timezone, (hour, minutes, at, first) => {
      const cell = cells[clubWeekday(at, cutoff)][hour];
      cell.bookedMinutes += minutes;
      /* Штука броні й гроші — тільки в клітинку початку. Інакше двогодинна
         бронь порахувалась би двічі, а виручка клубу подвоїлась би. */
      if (first && startedInside) {
        cell.bookings += 1;
        cell.revenue += b.courtValue ?? b.priceTotal;
      }
    });
  }

  /* ── Згортки ────────────────────────────────────────────────────────── */

  const fold = (list: LoadCell[]): LoadBucket => {
    const sum = list.reduce<LoadCell>((acc, c) => ({
      openMinutes: acc.openMinutes + c.openMinutes,
      bookedMinutes: acc.bookedMinutes + c.bookedMinutes,
      bookings: acc.bookings + c.bookings,
      revenue: acc.revenue + c.revenue,
    }), emptyCell());

    return {
      openMinutes: Math.round(sum.openMinutes),
      bookedMinutes: Math.round(sum.bookedMinutes),
      bookings: sum.bookings,
      revenue: sum.revenue,
      /* Обрізаємо одиницею: адміністратор може завести бронь поза робочими
         годинами, і без цього клуб побачив би завантаження 130%. */
      occupancy: sum.openMinutes > 0
        ? Math.min(1, Math.round((sum.bookedMinutes / sum.openMinutes) * 10_000) / 10_000)
        : 0,
    };
  };

  const byWeekday = cells.map((row, weekday) => ({ weekday, ...fold(row) }));

  const byHour = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    ...fold(cells.map((row) => row[hour])),
  })).filter((h) => h.openMinutes > 0);

  /* Години беремо з byHour, а не всі 24: показувати клубу ніч, коли він
     ніколи не працює, — це 9 порожніх рядків карти з нічого. */
  const grid = byHour.flatMap((h) => Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    hour: h.hour,
    ...fold([cells[weekday][h.hour]]),
  })));

  return {
    byWeekday,
    byHour,
    cells: grid,
    totals: fold(cells.flat()),
  };
}
