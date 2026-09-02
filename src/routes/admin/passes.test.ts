import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Абонементи: тарифи й видача.
 *
 * Головне тут не «створилось», а умови, за яких видача не має відбутись
 * або має відбутись НЕ так, як просять. Абонемент — це отримані гроші й
 * обіцянка на місяць уперед: помилка в датах чи в чужому клубі коштує
 * суперечки на ресепшені, а не рядка в логу.
 */

const prisma = {
  passPlan: {
    findMany: vi.fn(), findFirst: vi.fn(),
    create: vi.fn(), update: vi.fn(), delete: vi.fn(),
  },
  pass: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  customer: { findFirst: vi.fn() },
};

const getActivePass = vi.fn();

vi.mock('../../lib/db', () => ({ prisma }));
vi.mock('../../lib/customers', () => ({ getActivePass, getActivePasses: vi.fn() }));

/* Авторизацію підміняємо цілком: вона своя й перевірена окремо, а тут
   заважала б розгледіти саму видачу. Рівень береться із заголовка, щоб
   один тест міг прийти модератором, а інший — тренером. */
vi.mock('./shared', async () => {
  const actual = await vi.importActual<typeof import('./shared')>('./shared');
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.auth = {
        userId: 'u-1',
        clubId: 'club-1',
        role: String(req.headers['x-role'] ?? 'OWNER'),
        level: Number(req.headers['x-level'] ?? 3) as 1 | 2 | 3,
        trainerId: null,
      };
      next();
    },
  };
});

const { passesRouter } = await import('./passes');
const { customersRouter } = await import('./customers');

const app = express()
  .use(express.json())
  .use('/api/admin', passesRouter)
  .use('/api/admin', customersRouter);

const PLAN_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const PASS_ID = '33333333-3333-4333-8333-333333333333';

const plan = (over: Record<string, unknown> = {}) => ({
  id: PLAN_ID,
  clubId: 'club-1',
  name: '8 занять',
  type: 'PACKAGE',
  totalSessions: 8,
  days: 30,
  price: 200000,
  isActive: true,
  sortOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID });
  prisma.pass.create.mockImplementation(async ({ data }: { data: unknown }) => ({
    id: PASS_ID, ...(data as object),
  }));
});

describe('тарифи абонементів', () => {
  it('пакет без кількості занять не створюється', async () => {
    const r = await request(app)
      .post('/api/admin/pass-plans')
      .send({ name: 'Пакет', type: 'PACKAGE', days: 30, price: 100 });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('SESSIONS_REQUIRED');
    expect(prisma.passPlan.create).not.toHaveBeenCalled();
  });

  it('безліміт створюється без кількості занять', async () => {
    prisma.passPlan.create.mockResolvedValue(plan({ type: 'UNLIMITED', totalSessions: null }));

    const r = await request(app)
      .post('/api/admin/pass-plans')
      .send({ name: 'Безліміт', type: 'UNLIMITED', days: 30, price: 300000 });

    expect(r.status).toBe(201);
    expect(prisma.passPlan.create.mock.calls[0][0].data.totalSessions).toBeNull();
  });

  /* Тариф, переведений у безліміт, не має тягти за собою старе число:
     воно тихо приїхало б у наступний виданий абонемент. */
  it('переведення пакета в безліміт стирає кількість занять', async () => {
    prisma.passPlan.findFirst.mockResolvedValue(plan());
    prisma.passPlan.update.mockResolvedValue(plan({ type: 'UNLIMITED', totalSessions: null }));

    const r = await request(app)
      .patch(`/api/admin/pass-plans/${PLAN_ID}`)
      .send({ type: 'UNLIMITED' });

    expect(r.status).toBe(200);
    expect(prisma.passPlan.update.mock.calls[0][0].data.totalSessions).toBeNull();
  });

  it('чужий тариф не редагується', async () => {
    prisma.passPlan.findFirst.mockResolvedValue(null);

    const r = await request(app)
      .patch(`/api/admin/pass-plans/${PLAN_ID}`)
      .send({ name: 'Своє' });

    expect(r.status).toBe(404);
    expect(prisma.passPlan.update).not.toHaveBeenCalled();
  });

  it('тренер тарифів не заводить', async () => {
    const r = await request(app)
      .post('/api/admin/pass-plans')
      .set('x-role', 'TRAINER')
      .send({ name: '8 занять', type: 'PACKAGE', totalSessions: 8, days: 30, price: 1 });

    expect(r.status).toBe(403);
  });
});

