import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /admin/analytics/bookings/export — вивантаження всіх броней клубу.
 *
 * Дзеркалить customers-export.test.ts: та сама перевірка «кому можна
 * винести базу одним файлом», тільки тут це історія записів, а не
 * телефонна книга. Формат самого файла (колонки, суми, аркуші) — не тут:
 * це справа lib/bookingExport.ts, а цей тест перевіряє маршрут навколо
 * нього — роль, межі клубу й журнал.
 */

const prisma = {
  club: { findUnique: vi.fn() },
  user: { findFirst: vi.fn() },
  booking: { findMany: vi.fn() },
  passUsage: { findMany: vi.fn() },
  changeLog: { createMany: vi.fn() },
};

vi.mock('../lib/db', () => ({ prisma }));

let role = 'OWNER';
vi.mock('./admin', async () => {
  const shared = await vi.importActual<typeof import('./admin/shared')>('./admin/shared');
  return {
    requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
      req.auth = { userId: 'user-1', clubId: 'club-1', role, trainerId: null };
      next();
    },
    requireRole: shared.requireRole,
    requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

const { analyticsRouter } = await import('./analytics');
const app = express().use(analyticsRouter);

const get = (query = '') => request(app).get(`/bookings/export${query}`);

/** Приватна бронь без нічого зайвого — базовий рядок для більшості тестів. */
const plainBooking = {
  id: 'b-plain',
  startTime: new Date('2025-06-10T07:00:00.000Z'),
  endTime: new Date('2025-06-10T08:00:00.000Z'),
  status: 'CONFIRMED',
  capacity: null,
  title: null,
  customerName: 'Іван Петренко',
  customerPhone: '+380671234567',
  source: 'ADMIN',
  trafficChannel: 'RECEPTION',
  priceTotal: 50000,
  trainerPrice: 0,
  rentalTotal: 0,
  promoNames: [],
  promoDiscount: 0,
  attendance: 'UNKNOWN',
  createdAt: new Date('2025-06-01T10:00:00.000Z'),
  cancelledAt: null,
  cancelledBy: null,
  court: { name: 'Корт 1' },
  payment: null,
  ledgerEntries: [],
  seats: [],
};

/** Групове заняття з тренером, прокатом, акцією й одним записаним місцем —
    рядок, що покриває одразу всі «складні» колонки файла. */
const groupBooking = {
  id: 'b-group',
  startTime: new Date('2025-06-12T17:00:00.000Z'),
  endTime: new Date('2025-06-12T18:00:00.000Z'),
  status: 'CONFIRMED',
  capacity: 8,
  title: 'Ранкова йога',
  customerName: null,
  customerPhone: null,
  source: 'WIDGET',
  trafficChannel: 'SOCIAL',
  priceTotal: 60000,
  trainerPrice: 20000,
  rentalTotal: 5000,
  promoNames: ['Літня знижка'],
  promoDiscount: 3000,
  attendance: 'UNKNOWN',
  createdAt: new Date('2025-06-01T10:00:00.000Z'),
  cancelledAt: null,
  cancelledBy: null,
  court: { name: 'Зал йоги' },
  payment: null,
  ledgerEntries: [
    { kind: 'PAYMENT', method: 'CARD', amount: 60000 },
  ],
  seats: [
    {
      customerName: 'Олена Коваль',
      customerPhone: '+380509998877',
      status: 'BOOKED',
      source: 'WIDGET',
      price: 30000,
      createdAt: new Date('2025-06-02T09:00:00.000Z'),
      cancelledAt: null,
      payment: null,
      ledgerEntries: [{ kind: 'PAYMENT', method: 'CASH', amount: 30000 }],
    },
  ],
};

beforeEach(() => {
  role = 'OWNER';
  vi.resetAllMocks();
  prisma.club.findUnique.mockResolvedValue({ name: 'Корт на Січових', timezone: 'Europe/Kyiv' });
  prisma.user.findFirst.mockResolvedValue({ email: 'owner@club.test' });
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.passUsage.findMany.mockResolvedValue([]);
  prisma.changeLog.createMany.mockResolvedValue({ count: 1 });
});

describe('хто може винести базу броней', () => {
  it('власник — може', async () => {
    expect((await get()).status).toBe(200);
  });

  it('адміністратор — ні', async () => {
    role = 'ADMIN';
    const res = await get();

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('відмова не лишає сліду в журналі', async () => {
    role = 'ADMIN';
    await get();

    expect(prisma.changeLog.createMany).not.toHaveBeenCalled();
  });
});

describe('межі клубу', () => {
  it('клуб береться з токена', async () => {
    await get();

    expect(prisma.club.findUnique.mock.calls[0][0].where.id).toBe('club-1');
    expect(prisma.booking.findMany.mock.calls[0][0].where.clubId).toBe('club-1');
  });

  /* Параметра «вивантажити інший клуб» не існує — спроба підставити чужий
     clubId не повинна нічого змінити навіть випадково. */
  it('чужий clubId у запиті ігнорується', async () => {
    await get('?clubId=club-2&club=club-2');

    expect(prisma.booking.findMany.mock.calls[0][0].where.clubId).toBe('club-1');
  });

  it('чужого клубу дані в файл не потрапляють, бо запит фільтрує по токену, а не по відповіді мока', async () => {
    /* Мок не знає про clubId і віддав би що завгодно — тому доказ саме в
       тому, ЯКИМ запитом бронь просили, а не в тому, що прийшло у відповідь. */
    prisma.booking.findMany.mockResolvedValue([{ ...plainBooking, id: 'foreign' }]);
    await get();

    expect(prisma.booking.findMany.mock.calls[0][0].where.clubId).toBe('club-1');
    expect(prisma.booking.findMany.mock.calls.length).toBe(1);
  });
});

describe('журнал', () => {
  it('записує, хто і скільки вивантажив', async () => {
    prisma.booking.findMany.mockResolvedValue([plainBooking]);
    await get('?format=csv');
    const [row] = prisma.changeLog.createMany.mock.calls[0][0].data;

    expect(row).toMatchObject({
      clubId: 'club-1',
      entity: 'BookingExport',
      actorId: 'user-1',
      actorEmail: 'owner@club.test',
      actorRole: 'OWNER',
    });
    expect(row.after).toMatchObject({ format: 'csv', rows: 1 });
  });

  it('зберігає період — щоб було видно, за що саме вивантажили', async () => {
    await get('?from=2025-06-01&to=2025-06-30');
    const [row] = prisma.changeLog.createMany.mock.calls[0][0].data;

    expect(row.after).toMatchObject({ from: '2025-06-01', to: '2025-06-30' });
  });

  it('без дат період не задано — типово «весь час»', async () => {
    await get();
    const [row] = prisma.changeLog.createMany.mock.calls[0][0].data;

    expect(row.after).toMatchObject({ from: null, to: null });
  });
});

describe('віддача файла', () => {
  it('xlsx — типовий формат', async () => {
    const res = await get().responseType('blob');

    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.body.subarray(0, 2).toString()).toBe('PK');
  });

  it('csv — коли попросили', async () => {
    const res = await get('?format=csv');

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Клієнт / заняття');
  });

  it('віддає як завантаження, з кирилицею в назві', async () => {
    const disposition = (await get()).headers['content-disposition'];

    expect(disposition).toContain('attachment');
    expect(disposition).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(disposition)).toContain('Корт-на-Січових');
  });

  it('забороняє кешування', async () => {
    expect((await get()).headers['cache-control']).toBe('no-store');
  });

  it('невідомий формат — 400', async () => {
    expect((await get('?format=pdf')).status).toBe(400);
  });

  it('до — раніше за від — 400', async () => {
    expect((await get('?from=2025-06-30&to=2025-06-01')).status).toBe(400);
  });

  it('порожня історія — це файл із шапкою, а не 404', async () => {
    const res = await get('?format=csv');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Клієнт / заняття');
  });
});

describe('колонки й суми: бронь із тренером, прокатом, акцією й місцем', () => {
  it('приватна бронь — базові поля рядка', async () => {
    prisma.booking.findMany.mockResolvedValue([plainBooking]);
    const res = await get('?format=csv');

    expect(res.text).toContain('Корт 1');
    expect(res.text).toContain('Приватна');
    expect(res.text).toContain('Підтверджено');
    expect(res.text).toContain('Іван Петренко');
    expect(res.text).toContain('+380671234567');
    expect(res.text).toContain('Ресепшен');
    /* 50000 копійок = 500 грн */
    expect(res.text).toContain('500');
  });

  it('групова бронь із тренером, прокатом, акцією і записаним місцем', async () => {
    prisma.booking.findMany.mockResolvedValue([groupBooking]);
    const res = await get('?format=csv');

    expect(res.text).toContain('Ранкова йога');
    expect(res.text).toContain('Групове');
    /* Ціна корту, копійки -> грн: 600 = ціна, 200 = тренер, 50 = прокат,
       решта (350) — «з них корт». */
    expect(res.text).toContain('200'); // trainerPrice
    expect(res.text).toContain('50'); // rentalTotal
    expect(res.text).toContain('Літня знижка');
    expect(res.text).toContain('30'); // promoDiscount, 3000 коп
    /* Одне заброньоване місце і його виручка (30000 коп = 300 грн) —
       рахуються в контейнері броні, а не тільки в аркуші місць. */
    expect(res.text).toContain('1'); // seatsBooked
    expect(res.text).toContain('300'); // seatsRevenue
  });

  it('абонемент позначається в рядку броні, коли списання не відкликане', async () => {
    prisma.booking.findMany.mockResolvedValue([plainBooking]);
    prisma.passUsage.findMany.mockResolvedValue([
      { bookingId: 'b-plain', pass: { type: 'PACKAGE' } },
    ]);
    const res = await get('?format=csv');

    expect(res.text).toContain('Пакет занять');
  });
});
