import { randomUUID } from 'node:crypto';

/**
 * Турнірна сітка на вибування — чиста логіка без бази.
 *
 * Матч (round, slot) веде в (round+1, floor(slot/2)): сторону A чи B
 * задає slot % 2. Матч за 3-є місце — це round = останній, slot 1; туди
 * йдуть ті, хто програв півфінали. Роути лише читають/пишуть рядки, а всі
 * рішення («хто пройшов», «що скинути») приймає цей файл — так їх можна
 * перевірити юніт-тестами без Prisma.
 */

export type MatchStatus = 'PENDING' | 'SCHEDULED' | 'LIVE' | 'DONE' | 'WALKOVER' | 'RETIRED';
export type SetScore = { a: number; b: number };
export type Side = 'A' | 'B';

export type BracketMatch = {
  id: string;
  round: number;
  slot: number;
  entryAId: string | null;
  entryBId: string | null;
  sets: SetScore[];
  winnerEntryId: string | null;
  status: MatchStatus;
};

export const FINISHED_STATUSES: MatchStatus[] = ['DONE', 'WALKOVER', 'RETIRED'];

export const isFinished = (m: { status: MatchStatus }): boolean => FINISHED_STATUSES.includes(m.status);

/** Матч уже мав результат: зміна учасника означає, що гру треба переграти. */
export const isPlayed = (m: { status: MatchStatus; winnerEntryId: string | null }): boolean =>
  isFinished(m) || m.winnerEntryId != null;

/** Розмір сітки — найближчий степінь двійки ≥ n. */
export function bracketSize(n: number): number {
  let size = 2;
  while (size < n) size *= 2;
  return size;
}

export const roundCount = (n: number): number => Math.log2(bracketSize(n));

/**
 * Олімпійська розстановка: 1 проти N, 2 проти N-1, а сильні сіяні
 * зустрічаються якомога пізніше. [1,8,4,5,2,7,3,6] для 8.
 */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const next = order.length * 2;
    order = order.flatMap((x) => [x, next + 1 - x]);
  }
  return order;
}

/**
 * Згенерувати всі матчі за списком учасників у порядку посіву.
 * Bye дістаються верхнім сіяним і одразу проходять далі (DONE без рахунку).
 * Матч за 3-є місце — лише коли учасників щонайменше 4.
 */
export function buildBracket(
  entryIds: string[],
  thirdPlace: boolean,
  newId: () => string = randomUUID,
): BracketMatch[] {
  const n = entryIds.length;
  if (n < 2) throw new Error('TOO_FEW_ENTRIES');
  const size = bracketSize(n);
  const rounds = Math.log2(size);
  const order = seedOrder(size);
  const third = thirdPlace && n >= 4;

  const matches: BracketMatch[] = [];
  const blank = (round: number, slot: number): BracketMatch => ({
    id: newId(), round, slot, entryAId: null, entryBId: null,
    sets: [], winnerEntryId: null, status: 'PENDING',
  });
  for (let r = 1; r <= rounds; r++) {
    for (let s = 0; s < size / 2 ** r; s++) matches.push(blank(r, s));
  }
  if (third) matches.push(blank(rounds, 1));

  const at = (r: number, s: number) => matches.find((m) => m.round === r && m.slot === s)!;
  const seeded = (seed: number) => (seed <= n ? entryIds[seed - 1] : null);

  for (let s = 0; s < size / 2; s++) {
    const m = at(1, s);
    m.entryAId = seeded(order[s * 2]);
    m.entryBId = seeded(order[s * 2 + 1]);
    const real = m.entryAId ?? m.entryBId;
    if ((m.entryAId == null) !== (m.entryBId == null) && real) {
      // Bye: суперника немає, учасник проходить без гри.
      m.status = 'DONE';
      m.winnerEntryId = real;
      applyPatches(matches, planPropagation(matches, m.id, real, null, third).patches);
    }
  }
  return matches;
}

