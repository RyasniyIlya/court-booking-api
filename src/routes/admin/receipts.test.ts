import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/** Квитанції клубу: завантаження, валідація, дубль, чужий/не-ISSUED рахунок, ролі, заголовки файлу. */

const prisma = {
  user: { findUnique: vi.fn() },
  clubInvoice: { findFirst: vi.fn() },
  paymentReceipt: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
};
vi.mock('../../lib/db', () => ({ prisma }));
const scheduleReceiptCheck = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/receiptCheck', () => ({ scheduleReceiptCheck }));

const { receiptsRouter } = await import('./receipts');
const { signToken } = await import('./shared');
const app = express().use(express.json()).use(receiptsRouter);

const userId = '44444444-4444-4444-8444-444444444444';
const clubId = '22222222-2222-4222-8222-222222222222';
const token = (role: string) =>
  `Bearer ${signToken({ userId, clubId, role, trainerId: null } as never, '1h', 'hash')}`;

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('payload-1234')]);
const pdf = Buffer.from('%PDF-1.4 some pdf body');
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpegjpegjpeg')]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]);

let role = 'OWNER';
beforeEach(() => {
  vi.resetAllMocks();
  role = 'OWNER';
  prisma.user.findUnique.mockImplementation(async () => ({ id: userId, clubId, role, trainerId: null, passwordHash: 'hash' }));
  prisma.clubInvoice.findFirst.mockResolvedValue({ id: 'inv-1', status: 'ISSUED' });
  prisma.paymentReceipt.findUnique.mockResolvedValue(null);
  prisma.paymentReceipt.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'r1', invoiceId: data.invoiceId, mime: data.mime, size: data.size, status: 'PENDING',
  }));
  prisma.paymentReceipt.update.mockResolvedValue({});
});

const upload = (body: Buffer, r = 'OWNER') => {
  role = r;
  return request(app)
    .post('/billing/invoice/inv-1/receipt')
    .set('Authorization', token(r))
    .set('Content-Type', 'application/octet-stream')
    .send(body);
};

describe('POST /billing/invoice/:id/receipt', () => {
  it.each([['png', png, 'image/png'], ['pdf', pdf, 'application/pdf'], ['jpg', jpg, 'image/jpeg'], ['webp', webp, 'image/webp']])(
    '%s приймається за magic bytes, sha256 і тип зберігаються, ШІ-перевірка запускається',
    async (_n, buf, mime) => {
      const res = await upload(buf as Buffer);
      expect(res.status).toBe(201);
      const { data } = prisma.paymentReceipt.create.mock.calls[0][0];
      expect(data).toMatchObject({ clubId, invoiceId: 'inv-1', mime, size: (buf as Buffer).length, uploadedBy: userId });
      expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.receipt.fileData).toBeUndefined();
      expect(scheduleReceiptCheck).toHaveBeenCalledTimes(1);
    },
  );

  it('ADMIN теж може завантажити', async () => {
    expect((await upload(png, 'ADMIN')).status).toBe(201);
  });

  it('не той тип (html під видом картинки) — 415', async () => {
    const res = await upload(Buffer.from('<html><script>alert(1)</script></html>'));
    expect(res.status).toBe(415);
    expect(prisma.paymentReceipt.create).not.toHaveBeenCalled();
  });

  it('SVG — 415', async () => {
    expect((await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).status).toBe(415);
  });

  it('понад 5 МБ — 413', async () => {
    const big = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]);
    const res = await upload(big);
    expect(res.status).toBe(413);
    expect(prisma.paymentReceipt.create).not.toHaveBeenCalled();
  });

  it('дубль за sha256 — 409 RECEIPT_DUPLICATE', async () => {
    prisma.paymentReceipt.findUnique.mockResolvedValue({ id: 'old' });
    const res = await upload(png);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('RECEIPT_DUPLICATE');
  });

  it('гонка: P2002 від БД — теж 409', async () => {
    prisma.paymentReceipt.create.mockRejectedValue(Object.assign(new Error('x'), { code: 'P2002' }));
    expect((await upload(png)).status).toBe(409);
  });

  it('чужий рахунок (не знайдено в межах клубу) — 404, пошук з clubId', async () => {
    prisma.clubInvoice.findFirst.mockResolvedValue(null);
    const res = await upload(png);
    expect(res.status).toBe(404);
    expect(prisma.clubInvoice.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'inv-1', clubId });
  });

  it.each(['PAID', 'VOID'])('рахунок %s — 409 INVOICE_NOT_OPEN', async (status) => {
    prisma.clubInvoice.findFirst.mockResolvedValue({ id: 'inv-1', status });
    const res = await upload(png);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INVOICE_NOT_OPEN');
  });

  it('порожнє тіло — 400', async () => {
    expect((await upload(Buffer.alloc(0))).status).toBe(400);
  });

  it('без токена — 401, тренер — 403', async () => {
    expect((await request(app).post('/billing/invoice/inv-1/receipt').send(png)).status).toBe(401);
    expect((await upload(png, 'TRAINER')).status).toBe(403);
  });
});

describe('GET /billing/receipts та файл', () => {
  it('список — тільки свого клубу, без байтів файлу', async () => {
    prisma.paymentReceipt.findMany.mockResolvedValue([{ id: 'r1', status: 'REJECTED', rejectReason: 'Не та сума' }]);
    const res = await request(app).get('/billing/receipts').set('Authorization', token('OWNER'));
    expect(res.status).toBe(200);
    const arg = prisma.paymentReceipt.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ clubId });
    expect(arg.select.fileData).toBeUndefined();
    expect(res.body.receipts[0].rejectReason).toBe('Не та сума');
  });

  it('файл: правильні заголовки, пошук у межах клубу', async () => {
    prisma.paymentReceipt.findFirst.mockResolvedValue({ mime: 'application/pdf', fileData: pdf });
    const res = await request(app).get('/billing/receipts/r1/file').set('Authorization', token('ADMIN'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(prisma.paymentReceipt.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'r1', clubId });
  });

  it('чужий файл — 404', async () => {
    prisma.paymentReceipt.findFirst.mockResolvedValue(null);
    expect((await request(app).get('/billing/receipts/zz/file').set('Authorization', token('OWNER'))).status).toBe(404);
  });

  it('без токена — 401 на списку й файлі', async () => {
    expect((await request(app).get('/billing/receipts')).status).toBe(401);
    expect((await request(app).get('/billing/receipts/r1/file')).status).toBe(401);
  });
});
