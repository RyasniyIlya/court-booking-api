import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /ai/actions/:id/file — файл-звіт збирається на льоту за ПОТОЧНИМИ правами
 * того, хто качає: закриті колонки знімаються, закритий звіт — 403, чужий клуб
 * і чужа дія — 404. У журналі лежать лише параметри, не сам файл.
 */

const { prisma, buildWorkbook, recordChanges } = vi.hoisted(() => ({
  prisma: {
    club: { findUnique: vi.fn() },
    aiAgentPolicy: { findUnique: vi.fn() },
    aiAction: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    booking: { findMany: vi.fn() },
  },
  buildWorkbook: vi.fn(),
  recordChanges: vi.fn(),
}));
vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('../../lib/changeLog', () => ({ recordChanges }));
vi.mock('../../lib/xlsx', async () => ({ ...(await vi.importActual<object>('../../lib/xlsx')), buildWorkbook }));
vi.mock('../../lib/bookingExport', async () => ({ ...(await vi.importActual<object>('../../lib/bookingExport')), loadBookingExport: vi.fn() }));
vi.mock('../../lib/customerRoster', async () => ({ ...(await vi.importActual<object>('../../lib/customerRoster')), loadRoster: vi.fn() }));
vi.mock('../../lib/ai/gemini', async () => ({ ...(await vi.importActual<object>('../../lib/ai/gemini')), aiConfigured: () => false }));
vi.mock('./shared', async () => {
  const actual = await vi.importActual<typeof import('./shared')>('./shared');
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.auth = { userId: String(req.headers['x-user'] ?? 'u-owner'), clubId: 'club-1', role: String(req.headers['x-role'] ?? 'OWNER'), trainerId: null };
      next();
    },
  };
});

const { loadBookingExport } = await import('../../lib/bookingExport');
const { loadRoster } = await import('../../lib/customerRoster');
const { aiRouter } = await import('./ai');
const app = express().use(express.json()).use('/api/admin', aiRouter);

const ID = '11111111-1111-4111-8111-111111111111';
const PLAN3 = { tier: 3, featTrainers: true, featGroups: true, featAnalytics: true };
const as = (role: string, user = 'u-owner') => ({ 'x-role': role, 'x-user': user });

const bookingRow = {
  startTime: new Date('2026-10-10T15:00:00Z'), endTime: new Date('2026-10-10T16:00:00Z'), courtName: 'Корт 1', isGroup: false,
  seatsBooked: null, capacity: null, status: 'CONFIRMED', label: 'Олена Коваль', phone: '+380671112233', source: 'ADMIN', channel: null,
  priceTotal: 90000, trainerPrice: 0, rentalTotal: 0, seatsRevenue: null, promoNames: [], promoDiscount: 0, paid: 90000, methods: 'Готівка',
  passUsed: '', refunded: 0, cancelledByLabel: 'Адмін (a@club.ua)', cancelledAt: null, attendance: null, createdAt: new Date('2026-10-01T10:00:00Z'),
};
const seatRow = {
  bookingTitle: 'Йога', startTime: bookingRow.startTime, endTime: bookingRow.endTime, courtName: 'Корт 1', status: 'BOOKED',
  customerName: 'Іван', phone: '+380501112233', source: 'WIDGET', price: 20000, paid: 20000, methods: 'Онлайн', refunded: 0,
  createdAt: bookingRow.createdAt, cancelledAt: null,
};

const action = (over: Record<string, unknown> = {}) => ({
  id: ID, clubId: 'club-1', kind: 'report.xlsx', status: 'EXECUTED', requestedById: 'u-owner',
  payload: { type: 'bookings', from: '2026-10-01', to: '2026-10-15' }, ...over,
});
const policy = (over: Record<string, unknown> = {}) => ({
  readFinance: true, readCustomers: true, readStaff: true, reports: true, bookings: 'ASK', groupSessions: 'ASK', tournaments: 'ASK', messaging: 'ASK', roleAccess: {}, ...over,
});
const adminRole = (over: Record<string, unknown> = {}) => ({
  ADMIN: { enabled: true, readFinance: true, readCustomers: true, readStaff: true, reports: true, bookings: 'ASK', groupSessions: 'ASK', tournaments: 'ASK', messaging: 'OFF', ...over },
});

const get = (headers = as('OWNER')) => request(app).get(`/api/admin/ai/actions/${ID}/file`).set(headers);
const sheets = () => buildWorkbook.mock.calls[0][0] as Array<{ name: string; headers: string[]; rows: unknown[][] }>;
const allHeaders = () => sheets().flatMap((s) => s.headers);

beforeEach(() => {
  vi.resetAllMocks();
  prisma.club.findUnique.mockResolvedValue({ plan: PLAN3, name: 'Клуб', timezone: 'Europe/Kyiv' });
  prisma.aiAgentPolicy.findUnique.mockResolvedValue(policy());
  prisma.aiAction.findFirst.mockImplementation(async ({ where }: any) => {
    const a = action();
    return where.clubId === a.clubId && where.id === a.id && where.kind === a.kind ? a : null;
  });
  prisma.user.findFirst.mockResolvedValue({ email: 'owner@club.ua' });
  prisma.booking.findMany.mockResolvedValue([]);
  buildWorkbook.mockReturnValue(Buffer.from('xlsx'));
  vi.mocked(loadBookingExport).mockResolvedValue({ bookings: [bookingRow], seats: [seatRow] } as never);
  vi.mocked(loadRoster).mockResolvedValue([] as never);
});

