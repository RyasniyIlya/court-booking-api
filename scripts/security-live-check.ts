import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHmac, randomUUID, randomInt } from 'node:crypto';
import type { Prisma } from '@prisma/client';

// Opt-in only: this script creates a disposable club in the configured TEST database.
// Never run as part of the ordinary unit suite or against production.
async function main() {
  assert.equal(process.env.SECURITY_TEST_DB_CONFIRMED, 'yes', 'Confirm the target is a test database first');
  process.env.TELEGRAM_BOT_TOKEN = '123456789:synthetic-mini-app-test-token';
  process.env.PLAYER_SCHEDULER = 'off';
  const { prisma, isSlotTakenError } = await import('../src/lib/db');
  const { applyPayEvent } = await import('../src/lib/payments/apply');
  const { cancelSeatByCustomer, cancelBookingByCustomer } = await import('../src/lib/customerCancel');
  const { checkPassword } = await import('../src/lib/passwordCheck');
  const { hashPassword } = await import('../src/lib/passwordHash');
  const { processTelegramUpdate } = await import('../src/lib/telegramReceipt');
  const { canReschedule } = await import('../src/lib/reschedule');
  const { default: express } = await import('express');
  const { default: request } = await import('supertest');
  const { publicRouter } = await import('../src/routes/public');
  const { signCustomerToken } = await import('../src/lib/customerAuth');
  const { requireAuth, signToken } = await import('../src/routes/admin/shared');
  const app = express().use(express.json()).use('/api/public', publicRouter);
  app.get('/test-auth', requireAuth, (req, res) => res.json({ role: req.auth?.role }));
  const runId = randomUUID();
  const clubId = randomUUID();
  let planId: string | null = null;
  const receiptIds: number[] = [];
  let created = false;
  let slot = 0;
  let passed = 0;
  const check = async (label: string, fn: () => Promise<void>) => {
    await fn(); passed++; console.log(`PASS ${label}`);
  };
  try {
    const constraints = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint WHERE conrelid = '"Booking"'::regclass
      AND conname IN ('booking_no_overlap', 'trainer_no_overlap')`;
    assert.equal(constraints.length, 2, 'Apply migrations before running live tests');
    const plan = await prisma.plan.create({ data: { code: `security-${runId}`, name: 'Disposable pro plan', price: 0, tier: 3 } });
    planId = plan.id;
    await prisma.club.create({ data: { id: clubId, name: 'Disposable security check', slug: `security-${runId}`,
      cancelCutoffMinutes: 0, approvedAt: new Date(), planId: plan.id } });
    created = true;
    const court = await prisma.court.create({ data: { clubId, name: 'Test court A' } });
    const court2 = await prisma.court.create({ data: { clubId, name: 'Test court B' } });
    const trainer = await prisma.trainer.create({ data: { clubId, name: 'Test trainer' } });
    const booking = (extra: Partial<Prisma.BookingUncheckedCreateInput> = {}) => {
      const startTime = new Date(Date.now() + 7 * 86400_000 + slot++ * 7200_000);
      return prisma.booking.create({ data: { clubId, courtId: court.id, customerName: 'Synthetic client',
        customerPhone: '+380000000000', startTime, endTime: new Date(startTime.getTime() + 3600_000),
        priceTotal: 10000, ...extra } });
    };
    const payment = (target: { bookingId: string } | { seatId: string }) => prisma.payment.create({
      data: { clubId, provider: 'mock', providerRef: randomUUID(), amount: 10000, ...target },
    });
    await check('trainer overlap is rejected across different courts', async () => {
      const first = await booking({ trainerId: trainer.id });
      const result = await Promise.allSettled([court.id, court2.id].map(courtId => booking({
        courtId, trainerId: trainer.id, startTime: first.startTime, endTime: first.endTime,
      })));
      assert(result.every(r => r.status === 'rejected' && isSlotTakenError(r.reason)));
    });
    await check('two simultaneous trainer reservations have exactly one winner', async () => {
      const startTime = new Date(Date.now() + 60 * 86400_000);
      const result = await Promise.allSettled([court.id, court2.id].map(courtId => booking({
        courtId, trainerId: trainer.id, startTime, endTime: new Date(startTime.getTime() + 3600_000),
      })));
      assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
      const loser = result.find(r => r.status === 'rejected');
      assert(loser?.status === 'rejected' && isSlotTakenError(loser.reason));
    });
    await check('concurrent paid/failed events cannot overwrite received money', async () => {
      const b = await booking({ status: 'PENDING' });
      const p = await payment({ bookingId: b.id });
      await Promise.all(['paid', 'failed', 'paid'].map(status => applyPayEvent('mock', {
        providerRef: p.providerRef, status: status as 'paid' | 'failed', amountKop: 10000,
      }, clubId)));
      assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status, 'PAID');
      assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status, 'CONFIRMED');
    });
    await check('cancel racing with payment never restores the cancelled booking', async () => {
      const b = await booking({ status: 'PENDING' });
      const p = await payment({ bookingId: b.id });
      await Promise.all([cancelBookingByCustomer(b.id), applyPayEvent('mock', { providerRef: p.providerRef, status: 'paid' }, clubId)]);
      assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status, 'CANCELLED');
      assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status, 'PAID');
    });
    await check('late payment after cancellation is recorded for manual resolution', async () => {
      const b = await booking({ status: 'CANCELLED' });
      const p = await payment({ bookingId: b.id });
      await applyPayEvent('mock', { providerRef: p.providerRef, status: 'paid' }, clubId);
      const saved = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
      assert.equal(saved.status, 'PAID'); assert.equal(saved.failReason, 'BOOKING_CANCELLED');
    });
    await check('SAVEPOINT preserves paid money when the expired slot was taken', async () => {
      const b = await booking({ status: 'EXPIRED' });
      await booking({ startTime: b.startTime, endTime: b.endTime });
      const p = await payment({ bookingId: b.id });
      await applyPayEvent('mock', { providerRef: p.providerRef, status: 'paid' }, clubId);
      const saved = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
      assert.equal(saved.status, 'PAID'); assert.equal(saved.failReason, 'SLOT_LOST');
      assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status, 'EXPIRED');
    });
    await check('concurrent group cancellation decrements revenue only once', async () => {
      const b = await booking({ capacity: 3, title: 'Synthetic group', pricePerSeat: 10000,
        customerName: null, customerPhone: null, priceTotal: 30000 });
      const seat = await prisma.bookingSeat.create({ data: { bookingId: b.id, customerName: 'Synthetic', customerPhone: '+380000000001', price: 10000 } });
      const results = await Promise.all(Array.from({ length: 5 }, () => cancelSeatByCustomer(seat.id, s => s.clubId === clubId)));
      assert.equal(results.filter(r => r.ok && r.changed).length, 1);
      assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).priceTotal, 20000);
    });
    await check('concurrent seat payment duplicates increment revenue only once', async () => {
      const b = await booking({ capacity: 2, title: 'Synthetic group', pricePerSeat: 10000,
        customerName: null, customerPhone: null, priceTotal: 0 });
      const seat = await prisma.bookingSeat.create({ data: { bookingId: b.id, customerName: 'Synthetic', customerPhone: '+380000000002', price: 10000, status: 'PENDING' } });
      const p = await payment({ seatId: seat.id });
      await Promise.all(Array.from({ length: 4 }, () => applyPayEvent('mock', { providerRef: p.providerRef, status: 'paid' }, clubId)));
      assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).priceTotal, 10000);
      await Promise.all(['refunded', 'paid', 'refunded'].map(status => applyPayEvent('mock', { providerRef: p.providerRef, status: status as 'paid' | 'refunded' }, clubId)));
      assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status, 'REFUNDED');
      assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).priceTotal, 0);
    });
    await check('parallel failed passwords stop at the shared five-attempt limit', async () => {
      const user = await prisma.user.create({ data: { clubId, email: `security-${runId}@example.invalid`, passwordHash: await hashPassword('Synthetic-password-only', 4) } });
      const results = await Promise.all(Array.from({ length: 10 }, () => checkPassword('user', user.id, 'incorrect')));
      const saved = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      assert.equal(saved.pinFails, 5); assert(saved.pinLockedUntil && saved.pinLockedUntil > new Date());
      assert.equal(results.filter(r => !r.ok && r.reason === 'LOCKED').length, 5);
    });
    await check('Telegram receipt retries failure and skips completed duplicates', async () => {
      // Negative IDs are reserved here: real webhook validation permits nonnegative IDs only.
      const id = -randomInt(1, 2147483647); receiptIds.push(id);
      let handled = 0;
      await assert.rejects(processTelegramUpdate({ update_id: id }, async () => { throw new Error('Synthetic failure'); }));
      await processTelegramUpdate({ update_id: id }, async () => { handled++; });
      await processTelegramUpdate({ update_id: id }, async () => { handled++; });
      assert.equal(handled, 1);
    });
    await check('Telegram in-flight duplicate cannot execute a second handler', async () => {
      const id = -randomInt(1, 2147483647); receiptIds.push(id);
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { started = resolve; });
      const first = processTelegramUpdate({ update_id: id }, async () => { started(); await gate; });
      // Propagate initialization errors too, instead of waiting forever for a handler that never started.
      await Promise.race([ready, first]);
      try {
        await assert.rejects(processTelegramUpdate({ update_id: id }, async () => {
          assert.fail('Duplicate handler must not execute');
        }), /UPDATE_IN_PROGRESS/);
      } finally { release(); await first; }
    });
    await check('HTTP staff sessions use current roles and revoke after password change/deletion', async () => {
      const hash = await hashPassword('Synthetic-session-password', 4);
      const user = await prisma.user.create({ data: { clubId, email: `session-${runId}@example.invalid`, passwordHash: hash } });
      const auth = { userId: user.id, clubId, role: 'OWNER', trainerId: null };
      const token = signToken(auth, '5m', hash);
      const get = (bearer = token) => request(app).get('/test-auth').set('Authorization', `Bearer ${bearer}`);
      assert.equal((await get()).status, 200);
      await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
      assert.equal((await get()).body.role, 'ADMIN');
      const newHash = await hashPassword('Synthetic-replacement-password', 4);
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
      assert.equal((await get()).status, 401);
      const replacement = signToken(auth, '5m', newHash);
      assert.equal((await get(replacement)).status, 200);
      await prisma.user.delete({ where: { id: user.id } });
      assert.equal((await get(replacement)).status, 401);
    });
    await check('signed Telegram Mini App launch opens only its linked player profile', async () => {
      const telegramId = randomInt(100_000_000, 2_000_000_000);
      const customer = await prisma.customer.create({ data: { clubId, name: 'Synthetic Telegram player',
        phone: `+380${String(randomInt(10_000_000, 99_999_999))}`, phoneTail: String(randomInt(1_000_000, 9_999_999)),
        telegramChatId: String(telegramId) } });
      const values = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: randomUUID(),
        user: JSON.stringify({ id: telegramId, first_name: 'Synthetic' }) };
      const checkString = Object.entries(values).map(([key, value]) => `${key}=${value}`).sort().join('\n');
      const secret = createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN!).digest();
      const hash = createHmac('sha256', secret).update(checkString).digest('hex');
      const initData = new URLSearchParams({ ...values, hash }).toString();
      const path = `/api/public/clubs/security-${runId}/customer/telegram-session`;
      const response = await request(app).post(path).send({ initData });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.name, customer.name);
      assert.equal(response.headers['cache-control'], 'no-store');
      const tampered = await request(app).post(path).send({ initData: initData.replace(String(telegramId), String(telegramId + 1)) });
      assert.equal(tampered.status, 401);
    });
    await check('HTTP reschedule preserves old booking on conflicts and enforces six hours', async () => {
      await prisma.court.update({ where: { id: court.id }, data: { pricePerHour: 10000, slotMinutes: 60 } });
      await prisma.clubHours.createMany({ data: Array.from({ length: 7 }, (_, weekday) => ({ clubId, weekday, openMinute: 0, closeMinute: 1440 })) });
      const customer = await prisma.customer.create({ data: { clubId, name: 'Synthetic profile', phone: '+380000000009', phoneTail: '0000009' } });
      const token = signCustomerToken({ clubId, customerId: customer.id });
      const original = await booking({ customerId: customer.id });
      const destination = new Date(Date.now() + 90 * 86400_000); destination.setUTCHours(10, 0, 0, 0);
      const target = { start: destination.toISOString(), end: new Date(destination.getTime() + 3600_000).toISOString(), courtId: court.id,
        expectedPrice: 10000, version: original.updatedAt.toISOString() };
      const post = (id: string, body: object, bearer = token) => request(app).post(`/api/public/customer/bookings/${id}/reschedule`)
        .set('Authorization', `Bearer ${bearer}`).send(body);
      assert.equal((await post(original.id, target, signCustomerToken({ clubId, customerId: randomUUID() }))).body.error, 'NOT_FOUND');
      assert.equal((await post(original.id, { ...target, preview: true })).status, 200);
      assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: original.id } })).startTime.toISOString(), original.startTime.toISOString());
      const moved = await post(original.id, target); assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.equal(await prisma.bookingReschedule.count({ where: { bookingId: original.id } }), 1);
      const saved = await prisma.booking.findUniqueOrThrow({ where: { id: original.id } });
      assert.equal(saved.startTime.toISOString(), target.start);
      assert.equal(saved.priceTotal, original.priceTotal);
      const other = await booking({ customerId: customer.id });
      assert.equal((await post(other.id, { ...target, version: other.updatedAt.toISOString() })).body.error, 'SLOT_TAKEN');
      assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: other.id } })).startTime.toISOString(), other.startTime.toISOString());
      const soon = await booking({ customerId: customer.id, startTime: new Date(Date.now() + 5 * 3600_000), endTime: new Date(Date.now() + 6 * 3600_000) });
      assert.equal((await post(soon.id, { ...target, version: soon.updatedAt.toISOString() })).body.error, 'CLOSED');
    });
    await check('reschedule six-hour boundary is inclusive and shorter windows are blocked', async () => {
      const now = new Date();
      assert.equal(canReschedule(new Date(now.getTime() + 21600_000), now), true);
      assert.equal(canReschedule(new Date(now.getTime() + 21599_999), now), false);
    });
    console.log(`LIVE SECURITY CHECKS: ${passed} passed`);
  } finally {
    // Exact run-owned IDs only; existing clubs and bookings are never selected for deletion.
    if (created) await prisma.club.delete({ where: { id: clubId } });
    if (planId) await prisma.plan.delete({ where: { id: planId } });
    if (receiptIds.length) await prisma.telegramReceipt.deleteMany({ where: { id: { in: receiptIds } } });
    console.log('Removed this run\'s disposable club, plan and technical receipts.');
    await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
