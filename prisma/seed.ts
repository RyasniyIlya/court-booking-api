import 'dotenv/config';
import { prisma } from '../src/lib/db';
import { createClub } from '../src/lib/createClub';

/**
 * Демо-клуб для локальної розробки.
 *
 * Реальні клуби заводяться не тут, а через `npm run club:new` —
 * див. scripts/create-club.ts. Цей файл лишається тільки щоб підняти
 * порожню базу до стану, на якому можна клікати віджет.
 *
 * Пароль береться з DEMO_PASSWORD, за замовчуванням demo1234.
 * Ця учітка не має їхати на прод — вона з відомим паролем.
 */

const SLUG = 'squash-arena';
const EMAIL = 'owner@squash.local';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo1234';

async function main() {
  const existing = await prisma.club.findUnique({ where: { slug: SLUG } });
  if (existing) {
    console.log(`Демо-клуб "${SLUG}" уже є, нічого не роблю. Логін: ${EMAIL}`);
    return;
  }

  await createClub({
    name: 'Squash Arena',
    slug: SLUG,
    timezone: 'Europe/Kyiv',
    slotMinutes: 60,
    leadTimeMinutes: 60,
    horizonDays: 14,
    autoConfirm: true,
    weekday: { openMinute: 8 * 60, closeMinute: 22 * 60 },
    weekend: { openMinute: 9 * 60, closeMinute: 21 * 60 },
    courts: [
      { name: 'Корт 1', pricePerHour: 45000, sortOrder: 1 },
      { name: 'Корт 2', pricePerHour: 45000, sortOrder: 2 },
      { name: 'VIP корт', pricePerHour: 60000, sortOrder: 3 },
    ],
    ownerEmail: EMAIL,
    ownerPassword: PASSWORD,
  });

  console.log(`Демо-клуб створено: ${SLUG} | логін ${EMAIL} / ${PASSWORD}`);
  console.log('Це учітка для розробки. На проді заводьте клуб через npm run club:new.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
