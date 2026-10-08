import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTtlCache } from './ttlCache';

describe('createTtlCache', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('у межах TTL викликає loader один раз', async () => {
    const c = createTtlCache<number>(1000, 10);
    const loader = vi.fn(async () => 1);
    expect(await c.get('a', loader)).toBe(1);
    vi.advanceTimersByTime(999);
    expect(await c.get('a', loader)).toBe(1);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('після TTL перезавантажує', async () => {
    const c = createTtlCache<number>(1000, 10);
    let n = 0;
    const loader = vi.fn(async () => ++n);
    expect(await c.get('a', loader)).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(await c.get('a', loader)).toBe(2);
  });

  it('паралельні промахи діляють один запит', async () => {
    const c = createTtlCache<number>(1000, 10);
    const loader = vi.fn(async () => 7);
    const [x, y] = await Promise.all([c.get('a', loader), c.get('a', loader)]);
    expect([x, y]).toEqual([7, 7]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('відхилення не кешується', async () => {
    const c = createTtlCache<number>(1000, 10);
    const bad = vi.fn(async () => { throw new Error('boom'); });
    await expect(c.get('a', bad)).rejects.toThrow('boom');
    const good = vi.fn(async () => 5);
    expect(await c.get('a', good)).toBe(5);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('null кешується', async () => {
    const c = createTtlCache<string | null>(1000, 10);
    const loader = vi.fn(async () => null);
    expect(await c.get('a', loader)).toBeNull();
    expect(await c.get('a', loader)).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('виштовхує найстаріший понад maxEntries', async () => {
    const c = createTtlCache<string>(1000, 2);
    const la = vi.fn(async () => 'a');
    await c.get('a', la);
    await c.get('b', async () => 'b');
    await c.get('c', async () => 'c');
    await c.get('a', la);
    expect(la).toHaveBeenCalledTimes(2);
  });
});
