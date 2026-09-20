import { describe, expect, it, vi } from 'vitest';

/**
 * Картотека клубу: сегменти, розмежування клубів і файли вивантаження.
 *
 * Найважливіше тут — не формат колонок, а те, що запит НІКОЛИ не виходить
 * за межі свого клубу. База клієнтів спільна на всю платформу, тож єдине,
 * що відділяє один клуб від іншого, — умови в цих трьох запитах. Тести
 * нижче читають саме їх, а не результат: результат на моку можна намалювати
 * який завгодно, а ось забутий `clubId` видно лише у `where`.
 */

const findMany = {
  customer: vi.fn(),
  booking: vi.fn(),
  bookingSeat: vi.fn(),
};

vi.mock('./db', () => ({
  prisma: {
    customer: { findMany: (args: unknown) => findMany.customer(args) },
    booking: { findMany: (args: unknown) => findMany.booking(args) },
    bookingSeat: { findMany: (args: unknown) => findMany.bookingSeat(args) },
  },
}));

const {
  loadRoster,
  rosterCsv,
  rosterFileName,
  rosterWorkbookSheets,
  tierCounts,
  tierOf,
  searchCondition,
  csvCell,
  TIER_LABELS,
} = await import('./customerRoster');

const NOW = new Date('2026-09-19T10:00:00Z');
const CLUB = '11111111-1111-1111-1111-111111111111';
const TZ = 'Europe/Kyiv';

const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const customer = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Іван Петренко',
  phone: '+380671234567',
  email: 'ivan@example.com',
  note: null,
  tags: [],
  isBlocked: false,
  requiresPrepay: false,
  createdAt: daysAgo(400),
  telegramChatId: null,
  birthDate: null,
  discountPercent: 0,
  bonusBalance: 0,
  ...over,
});

function mockDb(opts: {
  customers?: Record<string, unknown>[];
  bookings?: Record<string, unknown>[];
  seats?: Record<string, unknown>[];
} = {}) {
  findMany.customer.mockReset().mockResolvedValue(opts.customers ?? [customer()]);
  findMany.booking.mockReset().mockResolvedValue(opts.bookings ?? []);
  findMany.bookingSeat.mockReset().mockResolvedValue(opts.seats ?? []);
}

const meta = (filter = {}) => ({
  clubName: 'Корт на Січових',
  timezone: TZ,
  now: NOW,
  filter,
});

/* ── Розмежування клубів ──────────────────────────────────────────────── */

describe('loadRoster — межі клубу', () => {
  it('питає лише клієнтів свого клубу', async () => {
    mockDb();
    await loadRoster(CLUB, {}, NOW);

    expect(findMany.customer.mock.calls[0][0].where.clubId).toBe(CLUB);
  });

  it('візити з броней бере лише свого клубу', async () => {
    mockDb();
    await loadRoster(CLUB, {}, NOW);

    expect(findMany.booking.mock.calls[0][0].where.clubId).toBe(CLUB);
  });

  /* Найтонше місце всієї картотеки: у BookingSeat свого clubId немає —
     лише в броні-контейнері. Без цієї умови відвідування чужого клубу
     дописались би в нашу картку. */
  it('місця в групових фільтрує через клуб броні-контейнера', async () => {
    mockDb();
    await loadRoster(CLUB, {}, NOW);

    expect(findMany.bookingSeat.mock.calls[0][0].where.booking.clubId).toBe(CLUB);
  });

  it('порожня картотека не йде за візитами взагалі', async () => {
    mockDb({ customers: [] });
    const rows = await loadRoster(CLUB, {}, NOW);

    expect(rows).toEqual([]);
    expect(findMany.booking).not.toHaveBeenCalled();
    expect(findMany.bookingSeat).not.toHaveBeenCalled();
  });

  it('скасоване не рахується візитом у жодному джерелі', async () => {
    mockDb();
    await loadRoster(CLUB, {}, NOW);

    expect(findMany.booking.mock.calls[0][0].where.status).toBe('CONFIRMED');
    expect(findMany.bookingSeat.mock.calls[0][0].where.status).toBe('BOOKED');
    expect(findMany.bookingSeat.mock.calls[0][0].where.booking.status).toBe('CONFIRMED');
  });

  it('майбутній запис ще не візит', async () => {
    mockDb();
    await loadRoster(CLUB, {}, NOW);

    expect(findMany.booking.mock.calls[0][0].where.startTime).toEqual({ lte: NOW });
  });
});

