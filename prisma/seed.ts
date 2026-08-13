import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const club = await prisma.club.upsert({
    where: { slug: 'squash-arena' },
    update: {},
    create: {
      name: 'Squash Arena',
      slug: 'squash-arena',
      timezone: 'Europe/Kyiv',
      slotMinutes: 60,
      leadTimeMinutes: 60,
      horizonDays: 14,
      autoConfirm: true,
      trialEndsAt: new Date(Date.now() + 14 * 24 * 3600 * 1000),
    },
  });

  // Пн–Пт 08:00–22:00, Сб–Нд 09:00–21:00
  for (let weekday = 0; weekday <= 6; weekday++) {
    const weekend = weekday === 0 || weekday === 6;
    await prisma.clubHours.upsert({
      where: { clubId_weekday: { clubId: club.id, weekday } },
      update: {},
      create: {
        clubId: club.id,
        weekday,
        openMinute: weekend ? 9 * 60 : 8 * 60,
        closeMinute: weekend ? 21 * 60 : 22 * 60,
      },
    });
  }

  const existing = await prisma.court.count({ where: { clubId: club.id } });
  if (existing === 0) {
    await prisma.court.createMany({
      data: [
        { clubId: club.id, name: 'Корт 1', pricePerHour: 45000, sortOrder: 1 },
        { clubId: club.id, name: 'Корт 2', pricePerHour: 45000, sortOrder: 2 },
        { clubId: club.id, name: 'VIP корт', pricePerHour: 60000, sortOrder: 3 },
      ],
    });
  }

  await prisma.user.upsert({
    where: { email: 'owner@squash.local' },
    update: {},
    create: {
      clubId: club.id,
      email: 'owner@squash.local',
      passwordHash: await bcrypt.hash('demo1234', 10),
      role: 'OWNER',
    },
  });

  console.log('Seed ok. Клуб:', club.slug, '| логін: owner@squash.local / demo1234');
}

main().finally(() => prisma.$disconnect());