/** Переможець за сетами: більше виграних сетів; рівність або порожньо — null. */
export function winnerBySets(sets: SetScore[]): Side | null {
  let a = 0;
  let b = 0;
  for (const s of sets) {
    if (s.a > s.b) a++;
    else if (s.b > s.a) b++;
  }
  if (a === b) return null;
  return a > b ? 'A' : 'B';
}

export type MatchPatch = {
  entryAId?: string | null;
  entryBId?: string | null;
  /** Прибрати результат: сети, переможець, статус PENDING. */
  reset?: boolean;
};

export type Propagation = {
  patches: Array<{ id: string; patch: MatchPatch }>;
  /** Матчі, що вже мали результат і через зміну учасника скидаються. */
  played: string[];
};

/**
 * Що станеться з іншими матчами, якщо в `sourceId` тепер такі переможець
 * і програвший. Нічого не пише — повертає патчі й список «уже зіграних».
 * Скидання каскадне: скинутий матч більше нікого далі не проводить.
 */
export function planPropagation(
  matches: BracketMatch[],
  sourceId: string,
  winnerId: string | null,
  loserId: string | null,
  thirdPlace: boolean,
): Propagation {
  const rounds = Math.max(...matches.map((m) => m.round));
  const work = new Map(matches.map((m) => [m.id, { ...m }]));
  const patches = new Map<string, MatchPatch>();
  const played = new Set<string>();
  const find = (r: number, s: number) =>
    [...work.values()].find((m) => m.round === r && m.slot === s);

  const place = (target: BracketMatch | undefined, side: Side, entryId: string | null) => {
    if (!target) return;
    const key = side === 'A' ? 'entryAId' : 'entryBId';
    if (target[key] === entryId) return;
    const patch = patches.get(target.id) ?? {};
    patch[key] = entryId;
    target[key] = entryId;
    patches.set(target.id, patch);
    if (isPlayed(target)) {
      played.add(target.id);
      patch.reset = true;
      target.sets = [];
      target.winnerEntryId = null;
      target.status = 'PENDING';
      // Результат стерто — його переможець і програвший зникають далі.
      push(target, null, null);
    }
  };

  const push = (src: BracketMatch, win: string | null, lose: string | null) => {
    if (thirdPlace && src.round === rounds && src.slot === 1) return;
    const side: Side = src.slot % 2 === 0 ? 'A' : 'B';
    if (src.round < rounds) place(find(src.round + 1, Math.floor(src.slot / 2)), side, win);
    if (thirdPlace && rounds >= 2 && src.round === rounds - 1) place(find(rounds, 1), side, lose);
  };

  const source = work.get(sourceId);
  if (source) push(source, winnerId, loserId);

  return { patches: [...patches].map(([id, patch]) => ({ id, patch })), played: [...played] };
}

/** Застосувати патчі до масиву (для генерації й тестів). */
export function applyPatches(
  matches: BracketMatch[],
  patches: Array<{ id: string; patch: MatchPatch }>,
): void {
  for (const { id, patch } of patches) {
    const m = matches.find((x) => x.id === id);
    if (!m) continue;
    if ('entryAId' in patch) m.entryAId = patch.entryAId ?? null;
    if ('entryBId' in patch) m.entryBId = patch.entryBId ?? null;
    if (patch.reset) {
      m.sets = [];
      m.winnerEntryId = null;
      m.status = 'PENDING';
    }
  }
}

export type MatchInput = {
  sets?: SetScore[];
  winner?: Side | null;
  status?: MatchStatus;
};

export type MatchCurrent = {
  entryAId: string | null;
  entryBId: string | null;
  sets: SetScore[];
  winnerEntryId: string | null;
  status: MatchStatus;
};

export type MatchResolution =
  | { ok: true; sets: SetScore[]; status: MatchStatus; winnerEntryId: string | null }
  | { ok: false; error: 'MATCH_NOT_READY' | 'WINNER_REQUIRED' };