describe('GET /ai/actions/:id/file', () => {
  it('власник з повними правами: xlsx із телефонами й грошима, дія записана в журнал вивантажень', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(allHeaders()).toEqual(expect.arrayContaining(['Телефон', 'Ціна, грн', 'Сплачено, грн', 'Клієнт']));
    expect(sheets().map((s) => s.name)).toEqual(['Бронювання', 'Місця в групових заняттях', 'Про звіт']);
    expect(recordChanges).toHaveBeenCalledWith(prisma, { clubId: 'club-1', entity: 'AiReportExport', entityId: ID }, expect.objectContaining({ userId: 'u-owner' }), expect.any(Array));
  });

  it('без readFinance грошові колонки знімаються, решта лишається', async () => {
    prisma.aiAgentPolicy.findUnique.mockResolvedValue(policy({ readFinance: false }));
    expect((await get()).status).toBe(200);
    expect(allHeaders().filter((h) => /грн|Спосіб оплати|Акції/.test(h))).toEqual([]);
    expect(allHeaders()).toEqual(expect.arrayContaining(['Дата', 'Корт', 'Телефон']));
  });

  it('без readCustomers немає імен і телефонів, а аркуш учасників груп не віддається', async () => {
    prisma.aiAgentPolicy.findUnique.mockResolvedValue(policy({ readCustomers: false }));
    expect((await get()).status).toBe(200);
    expect(allHeaders()).not.toEqual(expect.arrayContaining(['Телефон']));
    expect(allHeaders()).not.toContain('Клієнт / заняття');
    expect(sheets().map((s) => s.name)).toEqual(['Бронювання', 'Про звіт']);
    expect(JSON.stringify(sheets())).not.toMatch(/Олена|\+3806/);
  });

  it('без readStaff знімається колонка «Скасував» (пошти персоналу)', async () => {
    prisma.aiAgentPolicy.findUnique.mockResolvedValue(policy({ readStaff: false }));
    await get();
    expect(allHeaders()).not.toContain('Скасував');
    expect(JSON.stringify(sheets())).not.toContain('a@club.ua');
  });

  it.each([
    ['revenue', { readFinance: false }],
    ['customers', { readCustomers: false }],
    ['trainers', { readStaff: false }],
  ])('звіт «%s» із закритою областю відхиляється 403, файл не збирається', async (type, closed) => {
    prisma.aiAction.findFirst.mockResolvedValue(action({ payload: { type, from: '2026-10-01', to: '2026-10-15' } }));
    prisma.aiAgentPolicy.findUnique.mockResolvedValue(policy(closed));
    const res = await get();
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('REPORT_FORBIDDEN');
    expect(buildWorkbook).not.toHaveBeenCalled();
  });

  it('права беруться на момент завантаження: запросили при reports=true, власник вимкнув — 403', async () => {
    prisma.aiAgentPolicy.findUnique.mockResolvedValue(policy({ reports: false }));
    expect((await get()).status).toBe(403);
    expect(buildWorkbook).not.toHaveBeenCalled();
  });

  it('звіт «клієнти» — картотека; період не застосовується і це сказано у файлі', async () => {
    prisma.aiAction.findFirst.mockResolvedValue(action({ payload: { type: 'customers', from: '2026-10-01', to: '2026-10-15' } }));
    expect((await get()).status).toBe(200);
    expect(JSON.stringify(sheets().at(-1))).toMatch(/період звіту до неї не застосовується/);
  });

  it('чужий клуб — 404 (id не розкриває існування)', async () => {
    prisma.aiAction.findFirst.mockImplementation(async ({ where }: any) => (where.clubId === 'club-2' ? action() : null));
    expect((await get()).status).toBe(404);
  });

  it('дія іншого співробітника недоступна не-власнику; автор і власник — мають доступ', async () => {
    prisma.aiAgentPolicy.findUnique.mockResolvedValue(policy({ roleAccess: adminRole() }));
    expect((await get(as('ADMIN', 'u-other'))).status).toBe(404);
    prisma.aiAction.findFirst.mockResolvedValue(action({ requestedById: 'u-admin' }));
    expect((await get(as('ADMIN', 'u-admin'))).status).toBe(200);
    expect((await get(as('OWNER'))).status).toBe(200);
  });

  it('права ролі: ADMIN без readCustomers отримує файл без персональних даних, навіть якщо просив при повних', async () => {
    prisma.aiAgentPolicy.findUnique.mockResolvedValue(policy({ roleAccess: adminRole({ readCustomers: false }) }));
    prisma.aiAction.findFirst.mockResolvedValue(action({ requestedById: 'u-admin' }));
    expect((await get(as('ADMIN', 'u-admin'))).status).toBe(200);
    expect(allHeaders()).not.toContain('Телефон');
  });

  it('роль без доступу до ІІ — 403; не виконана дія — 409; сміття в id — 400', async () => {
    expect((await get(as('ACCOUNTANT'))).status).toBe(403);
    prisma.aiAction.findFirst.mockResolvedValue(action({ status: 'PENDING' }));
    expect((await get()).status).toBe(409);
    expect((await request(app).get('/api/admin/ai/actions/not-a-uuid/file').set(as('OWNER'))).status).toBe(400);
  });

  it('це не звіт (інший kind) — 404', async () => {
    prisma.aiAction.findFirst.mockImplementation(async ({ where }: any) => (where.kind === 'report.xlsx' ? null : action({ kind: 'booking.create' })));
    expect((await get()).status).toBe(404);
  });
});
