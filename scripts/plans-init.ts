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
 * Ціни — чинний прайс: «Броні» 1000, «Команда» 1500, «Аналітика» 2500 грн
 * на місяць. Впровадження не продаємо: підключення безкоштовне, уся виручка —
 * підписка. Базовий рівень збігається з PERIOD_PRICE.MONTH у lib/billing.ts.
 *
 * Уже створеним планам скрипт ціну не міняє (див. нижче) — якщо каталог
 * заводився зі старим прайсом, оновіть суми в платформенці руками.
 */
import { PrismaClient } from '@prisma/client';

export const PLANS = [
  {
    code: 'base',
    name: 'Броні',
    description: 'Онлайн-запис, сітка дня, картки клієнтів і абонементи. Telegram-бот з нагадуваннями й підтвердженням «приду», лист очікування.',
    price: 1_000_00,
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
    price: 1_500_00,
    tier: 2,
    sortOrder: 20,
    featTrainers: true,
    featGroups: true,
    featAnalytics: false,
  },
  {
    code: 'pro',
    name: 'Аналітика',
    description: 'Усе з «Команди» плюс Pro-аналітика: попит по годинах, ефективність кортів, воронка записів, утримання й фінанси. Щоденне зведення й аналітика в Telegram, повернення клієнтів, ШІ-помічник / нейроаналітик.',
    price: 2_500_00,
    tier: 3,
    sortOrder: 30,
    featTrainers: true,
    featGroups: true,
    featAnalytics: true,
  },
] as const;

/** Створює/оновлює каталог планів. Експортовано для scripts/demo-stand-reset.ts. */
export async function initPlans(prisma: PrismaClient) {
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

if (require.main === module) {
  const prisma = new PrismaClient();
  initPlans(prisma)
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
