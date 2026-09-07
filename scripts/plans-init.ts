/**
 * Стартовий каталог планів обслуговування.
 *
 *   npm run plans:init
 *
 * Запускається ОДИН раз при розгортанні. Далі плани редагуються в
 * платформенці — саме тому вони й лежать у таблиці, а не в коді: ціна
 * міняється після дзвінка, а не після деплою.
 *
 * Ідемпотентний: повторний запуск нічого не ламає й НЕ перетирає ціни,
 * які ви вже правили руками. Оновлюються тільки назва, опис і набір
 * функцій — те, що описує сам продукт; гроші лишаються ваші.
 *
 * Ціни тут — заглушки з поточного прайсу (500 грн/міс за базовий рівень,
 * як у lib/billing.ts). Другий і третій рівні поставлені «на око»:
 * виставте свої в платформенці перед першим продажем.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PLANS = [
  {
    code: 'base',
    name: 'Броні',
    description: 'Онлайн-запис, сітка дня, картки клієнтів і абонементи.',
    price: 500_00,
    tier: 1,
    sortOrder: 10,
    featTrainers: false,
    featGroups: false,
    featAnalytics: false,
  },
  {
    code: 'team',
    name: 'Команда',
    description: 'Усе з «Броней» плюс тренери, їхні ціни та групові заняття.',
    price: 900_00,
    tier: 2,
    sortOrder: 20,
    featTrainers: true,
    featGroups: true,
    featAnalytics: false,
  },
  {
    code: 'pro',
    name: 'Аналітика',
    description: 'Усе з «Команди» плюс Pro-аналітика: попит по годинах, ефективність кортів, воронка записів, утримання й фінанси. Telegram-бот: інформація клубу та розклад тренера.',
    price: 1_400_00,
    tier: 3,
    sortOrder: 30,
    featTrainers: true,
    featGroups: true,
    featAnalytics: true,
  },
] as const;

async function main() {
  for (const p of PLANS) {
    const { code, price, ...rest } = p;

    const existing = await prisma.plan.findUnique({ where: { code } });

    if (existing) {
      // Ціну й період не чіпаємо: їх міг змінити оператор, і скрипт не має
      // права мовчки повернути прайс до значень із коду.
      await prisma.plan.update({ where: { code }, data: rest });
      console.log(`оновлено: ${code} (ціна лишилась ${(existing.price / 100).toLocaleString('uk-UA')} грн)`);
    } else {
      await prisma.plan.create({ data: { code, price, ...rest } });
      console.log(`створено: ${code} — ${(price / 100).toLocaleString('uk-UA')} грн`);
    }
  }

  const withoutPlan = await prisma.club.count({ where: { planId: null } });
  console.log(
    `\nКлубів без плану: ${withoutPlan}. Їм доступні базові бронювання — ` +
      'план призначається вручну в платформенці після оплати.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
