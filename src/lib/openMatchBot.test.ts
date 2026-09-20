import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Підбір гри в чаті. Перевіряється те, через що фіча зіпсувала б враження
 * мовчки: показана гра, до якої не долізти (зібрана, чужого рівня, вчора),
 * і мультиклуб — рівень гравця в одному клубі не має вирішувати за інший.
 */

const prisma = {
  customer: { findMany: vi.fn() },
  booking: { findMany: vi.fn() },
};
const sendMessage = vi.fn();

vi.mock('./db', () => ({ prisma }));
vi.mock('./telegram', () => ({ sendMessage }));

const { matchesForChat, sendMatches } = await import('./openMatchBot');

const NOW = new Date('2030-01-01T10:00:00Z');
const club = { name: 'Squash Arena', slug: 'squash-arena', timezone: 'Europe/Kyiv' };

const match = (o: Record<string, unknown> = {}) => ({
  id: 'm1',
  clubId: 'club',
  title: 'Відкрита гра',
  startTime: new Date('2030-01-02T17:00:00Z'),
  endTime: new Date('2030-01-02T18:00:00Z'),
  capacity: 4,
  pricePerSeat: 20_000,
  levelMin: 'C',
  levelMax: 'C_PLUS',
  court: { name: 'Корт 1' },
  club,
  seats: [{ id: 's1' }],
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  /* Справжній sendMessage віддає проміс — код чіпляє до нього .catch. */
  sendMessage.mockResolvedValue(undefined);
  prisma.customer.findMany.mockResolvedValue([{ clubId: 'club', skillLevel: 'C' }]);
  prisma.booking.findMany.mockResolvedValue([match()]);
});

describe('які ігри бачить гравець', () => {
  it('свій рівень і вільні місця — показуємо', async () => {
    const found = await matchesForChat('chat', NOW);
    expect(found.map((m) => m.id)).toEqual(['m1']);
  });

  it('зібрана гра не показується: кнопка вела б у «місць немає»', async () => {
    prisma.booking.findMany.mockResolvedValue([match({ seats: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }] })]);
    expect(await matchesForChat('chat', NOW)).toEqual([]);
  });

  it('чужий рівень не показується', async () => {
    prisma.booking.findMany.mockResolvedValue([match({ levelMin: 'B_PLUS', levelMax: 'B_PLUS' })]);
    expect(await matchesForChat('chat', NOW)).toEqual([]);
  });

  it('гра без рівня відкрита всім', async () => {
    prisma.booking.findMany.mockResolvedValue([match({ levelMin: null, levelMax: null })]);
    expect(await matchesForChat('chat', NOW)).toHaveLength(1);
  });

  it('гравець без рівня бачить ігри: порожня картка — не привід ховати клуб', async () => {
    prisma.customer.findMany.mockResolvedValue([{ clubId: 'club', skillLevel: null }]);
    expect(await matchesForChat('chat', NOW)).toHaveLength(1);
  });

  it('чат без карток не отримує нічого — і бази ми при цьому не питаємо', async () => {
    prisma.customer.findMany.mockResolvedValue([]);
    expect(await matchesForChat('chat', NOW)).toEqual([]);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it('мультиклуб: рівень береться того клубу, чия це гра', async () => {
    prisma.customer.findMany.mockResolvedValue([
      { clubId: 'club', skillLevel: 'B_PLUS' },
      { clubId: 'other', skillLevel: 'C' },
    ]);
    prisma.booking.findMany.mockResolvedValue([
      match({ id: 'home', clubId: 'club' }),
      match({ id: 'away', clubId: 'other' }),
    ]);

    /* Гра клубу «club» на C–C+ гравцю рівня B+ не підходить, гра «other» — так. */
    const found = await matchesForChat('chat', NOW);
    expect(found.map((m) => m.id)).toEqual(['away']);
  });

  it('питає лише майбутні ігри своїх клубів', async () => {
    await matchesForChat('chat', NOW);
    const where = prisma.booking.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ isOpenMatch: true, clubId: { in: ['club'] } });
    expect(where.startTime.gt).toEqual(NOW);
  });
});

describe('що приходить у чат', () => {
  it('кожна гра окремим повідомленням — щоб кнопка вела саме до неї', async () => {
    prisma.booking.findMany.mockResolvedValue([match({ id: 'a' }), match({ id: 'b' })]);
    const n = await sendMatches('chat', NOW);

    expect(n).toBe(2);
    /* Заголовок + дві гри. */
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[1]![1]).toContain('Шукають ще 3');
    expect(sendMessage.mock.calls[1]![1]).toContain('C–C+');
  });

  it('порожньо — кажемо, що напишемо самі, а не лишаємо людину ні з чим', async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    const n = await sendMatches('chat', NOW);

    expect(n).toBe(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toContain('я напишу сам');
  });
});
