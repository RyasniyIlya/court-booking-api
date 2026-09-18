/**
 * Журнал змін: хто, коли і що саме переписав.
 *
 * Історія броні до цього файлу складалась тільки з подій, у яких є власна
 * мітка часу: створення, оплати, підтвердження, скасування. Усе інше —
 * тренер, замітка, назва турніру, ціна місця, перенесення — просто
 * перезаписувало колонку, і в картці лишалось поточне значення й ніколи
 * не лишалось «хто це поставив». Питають у клубі саме про друге.
 *
 * Пишемо ТІЛЬКИ реальні зміни. Рядок «замітка: з "" на ""» — це шум, який
 * за місяць зробить журнал нечитабельним, а разом із ним і ті рядки, що
 * справді щось означають.
 */

export type ChangeActor = {
  userId: string;
  email: string;
  role: string;
};

export type Change = {
  field: string;
  before: unknown;
  after: unknown;
};

/** Мінімальна частина Prisma, потрібна журналу: працює і в транзакції. */
type ChangeLogRow = {
  clubId: string; entity: string; entityId: string; field: string;
  before: never; after: never;
  actorId: string; actorEmail: string; actorRole: string;
};
type ChangeLogDb = {
  changeLog: { createMany: (args: { data: ChangeLogRow[] }) => Promise<unknown> };
};

const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  /* null і undefined — те саме «нічого». Інакше зняття тренера писалось би
     двічі: один раз як null → undefined, другий раз як справжня зміна. */
  if (a == null && b == null) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => same(item, b[i]));
  }
  return false;
};

/** Дата в журнал іде рядком: JSON однаково зведе її до рядка на читанні. */
const plain = (value: unknown): unknown => {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
};

/**
 * Різниця між тим, що було, і тим, що стало.
 *
 * `after` — це patch: у ньому лежать лише ті поля, які роут справді
 * збирався записати. Поле, якого в patch немає, не змінювалось, і питати
 * про нього `before` сенсу немає.
 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
): Change[] {
  const changes: Change[] = [];
  for (const field of fields) {
    if (!(field in after)) continue;
    if (same(before[field], after[field])) continue;
    changes.push({ field, before: plain(before[field]), after: plain(after[field]) });
  }
  return changes;
}

/**
 * Записати зміни.
 *
 * Нічого не змінилось — жодного запиту в базу: PATCH, який переслали тим
 * самим тілом удруге, не має лишати по собі рядок «нічого не сталось».
 */
export async function recordChanges(
  db: ChangeLogDb,
  where: { clubId: string; entity: string; entityId: string },
  actor: ChangeActor,
  changes: Change[],
): Promise<number> {
  if (changes.length === 0) return 0;
  await db.changeLog.createMany({
    data: changes.map((change) => ({
      clubId: where.clubId,
      entity: where.entity,
      entityId: where.entityId,
      field: change.field,
      before: change.before as never,
      after: change.after as never,
      actorId: actor.userId,
      actorEmail: actor.email,
      actorRole: actor.role,
    })),
  });
  return changes.length;
}

/**
 * Перенесення — одна подія, а не три.
 *
 * «Корт: 1 → 2», «початок: 18:00 → 19:00», «кінець: 19:00 → 20:00» — це
 * три рядки про один рух мишею. У журналі вони читаються як три різні
 * рішення, тому зводимо їх в одне поле `time`.
 */
export function moveChange(
  before: { courtId: string; startTime: Date; endTime: Date; courtName?: string },
  after: { courtId?: string; startTime?: Date; endTime?: Date; courtName?: string },
): Change | null {
  const courtId = after.courtId ?? before.courtId;
  const startTime = after.startTime ?? before.startTime;
  const endTime = after.endTime ?? before.endTime;

  if (courtId === before.courtId
    && startTime.getTime() === before.startTime.getTime()
    && endTime.getTime() === before.endTime.getTime()) {
    return null;
  }

  return {
    field: 'time',
    before: {
      courtId: before.courtId,
      courtName: before.courtName ?? null,
      start: before.startTime.toISOString(),
      end: before.endTime.toISOString(),
    },
    after: {
      courtId,
      courtName: after.courtName ?? before.courtName ?? null,
      start: startTime.toISOString(),
      end: endTime.toISOString(),
    },
  };
}
