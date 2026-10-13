/**
 * Вартовий скрипта повного скидання демо-стенду (scripts/demo-stand-reset.ts).
 *
 * Скидання робить DROP SCHEMA public CASCADE, тож проти прод-бази воно
 * знищило б усе. Запуск дозволено, лише якщо одночасно:
 *   1) DEMO_STAND === 'true';
 *   2) DEMO_RESET_CONFIRM дорівнює назві БД із DATABASE_URL (pathname без '/');
 *   3) назва БД містить "demo": Neon створює БД "neondb" у кожному проєкті, і збіг
 *      DEMO_RESET_CONFIRM=neondb нічого б не захищав від прод-бази з такою ж назвою;
 *   4) якщо задано DIRECT_URL — він веде в ту саму базу на тому ж хості (без "-pooler").
 * Функція чиста: не читає process.env сама й нічого не підключає.
 */

export type DemoStandGuardResult =
  | { ok: true; dbName: string; host: string }
  | { ok: false; reason: string };

/** Назва бази та хост із рядка підключення Postgres; невалідний рядок -> null. */
export function parseDatabaseUrl(raw: string | undefined): { dbName: string; host: string } | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    const dbName = decodeURIComponent(u.pathname.replace(/^\/+/, '').split('/')[0] ?? '');
    if (!dbName) return null;
    return { dbName, host: u.hostname };
  } catch {
    return null;
  }
}

/** ep-xxx-pooler.region.neon.tech -> ep-xxx.region.neon.tech: прямий і пулений хост однієї бази. */
const unpool = (host: string) => host.toLowerCase().replace(/-pooler(?=.)/, '');

export function checkDemoStandGuard(env: Record<string, string | undefined>): DemoStandGuardResult {
  if (env.DEMO_STAND !== 'true') {
    return { ok: false, reason: 'DEMO_STAND не дорівнює "true". Скидання працює лише на демо-стенді.' };
  }
  const parsed = parseDatabaseUrl(env.DATABASE_URL);
  if (!parsed) {
    return { ok: false, reason: 'DATABASE_URL не задано або це не рядок підключення Postgres із назвою бази.' };
  }
  // DIRECT_URL (якщо задано) мусить вести в ту саму базу: на ньому виконується DROP SCHEMA.
  if (env.DIRECT_URL) {
    const direct = parseDatabaseUrl(env.DIRECT_URL);
    if (!direct || direct.dbName !== parsed.dbName || unpool(direct.host) !== unpool(parsed.host)) {
      return { ok: false, reason: 'DIRECT_URL не вказує на ту саму базу й хост, що й DATABASE_URL (або це не рядок підключення Postgres).' };
    }
  }
  if (!/demo/i.test(parsed.dbName)) {
    return { ok: false, reason: 'Назва бази в DATABASE_URL не містить "demo". Демо-базу назвіть, наприклад, kort_demo (не "neondb" — така назва буває й у проді).' };
  }
  const confirm = (env.DEMO_RESET_CONFIRM ?? '').trim();
  if (!confirm) {
    return { ok: false, reason: 'DEMO_RESET_CONFIRM не задано. Він має дорівнювати назві демо-бази з DATABASE_URL.' };
  }
  if (confirm !== parsed.dbName) {
    return { ok: false, reason: 'DEMO_RESET_CONFIRM не збігається з назвою бази в DATABASE_URL. Нічого не змінено.' };
  }
  return { ok: true, dbName: parsed.dbName, host: parsed.host };
}