describe('loadRoster — збирання', () => {
  it('складає візити з броней і з групових місць', async () => {
    mockDb({
      bookings: [{ customerId: 'c1', priceTotal: 40_000, startTime: daysAgo(10) }],
      seats: [{ customerId: 'c1', price: 25_000, booking: { startTime: daysAgo(3) } }],
    });
    const [row] = await loadRoster(CLUB, {}, NOW);

    expect(row.visits).toBe(2);
    expect(row.spend).toBe(65_000);
    /* Останній візит — найпізніший із ДВОХ джерел, а не з броней. */
    expect(row.lastVisit).toBe(daysAgo(3).toISOString());
  });

  it('людина без жодного запису лишається в картотеці', async () => {
    mockDb();
    const [row] = await loadRoster(CLUB, {}, NOW);

    expect(row.visits).toBe(0);
    expect(row.lastVisit).toBeNull();
    expect(row.tier).toBe('LOST');
  });
});

describe('searchCondition', () => {
  it('без запиту умови немає', () => {
    expect(searchCondition(undefined)).toBeNull();
  });

  /* Пошук по літерах колись падав цілком: у OR підставлявся «свідомо
     неможливий» рядок із нульовим байтом, і Postgres відхиляв увесь запит
     помилкою 22021. Тепер умови просто немає. */
  it('по літерах не чіпає телефон', () => {
    const or = searchCondition('Іван')!;

    expect(or).toHaveLength(2);
    expect(JSON.stringify(or)).not.toContain('phoneTail');
  });

  it('по цифрах шукає за хвостом номера', () => {
    const or = searchCondition('067 123 45 67')!;

    expect(or.at(-1)).toEqual({ phoneTail: { endsWith: '1234567' } });
  });

  it('двох цифр для пошуку по номеру замало', () => {
    expect(JSON.stringify(searchCondition('67'))).not.toContain('phoneTail');
  });
});

/* ── Сегменти ─────────────────────────────────────────────────────────── */

describe('tierCounts', () => {
  it('рахує всі чотири сегменти, зокрема порожні', () => {
    const rows = [{ tier: 'ACTIVE' }, { tier: 'ACTIVE' }, { tier: 'LOST' }] as never;

    expect(tierCounts(rows)).toEqual({ ACTIVE: 2, NEW: 0, FADING: 0, LOST: 1 });
  });
});

describe('TIER_LABELS', () => {
  it('кожен сегмент має назву і пояснення, що з ним робити', () => {
    for (const tier of ['NEW', 'ACTIVE', 'FADING', 'LOST'] as const) {
      expect(TIER_LABELS[tier].name).toBeTruthy();
      expect(TIER_LABELS[tier].meaning.length).toBeGreaterThan(20);
    }
  });

  it('межі в поясненнях узгоджені з tierOf', () => {
    /* Пояснення називає конкретні числа днів. Якщо межі зсунуть, а текст
       ні, клуб читатиме у файлі неправду — тому тут перевіряється зв'язок,
       а не сам рядок. */
    expect(TIER_LABELS.FADING.meaning).toContain('30');
    expect(TIER_LABELS.FADING.meaning).toContain('90');
    expect(tierOf(daysAgo(45), daysAgo(400), NOW, 20)).toBe('FADING');
    expect(tierOf(daysAgo(120), daysAgo(400), NOW, 20)).toBe('LOST');
  });
});

/* ── CSV ──────────────────────────────────────────────────────────────── */

