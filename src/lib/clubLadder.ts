import { prisma } from './db';
import type { LevelInput } from './playerLevel';

/**
 * Підсумки всіх гравців клубу — знаменник для внутрішнього рівня.
 *
 * Рівень міряється місцем серед своїх (див. playerLevel.ts), тому на
 * кожен показ профілю треба знати, як виглядає решта клубу. Це один
 * агрегат по двох таблицях, але викликається він з /customer/me — тобто
 * на кожне відкриття віджета залогіненим гравцем.
 *
 * ── Чому кеш ─────────────────────────────────────────────────────────────
 * Знаменник змінюється від однієї нової броні на тисячну частку, а гравець
 * оновлює сторінку по три рази підряд. П'ять хвилин несвіжості тут не
 * коштують нічого: рівень не та величина, яку дивляться в реальному часі.
 * Кеш у пам'яті процесу, а не в Redis, — рядків мало, і втратити їх при
 * перезапуску не шкода.
 *
 * ── Чому SQL, а не Prisma groupBy ────────────────────────────────────────
 * Потрібна сума ТРИВАЛОСТЕЙ (endTime - startTime), а groupBy вміє
 * підсумовувати тільки наявні колонки. Витягувати всі броні клубу в
 * пам'ять заради цього — гірше за один запит.
 */

type Row = { visits: number; hours: number; spent: number };

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; rows: Map<string, Row> }>();

/** Скинути кеш клубу. Для тестів і для випадку «клуб щойно почистили». */
export function forgetLadder(clubId?: string) {
  if (clubId) cache.delete(clubId);
  else cache.clear();
}

/**
 * Підсумки гравців клубу: `Map<customerId, {visits, hours, spent}>`.
 *
 * Рахуються ті самі відвідування, що й у картці гравця: підтверджена
 * бронь корту або зайняте місце в груповому занятті, яке вже відбулось.
 * Скасовані й майбутні не рахуються — рівень має стояти на тому, що
 * справді сталось.
 */
export async function clubLadder(clubId: string, now = new Date()): Promise<Map<string, Row>> {
  const hit = cache.get(clubId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;

  const raw = await prisma.$queryRaw<
    { customerId: string; visits: bigint; hours: number; spent: bigint }[]
  >`
    SELECT "customerId",
           COUNT(*) AS visits,
           COALESCE(SUM(EXTRACT(EPOCH FROM ("endTime" - "startTime")) / 3600), 0)::float8 AS hours,
           COALESCE(SUM(price), 0) AS spent
      FROM (
        SELECT b."customerId", b."startTime", b."endTime", b."priceTotal" AS price
          FROM "Booking" b
         WHERE b."clubId" = ${clubId}::uuid
           AND b."status" = 'CONFIRMED'
           AND b."startTime" <= ${now}
           AND b."customerId" IS NOT NULL
        UNION ALL
        SELECT s."customerId", b."startTime", b."endTime", s."price"
          FROM "BookingSeat" s
          JOIN "Booking" b ON b."id" = s."bookingId"
         WHERE b."clubId" = ${clubId}::uuid
           AND s."status" = 'BOOKED'
           AND b."status" = 'CONFIRMED'
           AND b."startTime" <= ${now}
           AND s."customerId" IS NOT NULL
      ) v
     GROUP BY "customerId"
  `;

  /* COUNT і SUM(int) приїжджають із Postgres як bigint — у JSON такий не
     серіалізується взагалі, а в арифметиці з number кидає TypeError. */
  const rows = new Map<string, Row>(
    raw.map((r) => [r.customerId, {
      visits: Number(r.visits),
      hours: Math.round(Number(r.hours) * 10) / 10,
      spent: Number(r.spent),
    }]),
  );

  cache.set(clubId, { at: Date.now(), rows });
  return rows;
}

/**
 * Список для playerLevel: усі гравці клубу, і серед них — обов'язково сам
 * гравець. Він може бути відсутнім у кеші (перше заняття щойно відбулось,
 * а знаменник ще з минулих п'яти хвилин), і без цієї підстановки його
 * порівнювали б з клубом, у якому його немає.
 */
export function ladderWithMe(
  rows: Map<string, Row>,
  customerId: string,
  me: LevelInput,
): LevelInput[] {
  const all = [...rows.entries()]
    .filter(([id]) => id !== customerId)
    .map(([, r]) => r as LevelInput);
  return [...all, me];
}
