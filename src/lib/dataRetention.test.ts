import { beforeEach, describe, expect, it, vi } from 'vitest';

const del = () => ({ create: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 2 })), count: vi.fn(async () => 2) });
const MODELS = [
  'bookingLedgerEntry', 'customerReward', 'bookingRental', 'booking', 'customer', 'waitlistEntry', 'pass',
  'passPlan', 'payment', 'block', 'promo', 'inventoryItem', 'clubExpense', 'shiftClose', 'changeLog',
  'passwordReset', 'trainer', 'user', 'court', 'clubHours', 'crmActivity', 'tgDialog',
];

let tx: any;
const prisma: any = {
  club: { findMany: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock('./db', () => ({ prisma }));

const {
  purgeEligible, runRetentionTick, retentionEnabled, retentionDryRun, RETENTION_DAYS, anonymizedClubData,
} = await import('./dataRetention');

const DAY = 86_400_000;
const NOW = new Date('2026-10-03T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const ON = { DATA_RETENTION_ENABLED: 'true' } as NodeJS.ProcessEnv;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  tx = { club: { update: vi.fn(async () => ({})) }, clubInvoice: del() };
  for (const m of MODELS) tx[m] = del();
  for (const m of MODELS) prisma[m] = del();
  prisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
});

describe('purgeEligible', () => {
  const club = (days: number | null, extra = {}) => ({ terminatedAt: days === null ? null : ago(days), ...extra });

  it('день 89 — ще ні, 90 — так, 91 — так', () => {
    expect(RETENTION_DAYS).toBe(90);
    expect(purgeEligible(club(89), NOW)).toBe(false);
    expect(purgeEligible(club(90), NOW)).toBe(true);
    expect(purgeEligible(club(91), NOW)).toBe(true);
  });

  it('без terminatedAt ніколи: ні прострочка, ні вимкнення не рахуються розірванням', () => {
    expect(purgeEligible(club(null, { paidUntil: ago(500) }), NOW)).toBe(false);
  });

  it('клуб, що знову заплатив/має пробний, не чіпаємо', () => {
    expect(purgeEligible(club(120, { paidUntil: new Date(NOW.getTime() + DAY) }), NOW)).toBe(false);
    expect(purgeEligible(club(120, { trialEndsAt: new Date(NOW.getTime() + DAY) }), NOW)).toBe(false);
    expect(purgeEligible(club(120, { paidUntil: ago(100) }), NOW)).toBe(true);
  });

  it('уже видалений — ні', () => {
    expect(purgeEligible(club(200, { dataPurgedAt: ago(1) }), NOW)).toBe(false);
  });
});

describe('runRetentionTick', () => {
  const candidate = { id: 'club-1', terminatedAt: ago(100), dataPurgedAt: null, paidUntil: ago(100), trialEndsAt: null };

  it('вимкнено за замовчуванням: нічого не читає й не пише', () => {
    expect(retentionEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    return runRetentionTick(NOW, {} as NodeJS.ProcessEnv).then((r) => {
      expect(r.clubs).toEqual([]);
      expect(prisma.club.findMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  it('dry-run за замовчуванням: лічить, але не видаляє', async () => {
    expect(retentionDryRun({} as NodeJS.ProcessEnv)).toBe(true);
    prisma.club.findMany.mockResolvedValue([candidate]);
    const r = await runRetentionTick(NOW, ON);
    expect(r.dryRun).toBe(true);
    expect(r.clubs).toHaveLength(1);
    expect(r.clubs[0].purged).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    for (const m of MODELS) expect(prisma[m].deleteMany).not.toHaveBeenCalled();
    const logged = (console.log as any).mock.calls.flat().join(' ');
    expect(logged).toContain('club-1');
  });

  it('клуб на 89-й день не потрапляє навіть у dry-run', async () => {
    prisma.club.findMany.mockResolvedValue([{ ...candidate, terminatedAt: ago(89) }]);
    const r = await runRetentionTick(NOW, { ...ON, DATA_RETENTION_DRY_RUN: 'false' });
    expect(r.clubs).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('реальне видалення: одна транзакція, рахунки підписки не чіпаються, є аудит і знеособлення', async () => {
    prisma.club.findMany.mockResolvedValue([candidate]);
    const r = await runRetentionTick(NOW, { ...ON, DATA_RETENTION_DRY_RUN: 'false' });
    expect(r.clubs[0].purged).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    expect(tx.clubInvoice.deleteMany).not.toHaveBeenCalled();
    expect(tx.customer.deleteMany).toHaveBeenCalledWith({ where: { clubId: 'club-1' } });
    expect(tx.booking.deleteMany).toHaveBeenCalled();

    // Повернення журналу видаляються раніше за решту, а журнал — раніше за броні й клієнтів.
    const ledgerFirst = tx.bookingLedgerEntry.deleteMany.mock.calls[0][0];
    expect(ledgerFirst.where.originalId).toEqual({ not: null });
    const order = (m: string) => tx[m].deleteMany.mock.invocationCallOrder[0];
    expect(order('bookingLedgerEntry')).toBeLessThan(order('booking'));
    expect(order('bookingRental')).toBeLessThan(order('booking'));
    expect(order('customerReward')).toBeLessThan(order('customer'));

    // Рядок Club знеособлюється, а не видаляється (ClubInvoice на нього посилається).
    expect(tx.club.update).toHaveBeenCalledTimes(1);
    const upd = tx.club.update.mock.calls[0][0];
    expect(upd.data).toMatchObject({ slug: 'purged-club-1', phone: null, paymentTokenEnc: null, isActive: false });
    expect(upd.data.dataPurgedAt).toBeInstanceOf(Date);

    // Аудит без персональних даних.
    const audit = tx.crmActivity.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ clubId: 'club-1', kind: 'SYSTEM', author: 'system:data-retention' });
    expect(tx.crmActivity.create.mock.invocationCallOrder[0]).toBeGreaterThan(order('crmActivity'));
  });

  it('збій посеред транзакції: помилка поглинається, клуб не позначено, інші клуби йдуть далі', async () => {
    prisma.club.findMany.mockResolvedValue([candidate, { ...candidate, id: 'club-2' }]);
    // Перший клуб: падіння на видаленні броней; "відкат" = $transaction кидає і не повертає результат.
    let call = 0;
    prisma.$transaction.mockImplementation(async (cb: any) => {
      call += 1;
      const t: any = { club: { update: vi.fn() }, crmActivity: del(), tgDialog: del() };
      for (const m of MODELS) t[m] = del();
      if (call === 1) t.booking.deleteMany = vi.fn(async () => { throw new Error('fk'); });
      const res = await cb(t);
      return res;
    });
    const r = await runRetentionTick(NOW, { ...ON, DATA_RETENTION_DRY_RUN: 'false' });
    expect(r.clubs.map((c) => c.id)).toEqual(['club-2']);
    expect((console.error as any).mock.calls.flat().join(' ')).toContain('club-1');
  });

  it('у знеособленому клубі не лишається контактів', () => {
    const d = anonymizedClubData('x', NOW);
    expect(d.name).not.toContain('x');
    expect([d.phone, d.email, d.address, d.legalName, d.legalCode, d.paymentTokenEnc].every((v) => v === null)).toBe(true);
  });
});