/**
 * Звести те, що прислали, у новий стан матчу: рахунок, статус, переможець.
 * Переможець, якого не передали, виводиться з сетів; WALKOVER/RETIRED
 * без явного переможця неможливі.
 */
export function resolveMatchUpdate(cur: MatchCurrent, input: MatchInput): MatchResolution {
  const sets = input.sets ?? cur.sets;
  const curSide: Side | null =
    cur.winnerEntryId && cur.winnerEntryId === cur.entryAId ? 'A'
      : cur.winnerEntryId && cur.winnerEntryId === cur.entryBId ? 'B' : null;
  const pick = (side: Side | null) =>
    side === 'A' ? cur.entryAId : side === 'B' ? cur.entryBId : null;
  const open = (s?: MatchStatus) => (s && !FINISHED_STATUSES.includes(s) ? s : undefined);
  const forced = input.status === 'WALKOVER' || input.status === 'RETIRED';
  const ready = cur.entryAId != null && cur.entryBId != null;

  let side: Side | null;
  let status: MatchStatus;

  if (forced) {
    side = input.winner ?? curSide;
    if (!side) return { ok: false, error: 'WINNER_REQUIRED' };
    status = input.status!;
  } else if (input.winner === null) {
    side = null;
    status = open(input.status) ?? 'PENDING';
  } else if (input.winner) {
    side = input.winner;
    status = 'DONE';
  } else if (input.status === 'DONE') {
    side = winnerBySets(sets) ?? curSide;
    if (!side) return { ok: false, error: 'WINNER_REQUIRED' };
    status = 'DONE';
  } else if (input.sets !== undefined) {
    side = winnerBySets(sets);
    status = side ? 'DONE' : (open(input.status) ?? (isFinished(cur) ? 'LIVE' : cur.status));
  } else if (input.status) {
    // Повернення в незавершений статус знімає й переможця.
    side = open(input.status) ? null : curSide;
    status = input.status;
  } else {
    side = curSide;
    status = cur.status;
  }

  if ((side || FINISHED_STATUSES.includes(status)) && !ready) {
    return { ok: false, error: 'MATCH_NOT_READY' };
  }
  return { ok: true, sets, status, winnerEntryId: pick(side) };
}

/** Назва раунду за кількістю раундів до кінця. */
export function roundName(round: number, rounds: number): string {
  const left = rounds - round;
  if (left === 0) return 'Фінал';
  if (left === 1) return 'Півфінал';
  if (left === 2) return 'Чвертьфінал';
  return `1/${2 ** left} фіналу`;
}

/**
 * Зняті учасники: якщо в незавершеному матчі один знятий, а суперник
 * відомий — матч стає WALKOVER на користь суперника, переможець іде далі.
 * Повторюємо, бо прохід може одразу поставити його проти іншого знятого.
 * Повертає лише ті матчі, що відрізняються від вхідних.
 */
export function sweepWalkovers(
  matches: BracketMatch[],
  withdrawn: Set<string>,
  thirdPlace: boolean,
): BracketMatch[] {
  const work = matches.map((m) => ({ ...m }));
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of [...work].sort((x, y) => x.round - y.round || x.slot - y.slot)) {
      if (isFinished(m) || !m.entryAId || !m.entryBId) continue;
      const aOut = withdrawn.has(m.entryAId);
      const bOut = withdrawn.has(m.entryBId);
      if (aOut === bOut) continue;
      const winner = aOut ? m.entryBId : m.entryAId;
      const loser = aOut ? m.entryAId : m.entryBId;
      m.status = 'WALKOVER';
      m.winnerEntryId = winner;
      applyPatches(work, planPropagation(work, m.id, winner, loser, thirdPlace).patches);
      changed = true;
    }
  }
  return work.filter((w) => {
    const o = matches.find((x) => x.id === w.id)!;
    return o.entryAId !== w.entryAId || o.entryBId !== w.entryBId
      || o.winnerEntryId !== w.winnerEntryId || o.status !== w.status;
  });
}
