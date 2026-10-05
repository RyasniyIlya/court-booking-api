import { describe, expect, it } from 'vitest';
import {
  applyPatches, buildBracket, planPropagation, resolveMatchUpdate, roundName, seedOrder, winnerBySets,
} from './tournamentBracket';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);
let counter = 0;
const gen = () => `m${++counter}`;
const at = (ms: ReturnType<typeof buildBracket>, r: number, s: number) =>
  ms.find((m) => m.round === r && m.slot === s)!;

describe('seedOrder', () => {
  it('олімпійська розстановка', () => {
    expect(seedOrder(2)).toEqual([1, 2]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });
});

describe('buildBracket', () => {
  it('8 учасників: 7 матчів, 1 проти 8', () => {
    const ms = buildBracket(ids(8), false, gen);
    expect(ms).toHaveLength(7);
    expect(at(ms, 1, 0)).toMatchObject({ entryAId: 'e1', entryBId: 'e8' });
    expect(at(ms, 1, 1)).toMatchObject({ entryAId: 'e4', entryBId: 'e5' });
    expect(ms.every((m) => m.status === 'PENDING')).toBe(true);
  });

  it('5 учасників: bye верхнім сіяним проходять одразу', () => {
    const ms = buildBracket(ids(5), false, gen);
    const r1 = ms.filter((m) => m.round === 1);
    const byes = r1.filter((m) => m.status === 'DONE');
    expect(byes.map((m) => m.winnerEntryId).sort()).toEqual(['e1', 'e2', 'e3']);
    // e1 уже стоїть у півфіналі, чекаючи переможця 4 vs 5
    expect(at(ms, 2, 0).entryAId).toBe('e1');
    expect(at(ms, 2, 0).entryBId).toBeNull();
  });

  it('матч за 3-є місце: round = останній, slot 1', () => {
    const ms = buildBracket(ids(4), true, gen);
    expect(ms).toHaveLength(4);
    expect(at(ms, 2, 1)).toBeDefined();
  });

  it('для 3 учасників третє місце не створюється', () => {
    expect(buildBracket(ids(3), true, gen)).toHaveLength(3);
  });
});

describe('planPropagation', () => {
  it('переможець іде в наступний раунд, програвший півфіналу — за 3-є місце', () => {
    const ms = buildBracket(ids(4), true, gen);
    const semi = at(ms, 1, 0); // e1 vs e4
    const plan = planPropagation(ms, semi.id, 'e1', 'e4', true);
    applyPatches(ms, plan.patches);
    expect(at(ms, 2, 0).entryAId).toBe('e1');
    expect(at(ms, 2, 1).entryAId).toBe('e4');
    expect(plan.played).toEqual([]);
  });

  it('зміна переможця підміняє учасника, а зіграний наступний матч скидається', () => {
    const ms = buildBracket(ids(4), false, gen);
    const [s0, s1] = [at(ms, 1, 0), at(ms, 1, 1)];
    applyPatches(ms, planPropagation(ms, s0.id, 'e1', 'e4', false).patches);
    applyPatches(ms, planPropagation(ms, s1.id, 'e2', 'e3', false).patches);
    const final = at(ms, 2, 0);
    final.status = 'DONE';
    final.winnerEntryId = 'e1';
    const plan = planPropagation(ms, s0.id, 'e4', 'e1', false);
    expect(plan.played).toEqual([final.id]);
    applyPatches(ms, plan.patches);
    expect(final.entryAId).toBe('e4');
    expect(final.winnerEntryId).toBeNull();
    expect(final.status).toBe('PENDING');
  });

  it('те саме значення — без змін', () => {
    const ms = buildBracket(ids(4), false, gen);
    const s0 = at(ms, 1, 0);
    applyPatches(ms, planPropagation(ms, s0.id, 'e1', 'e4', false).patches);
    expect(planPropagation(ms, s0.id, 'e1', 'e4', false).patches).toEqual([]);
  });
});

describe('winnerBySets / resolveMatchUpdate', () => {
  it('рахує сети', () => {
    expect(winnerBySets([{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 10, b: 8 }])).toBe('A');
    expect(winnerBySets([{ a: 6, b: 4 }, { a: 3, b: 6 }])).toBeNull();
    expect(winnerBySets([])).toBeNull();
  });

  const cur = {
    entryAId: 'a', entryBId: 'b', sets: [], winnerEntryId: null, status: 'PENDING' as const,
  };

  it('виводить переможця зі сетів', () => {
    const r = resolveMatchUpdate(cur, { sets: [{ a: 6, b: 1 }, { a: 6, b: 2 }] });
    expect(r).toMatchObject({ ok: true, status: 'DONE', winnerEntryId: 'a' });
  });

  it('WALKOVER без переможця — помилка', () => {
    expect(resolveMatchUpdate(cur, { status: 'WALKOVER' })).toEqual({ ok: false, error: 'WINNER_REQUIRED' });
    expect(resolveMatchUpdate(cur, { status: 'WALKOVER', winner: 'B' }))
      .toMatchObject({ ok: true, status: 'WALKOVER', winnerEntryId: 'b' });
  });

  it('без обох учасників результат не приймається', () => {
    expect(resolveMatchUpdate({ ...cur, entryBId: null }, { winner: 'A' }))
      .toEqual({ ok: false, error: 'MATCH_NOT_READY' });
  });
});

describe('roundName', () => {
  it('називає раунди з кінця', () => {
    expect(roundName(3, 3)).toBe('Фінал');
    expect(roundName(2, 3)).toBe('Півфінал');
    expect(roundName(1, 3)).toBe('Чвертьфінал');
    expect(roundName(1, 4)).toBe('1/8 фіналу');
  });
});

describe('resolveMatchUpdate: статус DONE', () => {
  const cur = { entryAId: 'a', entryBId: 'b', sets: [], winnerEntryId: null, status: 'LIVE' as const };
  it('DONE без вирішального рахунку — потрібен переможець', () => {
    expect(resolveMatchUpdate(cur, { status: 'DONE', sets: [{ a: 6, b: 4 }, { a: 4, b: 6 }] }))
      .toEqual({ ok: false, error: 'WINNER_REQUIRED' });
  });
});
