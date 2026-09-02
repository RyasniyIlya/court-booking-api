import { describe, it, expect } from 'vitest';
import { playerLevel, type LevelInput } from './playerLevel';

/**
 * Рівень гравця. Найтонше тут — не формула, а запобіжники: у маленькому
 * клубі й у клубі, куди всі прийшли по разу, «випереджає 90% гравців»
 * дістається за один тиждень, і рівень перестає щось означати.
 */

const p = (visits: number, hours = visits, spent = visits * 30000): LevelInput =>
  ({ visits, hours, spent });

/** Клуб із n гравців, де кожен наступний активніший за попереднього */
const club = (n: number) => Array.from({ length: n }, (_, i) => p(i + 1));

describe('playerLevel', () => {
  it('перший візит — Новачок, хоч би клуб був порожній', () => {
    const me = p(1);
    expect(playerLevel(me, [me]).key).toBe('ROOKIE');
  });

  it('найактивніший у великому клубі — Легенда', () => {
    const me = p(60);
    const lv = playerLevel(me, [...club(20), me]);
    expect(lv.key).toBe('LEGEND');
    expect(lv.next).toBeNull();
    expect(lv.progress).toBe(1);
  });

  it('найслабший у клубі лишається Новачком', () => {
    const me = p(1);
    expect(playerLevel(me, [...club(20), me]).key).toBe('ROOKIE');
  });

  /* Головний запобіжник: у клубі з трьох людей верхнє місце нічого не
     доводить, і роздавати за нього Легенду не можна. */
  it('у малому клубі вище Аматора не піднімає', () => {
    const me = p(60);
    const lv = playerLevel(me, [p(1), p(2), me]);
    expect(lv.key).toBe('AMATEUR');
    expect(lv.players).toBe(3);
  });

  /* Другий запобіжник: у клубі, де всі прийшли по разу, друге заняття
     виводить у верхню третину — але Завсідник за два тижні це неправда. */
  it('балів досить, занять ні — рівень тримається на місці', () => {
    const me = p(4);
    const lv = playerLevel(me, [...Array.from({ length: 20 }, () => p(1)), me]);
    expect(lv.key).toBe('AMATEUR');
    expect(lv.needVisits).toBe(4); // до восьми занять Завсідника
  });

  it('скільки занять бракує — рахується від наступного рівня', () => {
    const me = p(2);
    const lv = playerLevel(me, [...club(20), me]);
    expect(lv.key).toBe('ROOKIE');
    expect(lv.next).toBe('Аматор');
    expect(lv.needVisits).toBe(1);
  });

  it('однакові гравці отримують однаковий рівень', () => {
    const all = [p(10), p(10), p(10), ...club(10)];
    const a = playerLevel(all[0], all);
    const b = playerLevel(all[1], all);
    expect(a.key).toBe(b.key);
    expect(a.score).toBe(b.score);
  });

  /* Ціна години в клубах різна, і абсолютний поріг «залишив 20 000» зробив
     би Легенду недосяжною там, де корт коштує вдвічі дешевше. */
  it('подорожчання клубу вдвічі не змінює нічий рівень', () => {
    const cheap = club(20);
    const dear = cheap.map((x) => ({ ...x, spent: x.spent * 2 }));
    expect(playerLevel(cheap[15], cheap).key).toBe(playerLevel(dear[15], dear).key);
  });

  it('прогрес лишається в межах 0..1', () => {
    for (const me of club(20)) {
      const lv = playerLevel(me, club(20));
      expect(lv.progress).toBeGreaterThanOrEqual(0);
      expect(lv.progress).toBeLessThanOrEqual(1);
    }
  });
});
