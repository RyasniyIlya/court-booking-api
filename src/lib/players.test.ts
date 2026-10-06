import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { linkCustomerPlayer } from './players';

function fixture() {
  const players = new Map<string, { id: string; phone: string; name: string }>();
  const customers = new Map([
    ['a', { id: 'a', clubId: 'club-a', phone: '0671234567', name: 'First name', playerId: null as string | null }],
    ['b', { id: 'b', clubId: 'club-b', phone: '+380671234567', name: 'Other name', playerId: null as string | null }],
  ]);
  const ratings = new Set<string>();
  const db = {
    customer: {
      findFirstOrThrow: vi.fn(async ({ where }: any) => {
        const customer = customers.get(where.id);
        if (!customer || customer.clubId !== where.clubId) throw new Error('CUSTOMER_NOT_FOUND');
        return { ...customer };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = customers.get(where.id)!;
        if (row.clubId !== where.clubId || row.phone !== where.phone || row.playerId !== where.playerId) return { count: 0 };
        row.playerId = data.playerId;
        return { count: 1 };
      }),
    },
    player: {
      upsert: vi.fn(async ({ where, create }: any) => {
        if (!players.has(where.phone)) players.set(where.phone, { id: `player-${players.size}`, ...create });
        return players.get(where.phone)!;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => [...players.values()].find((p) => p.id === where.id)!),
    },
    clubPlayerRating: {
      upsert: vi.fn(async ({ create }: any) => { ratings.add(`${create.clubId}/${create.playerId}`); }),
    },
  };
  return { db, tx: db as unknown as Prisma.TransactionClient, players, customers, ratings };
}

describe('platform player linking', () => {
  it('links differently formatted numbers across clubs to one player, preserving the first name', async () => {
    const f = fixture();
    const a = await linkCustomerPlayer(f.tx, 'a', 'club-a');
    const b = await linkCustomerPlayer(f.tx, 'b', 'club-b');
    expect(a.id).toBe(b.id);
    expect(b.name).toBe('First name');
    expect(f.players.size).toBe(1);
    expect(f.ratings.size).toBe(2);
    await linkCustomerPlayer(f.tx, 'a', 'club-a');
    expect(f.ratings.size).toBe(2);
  });
  it('rejects invalid numbers without creating identities', async () => {
    const f = fixture();
    f.customers.get('a')!.phone = 'invalid';
    await expect(linkCustomerPlayer(f.tx, 'a', 'club-a')).rejects.toThrow('PLAYER_PHONE_INVALID');
    expect(f.players.size).toBe(0);
  });
  it('does not silently move an existing profile when the club phone changes', async () => {
    const f = fixture();
    await linkCustomerPlayer(f.tx, 'a', 'club-a');
    f.customers.get('a')!.phone = '+380681234567';
    await expect(linkCustomerPlayer(f.tx, 'a', 'club-a')).rejects.toThrow('PLAYER_PHONE_CONFLICT');
  });
  it('rejects concurrent card edits so the enclosing transaction can roll back', async () => {
    const f = fixture();
    f.db.customer.updateMany.mockResolvedValue({ count: 0 });
    await expect(linkCustomerPlayer(f.tx, 'a', 'club-a')).rejects.toThrow('PLAYER_LINK_CONFLICT');
    expect(f.ratings.size).toBe(0);
  });
  it('cannot link a customer belonging to another club', async () => {
    const f = fixture();
    await expect(linkCustomerPlayer(f.tx, 'a', 'club-b')).rejects.toThrow('CUSTOMER_NOT_FOUND');
    expect(f.players.size).toBe(0);
  });
  it('also detects a concurrent edit when the card was already linked', async () => {
    const f = fixture();
    await linkCustomerPlayer(f.tx, 'a', 'club-a');
    f.db.customer.updateMany.mockResolvedValue({ count: 0 });
    await expect(linkCustomerPlayer(f.tx, 'a', 'club-a')).rejects.toThrow('PLAYER_LINK_CONFLICT');
  });
});
