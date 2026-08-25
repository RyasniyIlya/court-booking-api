import { describe, it, expect } from 'vitest';
import { playerStats, streakWeeks, type PlayerVisit } from './playerStats';

/**
 * Підсумок гравця. Найтонше тут — серія тижнів: її легко порахувати так,
 * що людина щопонеділка бачитиме нуль замість своїх пʼяти тижнів.
 */

const TZ = 'Europe/Kyiv';
/** Середа, 26 серпня 2026, 12:00 за Києвом */
const NOW = new Date('2026-08-26T09:00:00.000Z');

const visit = (iso: string, courtName: string | null = 'Корт 1', trainerName: string | null = null): PlayerVisit =>
  ({ start: new Date(iso), courtName, trainerName });

/** Той самий день тижня N тижнів тому */
const weeksAgo = (n: number) => new Date(NOW.getTime() - n * 7 * 86_400_000).toISOString();

describe('streakWeeks', () => {
  it('без візитів — нуль', () => {
    expect(streakWeeks([], TZ, NOW)).toBe(0);
  });

  it('був цього тижня — серія один', () => {
    expect(streakWeeks([visit(weeksAgo(0))], TZ, NOW)).toBe(1);
  });

  it('три тижні поспіль', () => {
    const v = [visit(weeksAgo(0)), visit(weeksAgo(1)), visit(weeksAgo(2))];
    expect(streakWeeks(v, TZ, NOW)).toBe(3);
  });

  it('кілька візитів на тиждень не роздувають серію', () => {
    const v = [
      visit(weeksAgo(0)), visit(weeksAgo(0)),
      visit(weeksAgo(1)), visit(weeksAgo(1)), visit(weeksAgo(1)),
    ];
    expect(streakWeeks(v, TZ, NOW)).toBe(2);
  });

  /* Головне правило: тиждень щойно почався — це ще не пропуск. */
  it('цього тижня ще не був, але минулого був — серія жива', () => {
    const v = [visit(weeksAgo(1)), visit(weeksAgo(2))];
    expect(streakWeeks(v, TZ, NOW)).toBe(2);
  });

  it('пропущений тиждень обриває серію', () => {
    // був цього і три тижні тому, але не тиждень і не два тому
    const v = [visit(weeksAgo(0)), visit(weeksAgo(3))];
    expect(streakWeeks(v, TZ, NOW)).toBe(1);
  });

  it('давні візити без свіжих не дають серії', () => {
    expect(streakWeeks([visit(weeksAgo(5))], TZ, NOW)).toBe(0);
  });

  it('тиждень рахується в таймзоні клубу, а не UTC', () => {
    /* Неділя 23 серпня, 23:30 за Києвом — це ще той самий тиждень
       (пн 17 – нд 23). В UTC це вже 20:30 тієї ж неділі, але якби ми
       рахували в іншій зоні, візит міг би поїхати в сусідній тиждень
       і розірвати серію на рівному місці. */
    const sundayLateKyiv = visit('2026-08-23T20:30:00.000Z');
    const thisWeek = visit('2026-08-25T09:00:00.000Z'); // вівторок
    expect(streakWeeks([sundayLateKyiv, thisWeek], TZ, NOW)).toBe(2);
  });
});

describe('playerStats', () => {
  it('порожня історія не ламається', () => {
    const s = playerStats([], TZ, NOW);
    expect(s).toEqual({
      visits: 0,
      favouriteCourt: null,
      favouriteTrainer: null,
      streakWeeks: 0,
      firstVisit: null,
      lastVisit: null,
    });
  });

  it('рахує тільки те, що вже відбулось', () => {
    const future = new Date(NOW.getTime() + 86_400_000).toISOString();
    const s = playerStats([visit(weeksAgo(1)), visit(future)], TZ, NOW);
    // Майбутній запис — ще не відвідування
    expect(s.visits).toBe(1);
  });

  it('улюблений корт — той, де грали найчастіше', () => {
    const s = playerStats([
      visit(weeksAgo(1), 'Корт 1'),
      visit(weeksAgo(2), 'Корт 2'),
      visit(weeksAgo(3), 'Корт 2'),
    ], TZ, NOW);
    expect(s.favouriteCourt).toEqual({ name: 'Корт 2', times: 2 });
  });

  it('улюблений тренер рахується окремо, заняття без тренера не заважають', () => {
    const s = playerStats([
      visit(weeksAgo(1), 'Корт 1', 'Марія'),
      visit(weeksAgo(2), 'Корт 1', null),
      visit(weeksAgo(3), 'Корт 1', 'Марія'),
    ], TZ, NOW);
    expect(s.favouriteTrainer).toEqual({ name: 'Марія', times: 2 });
  });

  it('грали без тренера — улюбленого немає, і це не помилка', () => {
    const s = playerStats([visit(weeksAgo(1), 'Корт 1', null)], TZ, NOW);
    expect(s.favouriteTrainer).toBeNull();
  });

  it('при рівності вибір стабільний, а не випадковий', () => {
    const v = [visit(weeksAgo(1), 'Корт 2'), visit(weeksAgo(2), 'Корт 1')];
    const a = playerStats(v, TZ, NOW).favouriteCourt;
    const b = playerStats([...v].reverse(), TZ, NOW).favouriteCourt;
    expect(a).toEqual(b);
  });

  it('перший і останній візит — крайні за часом, незалежно від порядку у вхідних', () => {
    const s = playerStats([
      visit(weeksAgo(1)), visit(weeksAgo(4)), visit(weeksAgo(2)),
    ], TZ, NOW);
    expect(s.firstVisit).toBe(weeksAgo(4));
    expect(s.lastVisit).toBe(weeksAgo(1));
  });
});
