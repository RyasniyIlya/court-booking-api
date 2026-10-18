import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { pglitePrisma } from '../../../tests/helpers/pglitePrisma';

/**
 * Лічильник у базі: справжній SQL проти PGlite з усіма міграціями.
 */

const kit = vi.hoisted(() => ({ prisma: null as any }));
vi.mock('../db', () => ({ get prisma() { return kit.prisma; } }));

const { takeQuota, refundQuota, quotaDay, purgeOldUsage, envLimit } = await import('./quota');

let pg: Awaited<ReturnType<typeof pglitePrisma>>;
const CLUB = randomUUID();
const OTHER = randomUUID();

const used = async (clubId: string, scope: string, day: string) =>
  ((await pg.db.query('SELECT "count" FROM "AiUsage" WHERE "clubId" = $1 AND scope = $2 AND day = $3', [clubId, scope, day])).rows[0] as any)?.count ?? null;

beforeAll(async () => {
  pg = await pglitePrisma();
  kit.prisma = pg.prisma;
  await pg.makeClub(CLUB);
  await pg.makeClub(OTHER);
}, 120_000);

afterAll(async () => { await pg?.db.close(); });

const at = (iso: string) => ({ now: new Date(iso), timezone: 'Europe/Kyiv' });

describe('takeQuota (SQL)', () => {
  it('рахує по клубу, ключу й добі та зупиняється на стелі', async () => {
    const o = at('2026-09-26T10:00:00Z');
    expect(await takeQuota('client', CLUB, 2, o)).toBe(true);
    expect(await takeQuota('client', CLUB, 2, o)).toBe(true);
    expect(await takeQuota('client', CLUB, 2, o)).toBe(false);
    /* Відмова не піднімає лічильник понад стелю. */
    expect(await used(CLUB, 'client', '2026-09-26')).toBe(2);
    expect(await takeQuota('client', OTHER, 2, o)).toBe(true);
    expect(await takeQuota('owner', CLUB, 2, o)).toBe(true);
    expect(await takeQuota('client', CLUB, 2, at('2026-09-27T10:00:00Z'))).toBe(true);
  });

  it('паралельні запити ніколи не перевищують ліміт', async () => {
    const o = at('2026-10-01T10:00:00Z');
    const results = await Promise.all(Array.from({ length: 40 }, () => takeQuota('burst', CLUB, 7, o)));
    expect(results.filter(Boolean)).toHaveLength(7);
    expect(await used(CLUB, 'burst', '2026-10-01')).toBe(7);
  });

  it('ліміт < 1 забороняє навіть перший запит і нічого не пише', async () => {
    expect(await takeQuota('zero', CLUB, 0, at('2026-10-02T10:00:00Z'))).toBe(false);
    expect(await used(CLUB, 'zero', '2026-10-02')).toBeNull();
  });

  it('суб’єкт у scope розводить ліміти: гравець А не з’їдає ліміт гравця Б', async () => {
    const o = at('2026-10-03T10:00:00Z');
    expect(await takeQuota('bot:player:a', CLUB, 1, o)).toBe(true);
    expect(await takeQuota('bot:player:a', CLUB, 1, o)).toBe(false);
    expect(await takeQuota('bot:player:b', CLUB, 1, o)).toBe(true);
  });

  it('межа доби — північ за часом клубу, а не UTC', async () => {
    /* 21:30 UTC 10 жовтня = 00:30 11 жовтня у Києві (літній час, UTC+3 до 25.10). */
    expect(quotaDay('Europe/Kyiv', new Date('2026-10-10T21:30:00Z'))).toBe('2026-10-11');
    expect(quotaDay('UTC', new Date('2026-10-10T21:30:00Z'))).toBe('2026-10-10');

    expect(await takeQuota('tz', CLUB, 1, { now: new Date('2026-10-10T20:30:00Z'), timezone: 'Europe/Kyiv' })).toBe(true);
    /* Та сама UTC-доба, але в Києві вже наступна — ліміт новий. */
    expect(await takeQuota('tz', CLUB, 1, { now: new Date('2026-10-10T21:30:00Z'), timezone: 'Europe/Kyiv' })).toBe(true);
    /* Всередині київської доби — вже відмова. */
    expect(await takeQuota('tz', CLUB, 1, { now: new Date('2026-10-11T08:00:00Z'), timezone: 'Europe/Kyiv' })).toBe(false);
  });

  it('зіпсований часовий пояс не валить виклик: запасна зона', async () => {
    expect(quotaDay('Not/AZone', new Date('2026-10-10T21:30:00Z'))).toBe('2026-10-11');
    expect(await takeQuota('badtz', CLUB, 1, { now: new Date('2026-10-10T10:00:00Z'), timezone: 'Not/AZone' })).toBe(true);
  });

  it('збій бази = відмова (закрито), без винятку', async () => {
    const real = kit.prisma;
    kit.prisma = { $queryRaw: async () => { throw new Error('db down'); } };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await takeQuota('x', CLUB, 5)).toBe(false);
    err.mockRestore();
    kit.prisma = real;
  });
});

describe('refundQuota', () => {
  it('повертає одне місце, але не нижче нуля', async () => {
    const o = at('2026-10-05T10:00:00Z');
    expect(await takeQuota('refund', CLUB, 1, o)).toBe(true);
    expect(await takeQuota('refund', CLUB, 1, o)).toBe(false);
    await refundQuota('refund', CLUB, o);
    expect(await used(CLUB, 'refund', '2026-10-05')).toBe(0);
    await refundQuota('refund', CLUB, o);
    expect(await used(CLUB, 'refund', '2026-10-05')).toBe(0);
    expect(await takeQuota('refund', CLUB, 1, o)).toBe(true);
  });
});

describe('purgeOldUsage', () => {
  it('видаляє рядки старші за 35 діб, свіжі лишає', async () => {
    const now = new Date('2026-10-18T12:00:00Z');
    await pg.db.query(
      'INSERT INTO "AiUsage" (id, "clubId", scope, day, "count") VALUES ($1,$2,$5,$6,1), ($3,$2,$7,$8,1), ($4,$2,$9,$10,1)',
      [randomUUID(), CLUB, randomUUID(), randomUUID(), 'old', '2026-09-10', 'edge', '2026-09-13', 'fresh', '2026-10-17'],
    );
    await purgeOldUsage(now);
    expect(await used(CLUB, 'old', '2026-09-10')).toBeNull();
    expect(await used(CLUB, 'edge', '2026-09-13')).toBe(1);
    expect(await used(CLUB, 'fresh', '2026-10-17')).toBe(1);
  });
});

describe('міграція ai_usage', () => {
  it('AiChatTurn приймає рядок і каскадно зникає разом із клубом', async () => {
    const club = randomUUID();
    await pg.makeClub(club);
    await pg.db.query(
      'INSERT INTO "AiChatTurn" (id, "chatId", "clubId", mode, role, content) VALUES ($1, $3, $2, $4, $5, $6)',
      [randomUUID(), club, '1', 'staff', 'user', 'hi'],
    );
    await pg.db.query('DELETE FROM "Club" WHERE id = $1', [club]);
    const left = await pg.db.query('SELECT 1 FROM "AiChatTurn" WHERE "clubId" = $1', [club]);
    expect(left.rows).toHaveLength(0);
  });
});

describe('envLimit', () => {
  it('ігнорує сміття', () => {
    process.env.__T = 'abc';
    expect(envLimit('__T', 7)).toBe(7);
    process.env.__T = '12.9';
    expect(envLimit('__T', 7)).toBe(12);
    delete process.env.__T;
  });
});
