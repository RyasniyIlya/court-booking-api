import { describe, it, expect, vi } from 'vitest';
import {
  parseOptions,
  collectTargets,
  countPlan,
  executePurge,
  applyPurge,
  describeDbTarget,
  formatHeader,
  layerLedger,
  type Db,
  type Options,
} from './purge-customers';

/** Мок клієнта: пише журнал викликів, жодного зʼєднання з базою. */
function makeDb(over: { ledger?: { id: string; originalId: string | null }[] } = {}) {
  const log: string[] = [];
  const deleteArgs: { model: string; args: any }[] = [];
  const ledgerRows = over.ledger ?? [];
  const delegate = (name: string, find: (args: any) => any[] = () => []) => ({
    findMany: vi.fn(async (args: any) => {
      log.push(`${name}.findMany`);
      return find(args);
    }),
    count: vi.fn(async () => {
      log.push(`${name}.count`);
      return 1;
    }),
    deleteMany: vi.fn(async (args: any) => {
      log.push(`${name}.deleteMany`);
      deleteArgs.push({ model: name, args });
      return { count: 1 };
    }),
  });
  const db = {
    club: { findUnique: vi.fn(async () => ({ id: 'club-1' })) },
    customer: delegate('customer', () => [{ id: 'c1' }, { id: 'c2' }]),
    booking: delegate('booking', () => [{ id: 'b1' }]),
    bookingSeat: delegate('bookingSeat', (a) =>
      a.where.customerId ? [{ id: 's1', bookingId: 'container' }] : [{ id: 's2' }],
    ),
    payment: delegate('payment'),
    bookingReschedule: delegate('bookingReschedule'),
    bookingLedgerEntry: delegate('bookingLedgerEntry', (a) =>
      a.where.bookingId ? ledgerRows : [],
    ),
    customerReward: delegate('customerReward'),
    bookingRental: delegate('bookingRental'),
    pass: delegate('pass'),
    passUsage: delegate('passUsage'),
    waitlistEntry: delegate('waitlistEntry'),
  };
  return { db: db as unknown as Db, raw: db, log, deleteArgs };
}

const opts = (o: Partial<Options> = {}): Options => ({ scope: 'nopassword', apply: false, ...o });
const isWrite = (l: string) => /deleteMany|update|create|upsert|\$transaction/.test(l);

describe('purge-customers', () => {
  it('сухий прогін не робить жодного delete/update', async () => {
    const { db, log } = makeDb();
    const t = await collectTargets(db, opts());
    await countPlan(db, t);
    expect(log.length).toBeGreaterThan(0);
    expect(log.filter(isWrite)).toEqual([]);
  });

  it('фільтри: nopassword, all, club', async () => {
    const a = makeDb();
    await collectTargets(a.db, opts({ scope: 'nopassword' }));
    expect(a.raw.customer.findMany.mock.calls[0][0].where).toEqual({ passwordHash: null });

    const b = makeDb();
    await collectTargets(b.db, opts({ scope: 'all' }));
    expect(b.raw.customer.findMany.mock.calls[0][0].where).toEqual({});

    const c = makeDb();
    await collectTargets(c.db, opts({ scope: 'nopassword' }), 'club-1');
    expect(c.raw.customer.findMany.mock.calls[0][0].where).toEqual({ clubId: 'club-1', passwordHash: null });
  });

  it('--scope обовʼязковий, --apply вимагає --confirm', () => {
    expect(() => parseOptions([])).toThrow();
    expect(() => parseOptions(['--scope', 'x'])).toThrow();
    expect(() => parseOptions(['--scope', 'all', '--apply'])).toThrow();
    expect(parseOptions(['--scope', 'all', '--apply', '--confirm', '2'])).toMatchObject({ apply: true, confirm: 2 });
  });

  it('--apply з хибним --confirm не пише нічого', async () => {
    const { db, log } = makeDb();
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(db)) };
    await expect(applyPurge(prisma, opts({ apply: true, confirm: 99 }), undefined)).rejects.toThrow(/Нічого не видалено/);
    expect(log.filter(isWrite)).toEqual([]);
  });

  it('порядок видалення поважає RESTRICT', async () => {
    const { db, log, deleteArgs } = makeDb({
      ledger: [
        { id: 'orig', originalId: null },
        { id: 'refund', originalId: 'orig' },
      ],
    });
    const t = await collectTargets(db, opts());
    expect(t.containerIds).toEqual(['container']);
    await executePurge(db, t);

    const writes = log.filter(isWrite);
    expect(writes).toEqual([
      'bookingLedgerEntry.deleteMany', // повернення
      'bookingLedgerEntry.deleteMany', // оригінал
      'customerReward.deleteMany',
      'bookingRental.deleteMany',
      'bookingSeat.deleteMany',
      'booking.deleteMany',
      'customer.deleteMany',
    ]);
    expect(deleteArgs[0].args.where.id.in).toEqual(['refund']);
    expect(deleteArgs[1].args.where.id.in).toEqual(['orig']);
    // місця: власні + усі місця броней
    expect(deleteArgs.find((d) => d.model === 'bookingSeat')!.args.where.id.in.sort()).toEqual(['s1', 's2']);
  });

  it('layerLedger: листя першими', () => {
    expect(layerLedger([{ id: 'a', originalId: null }, { id: 'b', originalId: 'a' }, { id: 'c', originalId: 'b' }])).toEqual([['c'], ['b'], ['a']]);
  });

  it('заголовок не містить пароля й користувача', () => {
    const url = 'postgresql://secretuser:S3cr3tP%40ss@db.example.com:5432/courts?sslmode=require';
    const target = describeDbTarget(url);
    const header = formatHeader({ DATABASE_URL: url }, opts());
    for (const s of [target, header]) {
      expect(s).not.toContain('S3cr3t');
      expect(s).not.toContain('secretuser');
    }
    expect(target).toContain('db.example.com');
    expect(target).toContain('courts');
  });
});
