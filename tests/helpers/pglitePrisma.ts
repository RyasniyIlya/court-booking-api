import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Справжній PostgreSQL у памʼяті (PGlite) з УСІМА міграціями проєкту, під
 * тонкою обгорткою, що має форму `prisma`: теговий `$queryRaw` і ті методи
 * моделей, які потрібні тестам. Локального Postgres у проєкті немає, тож це
 * єдиний спосіб перевірити справжній SQL (ON CONFLICT, ключі, FK) і заодно
 * що ручна міграція застосовується до решти схеми.
 *
 * Обмеження чесно: PGlite має одне зʼєднання й виконує запити по черзі, тож
 * це перевірка АТОМАРНОСТІ ОДНОГО ОПЕРАТОРА (чи не пропускає він понад ліміт),
 * а не гонки між зʼєднаннями — вона на проді гарантується семантикою
 * INSERT … ON CONFLICT DO UPDATE у PostgreSQL.
 */
export async function pglitePrisma() {
  const db = await PGlite.create({ extensions: { btree_gist } });
  const migrations = resolve(import.meta.dirname, '../../prisma/migrations');
  for (const folder of readdirSync(migrations).filter((f) => /^\d/.test(f)).sort()) {
    await db.exec(readFileSync(resolve(migrations, folder, 'migration.sql'), 'utf8'));
  }

  /* Теговий шаблон → нумеровані параметри $1…$n, як це робить Prisma. */
  const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, part, i) => acc + (i === 0 ? '' : `$${i}`) + part, '');
    return (await db.query(text, values)).rows as any[];
  };

  const prisma = {
    $queryRaw: run,
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce((acc, part, i) => acc + (i === 0 ? '' : `$${i}`) + part, '');
      return (await db.query(text, values)).affectedRows ?? 0;
    },
    aiUsage: {
      deleteMany: async ({ where }: { where: { day: { lt: string } } }) => {
        const res = await db.query('DELETE FROM "AiUsage" WHERE "day" < $1', [where.day.lt]);
        return { count: res.affectedRows ?? 0 };
      },
    },
  };

  /** Мінімальний клуб: AiUsage/AiChatTurn мають FK на Club. */
  const makeClub = async (id: string) => {
    await db.query('INSERT INTO "Club" (id, name, slug, "updatedAt") VALUES ($1, $2, $3, NOW())', [id, 'Test', `test-${id}`]);
  };

  return { db, prisma, makeClub };
}