describe('видача абонемента', () => {
  it('за тарифом: умови беруться з нього, строк — від дня видачі', async () => {
    prisma.passPlan.findFirst.mockResolvedValue(plan());

    const r = await request(app)
      .post(`/api/admin/customers/${CUSTOMER_ID}/passes`)
      .send({ planId: PLAN_ID });

    expect(r.status).toBe(201);
    const d = prisma.pass.create.mock.calls[0][0].data;
    expect(d.type).toBe('PACKAGE');
    expect(d.totalSessions).toBe(8);
    expect(d.price).toBe(200000);
    const days = (d.validUntil.getTime() - d.validFrom.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
  });

  /* Домовлена ціна важливіша за прейскурант: постійному клієнту зробили
     знижку, а заводити заради неї окремий тариф ніхто не буде. */
  it('за тарифом можна перебити ціну', async () => {
    prisma.passPlan.findFirst.mockResolvedValue(plan());

    const r = await request(app)
      .post(`/api/admin/customers/${CUSTOMER_ID}/passes`)
      .send({ planId: PLAN_ID, price: 150000 });

    expect(r.status).toBe(201);
    expect(prisma.pass.create.mock.calls[0][0].data.price).toBe(150000);
  });

  it('нуль — теж ціна: абонемент можна подарувати', async () => {
    prisma.passPlan.findFirst.mockResolvedValue(plan());

    await request(app)
      .post(`/api/admin/customers/${CUSTOMER_ID}/passes`)
      .send({ planId: PLAN_ID, price: 0 });

    expect(prisma.pass.create.mock.calls[0][0].data.price).toBe(0);
  });

  it('прибраний тариф не видається', async () => {
    prisma.passPlan.findFirst.mockResolvedValue(plan({ isActive: false }));

    const r = await request(app)
      .post(`/api/admin/customers/${CUSTOMER_ID}/passes`)
      .send({ planId: PLAN_ID });

    expect(r.status).toBe(409);
    expect(r.body.error).toBe('PLAN_INACTIVE');
    expect(prisma.pass.create).not.toHaveBeenCalled();
  });

  it('тариф чужого клубу не видається', async () => {
    prisma.passPlan.findFirst.mockResolvedValue(null);

    const r = await request(app)
      .post(`/api/admin/customers/${CUSTOMER_ID}/passes`)
      .send({ planId: PLAN_ID });

    expect(r.status).toBe(404);
    expect(r.body.error).toBe('PLAN_NOT_FOUND');
  });

  /* Ручний шлях був тут до появи тарифів і має працювати далі — під
     домовленості, заради яких заводити тариф безглуздо. */
  it('без тарифу приймає умови руками', async () => {
    const from = new Date().toISOString();
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString();

    const r = await request(app)
      .post(`/api/admin/customers/${CUSTOMER_ID}/passes`)
      .send({ type: 'PACKAGE', totalSessions: 4, validFrom: from, validUntil: until, price: 90000 });

    expect(r.status).toBe(201);
    expect(prisma.pass.create.mock.calls[0][0].data.totalSessions).toBe(4);
  });

  it('без тарифу і без умов — відмова, а не абонемент навмання', async () => {
    const r = await request(app)
      .post(`/api/admin/customers/${CUSTOMER_ID}/passes`)
      .send({ price: 100 });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('TERMS_REQUIRED');
    expect(prisma.pass.create).not.toHaveBeenCalled();
  });

  it('строк навпаки — відмова', async () => {
    const r = await request(app)
      .post(`/api/admin/customers/${CUSTOMER_ID}/passes`)
      .send({
        type: 'UNLIMITED',
        validFrom: new Date(Date.now() + 86_400_000).toISOString(),
        validUntil: new Date().toISOString(),
      });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('BAD_PERIOD');
  });
});

describe('зняття абонемента', () => {
  it('позначає знятим, а не видаляє рядок', async () => {
    prisma.pass.findFirst.mockResolvedValue({ id: PASS_ID, clubId: 'club-1', revokedAt: null });
    prisma.pass.update.mockResolvedValue({ id: PASS_ID, revokedAt: new Date() });

    const r = await request(app).post(`/api/admin/passes/${PASS_ID}/revoke`);

    expect(r.status).toBe(200);
    expect(prisma.pass.update.mock.calls[0][0].data.revokedAt).toBeInstanceOf(Date);
  });

  it('двічі не знімається', async () => {
    prisma.pass.findFirst.mockResolvedValue({
      id: PASS_ID, clubId: 'club-1', revokedAt: new Date(),
    });

    const r = await request(app).post(`/api/admin/passes/${PASS_ID}/revoke`);

    expect(r.status).toBe(409);
    expect(prisma.pass.update).not.toHaveBeenCalled();
  });

  it('чужий абонемент не знімається', async () => {
    prisma.pass.findFirst.mockResolvedValue(null);

    const r = await request(app).post(`/api/admin/passes/${PASS_ID}/revoke`);

    expect(r.status).toBe(404);
    expect(prisma.pass.update).not.toHaveBeenCalled();
  });
});
