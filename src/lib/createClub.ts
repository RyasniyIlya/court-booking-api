import { hashPassword } from './passwordHash';
import { prisma } from './db';

/**
 * Заведення нового клубу.
 *
 * Раніше це жило захардкодженим у prisma/seed.ts — під другий клуб довелося б
 * правити файл руками. Тепер логіка одна, а викликають її двоє: seed (демо-клуб)
 * і scripts/create-club.ts (реальне впровадження з CLI).
 */

export type NewCourt = {
  name: string;
  /** Копійки за годину. 450 грн -> 45000 */
  pricePerHour: number;
  sortOrder: number;
};

/** Хвилини від опівночі за локальним часом клубу: 08:00 -> 480 */
export type Window = { openMinute: number; closeMinute: number };

export type NewClubInput = {
  name: string;
  slug: string;
  timezone?: string;
  /** Для шапки віджета */
  phone?: string | null;
  address?: string | null;
  logoUrl?: string | null;
  slotMinutes?: number;
  leadTimeMinutes?: number;
  horizonDays?: number;
  autoConfirm?: boolean;
  /** Пн–Пт */
  weekday: Window;
  /** Сб–Нд */
  weekend: Window;
  courts: NewCourt[];
  ownerEmail: string;
  ownerPassword: string;
};

export class ClubExistsError extends Error {
  constructor(public slug: string) {
    super(`Клуб зі slug "${slug}" уже існує`);
    this.name = 'ClubExistsError';
  }
}

export class EmailTakenError extends Error {
  constructor(public email: string) {
    super(`Користувач ${email} уже існує`);
    this.name = 'EmailTakenError';
  }
}

export async function createClub(input: NewClubInput) {
  const slug = input.slug.trim().toLowerCase();
  const email = input.ownerEmail.trim().toLowerCase();

  if (await prisma.club.findUnique({ where: { slug } })) {
    throw new ClubExistsError(slug);
  }
  if (await prisma.user.findUnique({ where: { email } })) {
    throw new EmailTakenError(email);
  }

  const passwordHash = await hashPassword(input.ownerPassword, 10);

  // Клуб, години, корти і власник — однією транзакцією: напівзаведений клуб
  // гірший за незаведений, бо виглядає робочим.
  return prisma.$transaction(async (tx) => {
    const club = await tx.club.create({
      data: {
        name: input.name.trim(),
        slug,
        timezone: input.timezone ?? 'Europe/Kyiv',
        phone: input.phone ?? null,
        address: input.address ?? null,
        logoUrl: input.logoUrl ?? null,
        slotMinutes: input.slotMinutes ?? 60,
        // За замовчуванням вільний слот можна взяти аж до його початку.
        // Клуб, якому потрібен час на підготовку, усе ще задає запас у
        // налаштуваннях явно.
        leadTimeMinutes: input.leadTimeMinutes ?? 0,
        horizonDays: input.horizonDays ?? 14,
        autoConfirm: input.autoConfirm ?? true,
      },
    });

    // 0 = неділя ... 6 = субота
    await tx.clubHours.createMany({
      data: Array.from({ length: 7 }, (_, weekday) => {
        const w = weekday === 0 || weekday === 6 ? input.weekend : input.weekday;
        return {
          clubId: club.id,
          weekday,
          openMinute: w.openMinute,
          closeMinute: w.closeMinute,
        };
      }),
    });

    await tx.court.createMany({
      data: input.courts.map((c) => ({
        clubId: club.id,
        name: c.name,
        pricePerHour: c.pricePerHour,
        sortOrder: c.sortOrder,
      })),
    });

    const user = await tx.user.create({
      data: { clubId: club.id, email, passwordHash, role: 'OWNER' },
    });

    const courts = await tx.court.findMany({
      where: { clubId: club.id },
      orderBy: { sortOrder: 'asc' },
    });

    return { club, user, courts };
  });
}
