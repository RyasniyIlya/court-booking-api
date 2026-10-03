/**
 * «Виручка корту» (нарахування) — вартість наданої послуги корту.
 *
 * Booking.priceTotal лишається повною сумою для клієнта (каса, чек, борг):
 * у приватній броні в ній лежать ще й гроші тренера й прокату, а заняття з
 * абонемента несе повну ціну корту, хоча клієнт заплатив за нього
 * pass.price / pass.totalSessions. Звіти про виручку КОРТУ беруть значення
 * звідси; касовий код (ledger, зміна, чек) і далі читає priceTotal.
 *
 * Чиста функція, без бази й міграцій: усе виводиться з полів броні.
 */

export type ServiceValueBooking = {
  priceTotal: number;
  /** Скільки з priceTotal — прокат (знижка на нього не діє). */
  rentalTotal?: number | null;
  /** Робота тренера ДО знижки, як зафіксовано на момент броні. */
  trainerPrice?: number | null;
  /** Не null = груповий контейнер: його priceTotal вже без тренера. */
  capacity?: number | null;
  /** Знижка клієнта, яка діяла при броні. Невідома = 0. */
  discountPercent?: number | null;
};

export type PassSessionSource = {
  type?: string | null;
  price: number;
  totalSessions: number | null;
};

/** Вартість одного заняття пакета; null, якщо пакет не PACKAGE або дані невалідні. */
export function passSessionValue(pass: PassSessionSource): number | null {
  if (pass.type && pass.type !== 'PACKAGE') return null;
  if (!pass.totalSessions || pass.totalSessions <= 0) return null;
  if (!Number.isFinite(pass.price) || pass.price < 0) return null;
  return Math.round(pass.price / pass.totalSessions);
}

const clampInt = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/**
 * Вартість корту в копійках.
 *  - passValue (заняття списане з PACKAGE-абонемента) → pass.price / totalSessions;
 *  - груповий контейнер (capacity != null) → priceTotal без змін;
 *  - приватна: priceTotal − rentalTotal − частка тренера з тією ж знижкою
 *    (public.ts: round((корт+тренер)·(100−d)/100) + прокат);
 *  - поля відсутні (історичні рядки) → безпечно priceTotal, не менше 0.
 */
export function courtValueOf(b: ServiceValueBooking, passValue?: number | null): number {
  if (passValue != null) return Math.max(0, Math.round(passValue));
  const total = Number.isFinite(b.priceTotal) ? b.priceTotal : 0;
  if (b.capacity != null) return total;

  const rental = Math.max(0, b.rentalTotal ?? 0);
  const trainer = Math.max(0, b.trainerPrice ?? 0);
  if (!rental && !trainer) return total;

  const d = clampInt(b.discountPercent ?? 0, 0, 100);
  const trainerShare = Math.round(trainer * (100 - d) / 100);
  const withoutRental = Math.max(0, total - rental);
  return Math.max(0, withoutRental - trainerShare);
}

/** Мінімальний вигляд prisma-клієнта: лише потрібний запит. */
type PassUsageReader = {
  passUsage: {
    findMany: (args: {
      where: { bookingId: { in: string[] }; revertedAt: null };
      select: { bookingId: true; pass: { select: { type: true; price: true; totalSessions: true } } };
    }) => Promise<Array<{ bookingId: string | null; pass: PassSessionSource }>>;
  };
};

/**
 * bookingId → вартість заняття з абонемента для броней, списаних із PACKAGE.
 * Окремий запит, бо в Booking немає relation на PassUsage (і міграція не потрібна).
 */
export async function loadPassSessionValues(
  prisma: PassUsageReader,
  bookingIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(bookingIds)];
  for (let i = 0; i < ids.length; i += 5000) {
    const rows = await prisma.passUsage.findMany({
      where: { bookingId: { in: ids.slice(i, i + 5000) }, revertedAt: null },
      select: { bookingId: true, pass: { select: { type: true, price: true, totalSessions: true } } },
    });
    for (const r of rows) {
      const v = passSessionValue(r.pass);
      if (r.bookingId && v != null) out.set(r.bookingId, v);
    }
  }
  return out;
}

/** Зручна обгортка: вартість корту броні з урахуванням мапи абонементів. */
export const courtValueWith = (
  b: ServiceValueBooking & { id: string },
  passValues: Map<string, number>,
) => courtValueOf(b, passValues.get(b.id));
