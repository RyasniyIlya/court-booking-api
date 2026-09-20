import { describe, expect, it } from 'vitest';

import { buildCandidates } from './openMatchInvite';

/**
 * Звички гравця рахуються з того, що він справді робив, і саме вони
 * вирішують, кого клуб потурбує повідомленням. Найтонше місце — часовий
 * пояс: година візиту має бути клубною, інакше вечірній гравець у
 * київському клубі стає нічним, і підбір промахується на дві години.
 */

const KYIV = 'Europe/Kyiv';
const NOW = new Date('2026-09-20T12:00:00Z');

const people = [{ id: 'p1', name: 'Олег', skillLevel: 'C' as const }];

/* 19:00 за Києвом улітку — це 16:00 UTC. */
const visit = (iso: string, noShow = false) => ({ customerId: 'p1', start: new Date(iso), noShow });

describe('звички з історії візитів', () => {
  it('година рахується за часом клубу, а не UTC', () => {
    const [c] = buildCandidates(people, [visit('2026-09-01T16:00:00Z'), visit('2026-09-08T16:00:00Z')], KYIV, NOW);
    expect(c!.hours).toEqual([19]);
  });

  it('разовий візит звичкою не стає', () => {
    const [c] = buildCandidates(people, [visit('2026-09-01T16:00:00Z')], KYIV, NOW);
    expect(c!.hours).toEqual([]);
    expect(c!.visits).toBe(1);
  });

  it('день тижня рахується від неділі, як і всюди в коді', () => {
    /* 1 і 8 вересня 2026 — вівторки. */
    const [c] = buildCandidates(people, [visit('2026-09-01T16:00:00Z'), visit('2026-09-08T16:00:00Z')], KYIV, NOW);
    expect(c!.weekdays).toEqual([2]);
  });

  it('неділя — 0, а не 7', () => {
    /* 6 і 13 вересня 2026 — неділі. */
    const [c] = buildCandidates(people, [visit('2026-09-06T16:00:00Z'), visit('2026-09-13T16:00:00Z')], KYIV, NOW);
    expect(c!.weekdays).toEqual([0]);
  });

  it('рахує пропуски й давність останнього візиту', () => {
    const [c] = buildCandidates(
      people,
      [visit('2026-09-01T16:00:00Z', true), visit('2026-09-15T16:00:00Z')],
      KYIV,
      NOW,
    );
    expect(c!.noShows).toBe(1);
    /* 15-го о 19:00 і «зараз» 20-го о 15:00 — це чотири повні доби. */
    expect(c!.lastVisitDays).toBe(4);
  });

  it('гравець без історії лишається в списку: новачку теж нема з ким грати', () => {
    const [c] = buildCandidates(people, [], KYIV, NOW);
    expect(c).toMatchObject({ id: 'p1', visits: 0, lastVisitDays: null, hours: [], weekdays: [] });
  });
});
