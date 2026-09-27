/**
 * Добовий ліміт запитів до ШІ на клуб.
 *
 * Публічний чат відкритий будь-кому з інтернету, а кожен запит коштує
 * грошей клубу-платнику (і нам). Ліміт по IP тут не рятує: боти міняють
 * адреси, тож стеля потрібна на рівні клубу.
 *
 * Лічильник у памʼяті процесу: на одному інстансі він точний, після
 * рестарту чи на кількох інстансах — приблизний, і для захисту від
 * «спалили бюджет за ніч» цього достатньо. Коли інстансів стане більше —
 * переїде в таблицю без зміни інтерфейсу.
 */

const counters = new Map<string, number>();

/** true — запит дозволено й записано; false — стелю на сьогодні досягнуто. */
export function takeQuota(scope: string, clubId: string, limit: number, day = new Date().toISOString().slice(0, 10)): boolean {
  const key = `${scope}:${clubId}:${day}`;

  /* Вчорашні ключі прибираємо самі, щоб Map не ріс роками. */
  for (const k of counters.keys()) if (!k.endsWith(day)) counters.delete(k);

  const used = counters.get(key) ?? 0;
  if (used >= limit) return false;
  counters.set(key, used + 1);
  return true;
}

export const envLimit = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/** Тільки для тестів. */
export const resetQuota = () => counters.clear();