describe('csvCell', () => {
  it('знешкоджує значення, які Excel виконає як формулу', () => {
    expect(csvCell('+380671234567')).toBe("'+380671234567");
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-5')).toBe("'-5");
  });

  it('бере в лапки те, що інакше розірве рядок', () => {
    expect(csvCell('Київ; вул. Лесі')).toBe('"Київ; вул. Лесі"');
    expect(csvCell('два\nрядки')).toBe('"два\nрядки"');
    expect(csvCell('лапки "тут"')).toBe('"лапки ""тут"""');
  });

  it('порожнє лишає порожнім', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});

describe('rosterCsv', () => {
  const row = {
    id: 'c1', name: 'Іван', phone: '+380671234567', email: 'i@e.com',
    note: null, tags: ['ранкова'], isBlocked: false, requiresPrepay: false,
    hasCabinet: false, birthDate: null, daysUntilBirthday: null,
    discountPercent: 10, bonusBalance: 5_000, since: daysAgo(100).toISOString(),
    visits: 4, spend: 120_000, lastVisit: daysAgo(3).toISOString(),
    tier: 'NEW' as const,
  };

  it('починається з BOM, інакше Excel покаже кракозябри', () => {
    expect(rosterCsv([row], meta())).toMatch(/^﻿/);
  });

  it('роздільник — крапка з комою', () => {
    const [header] = rosterCsv([row], meta()).split('\r\n');

    expect(header).toContain('Імʼя;Телефон;Email;Сегмент');
  });

  it('гроші віддає гривнями, а не копійками', () => {
    const [, body] = rosterCsv([row], meta()).split('\r\n');

    expect(body).toContain('1200');   // 120 000 копійок
    expect(body).toContain('300');    // середній чек 120000/4 = 30000 коп
  });

  it('сегмент пише словом, а не кодом', () => {
    expect(rosterCsv([row], meta())).toContain('Новачок');
    expect(rosterCsv([row], meta())).not.toContain('NEW');
  });

  it('порожня вибірка — це шапка без рядків, а не порожній файл', () => {
    const text = rosterCsv([], meta());

    expect(text.split('\r\n')).toHaveLength(1);
    expect(text).toContain('Телефон');
  });
});

/* ── Книга Excel ──────────────────────────────────────────────────────── */

describe('rosterWorkbookSheets', () => {
  const rows = [
    {
      id: 'c1', name: 'Іван', phone: '+380671234567', email: null, note: null,
      tags: [], isBlocked: false, requiresPrepay: false, hasCabinet: false,
      birthDate: null, daysUntilBirthday: null, discountPercent: 0,
      bonusBalance: 0, since: daysAgo(100).toISOString(), visits: 2,
      spend: 60_000, lastVisit: daysAgo(5).toISOString(), tier: 'NEW' as const,
    },
  ];

  it('дає два аркуші: дані і пояснення', () => {
    const [data, guide] = rosterWorkbookSheets(rows, meta());

    expect(data.name).toBe('Картотека');
    expect(guide.name).toBe('Як читати');
  });

  it('кількість колонок збігається з кількістю ширин і значень', () => {
    const [data] = rosterWorkbookSheets(rows, meta());

    expect(data.widths).toHaveLength(data.headers.length);
    expect(data.rows[0]).toHaveLength(data.headers.length);
  });

  /* Телефон у Excel мусить лишитись текстом: як число він втрачає «+» і
     показується в експоненційній формі. */
  it('телефон лишає рядком', () => {
    const [data] = rosterWorkbookSheets(rows, meta());
    const at = data.headers.indexOf('Телефон');

    expect(data.rows[0][at]).toBe('+380671234567');
  });

  it('дати віддає обʼєктом Date, щоб Excel умів їх сортувати', () => {
    const [data] = rosterWorkbookSheets(rows, meta());
    const at = data.headers.indexOf('Останній візит');

    expect(data.rows[0][at]).toBeInstanceOf(Date);
  });

  it('аркуш пояснень називає клуб, відбір і кількість карток', () => {
    const [, guide] = rosterWorkbookSheets(rows, meta({ tier: 'LOST' as const }));
    const text = JSON.stringify(guide.rows);

    expect(text).toContain('Корт на Січових');
    expect(text).toContain('Втрачений');
    expect(guide.rows.some((r) => r[0] === 'Карток у файлі' && r[1] === 1)).toBe(true);
  });

  it('без фільтрів так і пише — уся картотека', () => {
    const [, guide] = rosterWorkbookSheets(rows, meta());

    expect(JSON.stringify(guide.rows)).toContain('уся картотека клубу');
  });

  it('попереджає, що у файлі персональні дані', () => {
    const [, guide] = rosterWorkbookSheets(rows, meta());

    expect(JSON.stringify(guide.rows)).toContain('Персональні дані');
  });
});

describe('rosterFileName', () => {
  it('містить клуб і дату, щоб два вивантаження не злиплися', () => {
    expect(rosterFileName(meta(), 'xlsx')).toBe('клієнти-Корт-на-Січових-2026-09-19.xlsx');
  });

  it('називає відбір, якщо він був', () => {
    const name = rosterFileName(meta({ tier: 'LOST' as const, tag: 'діти' }), 'csv');

    expect(name).toContain('Втрачений');
    expect(name).toContain('діти');
    expect(name.endsWith('.csv')).toBe(true);
  });

  /* Назва клубу приходить від людини: слеш чи двокрапка в ній зробили б
     файл із підкаталогом у дорозі. */
  it('прибирає з назви все, що не літера й не цифра', () => {
    const name = rosterFileName({ ...meta(), clubName: 'Корт/Сіті: №1' }, 'xlsx');

    expect(name).not.toMatch(/[/:]/);
  });
});
