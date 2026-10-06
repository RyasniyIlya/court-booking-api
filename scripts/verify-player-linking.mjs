import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { linkCustomerPlayer } from '../src/lib/players.ts';

const pg = await PGlite.create({ extensions: { btree_gist } });
const migrations = resolve(import.meta.dirname, '../prisma/migrations');
let socket, prisma;
try {
  for (const name of readdirSync(migrations).filter((f) => /^\d/.test(f)).sort()) {
    await pg.exec(readFileSync(resolve(migrations, name, 'migration.sql'), 'utf8'));
  }
  socket = new PGLiteSocketServer({ db: pg, host: '127.0.0.1', port: 54330 });
  await socket.start();
  const url = 'postgresql://postgres:postgres@127.0.0.1:54330/postgres?sslmode=disable&connection_limit=1&pgbouncer=true';
  const { PrismaClient } = await import('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url } } });
  const firstClub = await prisma.club.create({ data: { name: 'First test club', slug: 'first-test' } });
  const secondClub = await prisma.club.create({ data: { name: 'Second test club', slug: 'second-test' } });
  const first = await prisma.customer.create({ data: { clubId: firstClub.id, name: 'First player', phone: '0671234567', phoneTail: '1234567' } });
  const second = await prisma.customer.create({ data: { clubId: secondClub.id, name: 'Second player', phone: '+380671234567', phoneTail: '1234567' } });
  const link = (customer, club) => prisma.$transaction((tx) => linkCustomerPlayer(tx, customer.id, club.id));
  const a = await link(first, firstClub);
  const b = await link(second, secondClub);
  assert.equal(a.id, b.id);
  assert.equal(b.name, 'First player');
  assert.equal(a.phoneVerifiedAt, null);
  await link(first, firstClub);
  assert.equal(await prisma.player.count(), 1);
  assert.equal(await prisma.clubPlayerRating.count(), 2);
  await assert.rejects(link(first, secondClub));
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.customer.update({ where: { id: first.id }, data: { phone: '+380681234567', name: 'Must roll back' } });
    await linkCustomerPlayer(tx, first.id, firstClub.id);
  }), /PLAYER_PHONE_CONFLICT/);
  const unchanged = await prisma.customer.findUniqueOrThrow({ where: { id: first.id } });
  assert.equal(unchanged.phone, first.phone);
  assert.equal(unchanged.name, first.name);
  console.log('PASS: real Prisma transactions link cross-club phone formats, preserve names, remain unverified, isolate clubs and roll back conflicts.');
} finally {
  await prisma?.$disconnect();
  await socket?.stop();
  await pg.close();
}
