// Повертає онлайн-запис demo-club: billing блокував клуб (прострочено paidUntil/trial або isActive=false).
// Запуск: node scripts/fix-demo-club-online.cjs        — лише показати стан
//         node scripts/fix-demo-club-online.cjs fix    — виправити
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const where = { slug: 'demo-club' };
const select = { isActive: true, paidUntil: true, trialEndsAt: true };

(async () => {
  console.log('before', await p.club.findUnique({ where, select }));
  if (process.argv[2] === 'fix') {
    await p.club.update({ where, data: { isActive: true, paidUntil: new Date('2030-01-01') } });
    console.log('after ', await p.club.findUnique({ where, select }));
  }
  await p.$disconnect();
})();
