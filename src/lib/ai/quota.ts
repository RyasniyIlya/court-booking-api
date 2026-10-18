import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';

import { prisma } from '../db';

/**
 * Добовий ліміт запитів до ШІ.
 *
 * Публічний чат відкритий будь-кому з інтернету, а кожен запит коштує
 * грошей клубу-платнику (і нам). Ліміт по IP тут не рятує: боти міняють
 * адреси, тож стеля потрібна на рівні клубу (а для бота — ще й на рівні
 * гравця: scope містить суб'єкта, напр. `bot:player:<customerId>`).
 *
 * ── Чому в базі ───────────────────────────────────────────────────────────
 * Раніше лічильник жив у памʼяті процесу: рестарт чи другий інстанс
 * обнуляли «добу», а Telegram-бот додав би до цього ще й потік запитів від
 * сотень гравців. Тепер це рядок AiUsage (клуб + ключ + доба клубу), а
 * приріст — один атомарний `INSERT … ON CONFLICT DO UPDATE … WHERE count < ліміт`:
 * два одночасні запити не можуть обидва взяти останнє місце, і окремого
 * «прочитати, а потім записати» (де вони могли б) немає.
 *
 * ── Доба ──────────────────────────────────────────────────────────────────
 * Межа доби — північ за часом КЛУБУ, а не сервера (UTC): інакше клуб у Києві
 * отримував би «нову добу» о 02:00–03:00 ночі і втрачав би ліміт серед дня.
 */

/** Запасна зона, якщо в клубу в базі зіпсований часовий пояс: платформа українська. */
const FALLBACK_TZ = 'Europe/Kyiv';

/** Доба клубу як 'yyyy-MM-dd'. Невідома зона не має валити виклик ІІ — беремо запасну. */
export function quotaDay(timezone: string = FALLBACK_TZ, now: Date = new Date()): string {
  let local = DateTime.fromJSDate(now).setZone(timezone);
  if (!local.isValid) local = DateTime.fromJSDate(now).setZone(FALLBACK_TZ);
  return local.toFormat('yyyy-MM-dd');
}

/**
 * true — запит дозволено й записано; false — стелю на сьогодні досягнуто.
 *
 * Збій бази = false (закрито): краще відмовити в платному виклику, ніж
 * лишити його без стелі, коли лічильник недоступний.
 */
export async function takeQuota(
  scope: string,
  clubId: string,
  limit: number,
  opts: { timezone?: string; now?: Date } = {},
): Promise<boolean> {
  /* Ліміт < 1 має означати «заборонено»: без цього перший INSERT (без WHERE) пропустив би один запит. */
  if (!Number.isFinite(limit) || limit < 1) return false;
  const day = quotaDay(opts.timezone, opts.now);
  const lim = Math.floor(limit);

  try {
    /* Перший запит доби вставляє рядок із count = 1; наступні піднімають його, але лише
       доки count < ліміт. Коли ліміт досягнуто, умова WHERE відкидає оновлення й RETURNING
       порожній — це і є «відмовлено». id генеруємо тут: у БД для нього немає default. */
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "AiUsage" ("id", "clubId", "scope", "day", "count")
      VALUES (${randomUUID()}::uuid, ${clubId}::uuid, ${scope}, ${day}, 1)
      ON CONFLICT ("clubId", "scope", "day")
      DO UPDATE SET "count" = "AiUsage"."count" + 1
      WHERE "AiUsage"."count" < ${lim}::int
      RETURNING "count"`;
    return rows.length === 1;
  } catch {
    console.error('[ai] quota check failed');
    return false;
  }
}

export const envLimit = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/** Скільки діб тримаємо рядки лічильників: для звітів і розбору інцидентів вистачає, а таблиця не росте. */
export const AI_USAGE_KEEP_DAYS = 35;

/**
 * Прибрати лічильники старші за AI_USAGE_KEEP_DAYS. День — рядок 'yyyy-MM-dd',
 * тож порівняння лексикографічне = хронологічне. Повертає кількість видалених.
 */
export async function purgeOldUsage(now: Date = new Date()): Promise<number> {
  const cutoff = DateTime.fromJSDate(now).setZone('utc').minus({ days: AI_USAGE_KEEP_DAYS }).toFormat('yyyy-MM-dd');
  const { count } = await prisma.aiUsage.deleteMany({ where: { day: { lt: cutoff } } });
  return count;
}
