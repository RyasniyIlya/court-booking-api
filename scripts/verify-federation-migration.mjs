import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// No .env, Prisma or sockets: this process only uses an in-memory database.
const db = await PGlite.create({ extensions: { btree_gist } });
try {
  const migrations = resolve(import.meta.dirname, '../prisma/migrations');
  for (const folder of readdirSync(migrations).filter((f) => /^\d/.test(f)).sort()) {
    await db.exec(readFileSync(resolve(migrations, folder, 'migration.sql'), 'utf8'));
  }
  const player = randomUUID();
  await db.query('INSERT INTO "Player" (id, phone, name, "updatedAt") VALUES ($1, $2, $3, NOW())', [player, '+380671234567', 'Test player']);
  const result = await db.query('SELECT "eloFederation", "federationMatchCount", "levelSource" FROM "Player" WHERE id = $1', [player]);
  assert.deepEqual(result.rows[0], { eloFederation: 1200, federationMatchCount: 0, levelSource: 'AUTO' });
  await assert.rejects(db.query('INSERT INTO "Player" (id, phone, name, "updatedAt") VALUES ($1, $2, $3, NOW())', [randomUUID(), '+380671234567', 'Duplicate']));
  await assert.rejects(db.query('INSERT INTO "Player" (id, phone, name, "updatedAt", "federationId") VALUES ($1, $2, $3, NOW(), $4)', [randomUUID(), '+380681234567', 'Invalid federation', randomUUID()]));
  const change = randomUUID();
  const insertChange = 'INSERT INTO "RatingChange" (id, "playerId", "ratingType", kind, "before", "after", "changedBy", reason, "idempotencyKey", "effectiveAt") VALUES ($1, $2, \'FEDERATION\', \'MANUAL\', 1200, 1250, \'operator\', \'test\', $3, NOW())';
  await db.query(insertChange, [change, player, 'test-change']);
  await assert.rejects(db.query(insertChange, [randomUUID(), player, 'test-change']));
  await assert.rejects(db.query('UPDATE "RatingChange" SET "after" = 999 WHERE id = $1', [change]));
  await assert.rejects(db.query('DELETE FROM "RatingChange" WHERE id = $1', [change]));
  await assert.rejects(db.query('DELETE FROM "Player" WHERE id = $1', [player]));
  // Minimal real booking + match: retention must not get stuck on rating history.
  const club = randomUUID(), court = randomUUID(), booking = randomUUID(), match = randomUUID();
  await db.query('INSERT INTO "Club" (id, name, slug, "updatedAt") VALUES ($1, $2, $3, NOW())', [club, 'Retention test', `retention-${club}`]);
  await db.query('INSERT INTO "Court" (id, "clubId", name, "pricePerHour") VALUES ($1, $2, $3, 100)', [court, club, 'Test court']);
  await db.query('INSERT INTO "Booking" (id, "clubId", "courtId", "startTime", "endTime", "customerName", "customerPhone", "cancelToken", "updatedAt") VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL \'1 hour\', $4, $5, $6, NOW())', [booking, club, court, 'Test', '+380671234567', randomUUID()]);
  await db.query('INSERT INTO "TournamentMatch" (id, "bookingId", "clubId", round, slot, "updatedAt") VALUES ($1, $2, $3, 1, 0, NOW())', [match, booking, club]);
  const auditedMatch = randomUUID();
  await db.query('INSERT INTO "RatingChange" (id, "playerId", "matchId", "matchRefId", "ratingType", kind, "before", "after", "changedBy", reason, "idempotencyKey", "effectiveAt") VALUES ($1, $2, $3, $3, \'FEDERATION\', \'MATCH\', 1200, 1212, \'system\', \'test match\', $4, NOW())', [auditedMatch, player, match, 'retained-match']);
  await assert.rejects(db.query('UPDATE "RatingChange" SET "matchRefId" = NULL, "after" = 999 WHERE id = $1', [auditedMatch]));
  await db.query('DELETE FROM "Booking" WHERE id = $1', [booking]);
  const retained = await db.query('SELECT "matchId", "matchRefId", "before", "after" FROM "RatingChange" WHERE id = $1', [auditedMatch]);
  assert.deepEqual(retained.rows[0], { matchId: match, matchRefId: null, before: 1200, after: 1212 });
  console.log('PASS: all migrations apply in memory; initial rating, unique phone, references, idempotency and append-only audit verified.');
} finally {
  await db.close();
}
