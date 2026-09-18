import { describe, expect, it, vi } from 'vitest';
import { diffFields, moveChange, recordChanges } from './changeLog';

const actor = { userId: 'user-1', email: 'moder@club.test', role: 'ADMIN' };
const where = { clubId: 'club-1', entity: 'BOOKING', entityId: 'booking-1' };

describe('diffFields', () => {
  it('writes down only what actually changed', () => {
    const changes = diffFields(
      { comment: 'Мʼячі', trainerId: 't-1', priceTotal: 60000 },
      { comment: 'Свої мʼячі', trainerId: 't-1' },
      ['comment', 'trainerId', 'priceTotal'],
    );
    /* trainerId не змінився, priceTotal у patch не приходив узагалі. */
    expect(changes).toEqual([{ field: 'comment', before: 'Мʼячі', after: 'Свої мʼячі' }]);
  });

  it('does not treat null and undefined as a change', () => {
    /* Інакше зняття тренера писалось би двічі. */
    expect(diffFields({ trainerId: null }, { trainerId: undefined }, ['trainerId'])).toEqual([]);
    expect(diffFields({ comment: undefined }, { comment: null }, ['comment'])).toEqual([]);
  });

  it('records clearing a field as a real change', () => {
    expect(diffFields({ trainerId: 't-1' }, { trainerId: null }, ['trainerId']))
      .toEqual([{ field: 'trainerId', before: 't-1', after: null }]);
  });

  it('keeps dates readable instead of dumping a Date object', () => {
    const changes = diffFields(
      { startTime: new Date('2026-09-18T15:00:00.000Z') },
      { startTime: new Date('2026-09-18T16:00:00.000Z') },
      ['startTime'],
    );
    expect(changes[0]).toMatchObject({ after: '2026-09-18T16:00:00.000Z' });
  });

  it('sees equal dates as equal', () => {
    const at = '2026-09-18T15:00:00.000Z';
    expect(diffFields({ startTime: new Date(at) }, { startTime: new Date(at) }, ['startTime'])).toEqual([]);
  });
});

describe('moveChange', () => {
  const before = {
    courtId: 'court-1',
    courtName: 'Корт 1',
    startTime: new Date('2026-09-18T15:00:00.000Z'),
    endTime: new Date('2026-09-18T16:00:00.000Z'),
  };

  it('folds court and both times into one event', () => {
    /* Три рядки про один рух мишею читались би як три різні рішення. */
    const change = moveChange(before, { startTime: new Date('2026-09-18T17:00:00.000Z'), endTime: new Date('2026-09-18T18:00:00.000Z') });
    expect(change?.field).toBe('time');
    expect(change?.after).toMatchObject({ courtId: 'court-1', start: '2026-09-18T17:00:00.000Z' });
  });

  it('says nothing when the booking did not actually move', () => {
    expect(moveChange(before, { courtId: 'court-1' })).toBeNull();
    expect(moveChange(before, {})).toBeNull();
  });
});

describe('recordChanges', () => {
  it('does not touch the database when nothing changed', async () => {
    const db = { changeLog: { createMany: vi.fn() } };
    expect(await recordChanges(db, where, actor, [])).toBe(0);
    expect(db.changeLog.createMany).not.toHaveBeenCalled();
  });

  it('stamps every row with the person who did it', async () => {
    const db = { changeLog: { createMany: vi.fn(async () => ({})) } };
    await recordChanges(db, where, actor, [
      { field: 'comment', before: null, after: 'Свої мʼячі' },
      { field: 'title', before: 'Турнір', after: 'Осінній кубок' },
    ]);
    expect(db.changeLog.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ field: 'comment', actorEmail: 'moder@club.test', actorRole: 'ADMIN', entityId: 'booking-1' }),
        expect.objectContaining({ field: 'title', after: 'Осінній кубок' }),
      ],
    });
  });
});
