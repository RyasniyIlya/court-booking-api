import { describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';

/**
 * Межі періоду звіту, зокрема заданого руками.
 *
 * Готові «тиждень» і «місяць» рахувались від поточного моменту й іншими
 * бути не могли. Власний діапазон приходить від клієнта — отже, приходить
 * і перевернутим, і на двадцять років, і половинним. Кожен кейс нижче —
 * саме такий запит.
 */

vi.mock('../lib/db', () => ({ prisma: {} }));
vi.mock('./admin', () => ({
  requireAuth: vi.fn(),
  requireRole: () => vi.fn(),
  requireFeature: () => vi.fn(),
}));

const { periodBounds, deepOperationalWindow } = await import('./analytics');

const TZ = 'Europe/Kyiv';
const anchor = DateTime.fromISO('2026-09-12T12:00:00', { zone: TZ });

const custom = (from?: string, to?: string) =>
  periodBounds({ period: 'custom', from, to }, TZ, anchor);

const kyiv = (d: Date) => DateTime.fromJSDate(d).setZone(TZ).toISO({ suppressMilliseconds: false });

describe('власний період', () => {
  it('бере повні доби в таймзоні клубу, а не сервера', () => {
    const b = custom('2026-08-24', '2026-09-12')!;

    expect(kyiv(b.current.start)).toBe('2026-08-24T00:00:00.000+03:00');
    expect(kyiv(b.current.end)).toBe('2026-09-12T23:59:59.999+03:00');
  });

  /* Без цього «−12%» був би відсотком невідомо від чого. */
  it('порівнює з такою самою тривалістю безпосередньо перед періодом', () => {
    const b = custom('2026-09-01', '2026-09-10')!;
    const span = (x: { start: Date; end: Date }) => x.end.getTime() - x.start.getTime();

    expect(span(b.previous)).toBe(span(b.current));
    expect(b.previous.end.getTime()).toBe(b.current.start.getTime() - 1);
  });

  it('один день — це один день, а не нуль', () => {
    const b = custom('2026-09-12', '2026-09-12')!;

    expect(kyiv(b.current.start)).toBe('2026-09-12T00:00:00.000+03:00');
    expect(kyiv(b.current.end)).toBe('2026-09-12T23:59:59.999+03:00');
    expect(kyiv(b.previous.start)).toBe('2026-09-11T00:00:00.000+03:00');
  });

  it('перевернутий діапазон читати відмовляється', () => {
    expect(custom('2026-09-12', '2026-08-24')).toBeNull();
  });

  /* Без межі «з 2000-го по сьогодні» перетворюється на скан усієї таблиці
     броней заради одного числа. */
  it('задовгий діапазон відмовляється теж', () => {
    expect(custom('2000-01-01', '2026-09-12')).toBeNull();
    expect(custom('2025-09-13', '2026-09-12')).not.toBeNull();
  });

  it('половина діапазону — ще не діапазон', () => {
    expect(custom('2026-09-01', undefined)).toBeNull();
    expect(custom(undefined, '2026-09-01')).toBeNull();
    expect(custom()).toBeNull();
  });
});

describe('готові періоди не змінились', () => {
  it('тиждень рахується від понеділка поточного тижня', () => {
    const b = periodBounds({ period: 'week' }, TZ, anchor)!;

    expect(kyiv(b.current.start)).toBe('2026-09-07T00:00:00.000+03:00');
    expect(kyiv(b.previous.start)).toBe('2026-08-31T00:00:00.000+03:00');
  });

  it('місяць — від першого числа', () => {
    const b = periodBounds({ period: 'month' }, TZ, anchor)!;

    expect(kyiv(b.current.start)).toBe('2026-09-01T00:00:00.000+03:00');
    expect(kyiv(b.previous.start)).toBe('2026-08-01T00:00:00.000+03:00');
  });
});

describe('операційне вікно /deep', () => {
  it('custom дає вікно рівно з вибраних дат у таймзоні клубу', () => {
    const w = deepOperationalWindow({ period: 'custom', from: '2026-08-24', to: '2026-09-02' }, TZ, anchor)!;

    expect(kyiv(w.from)).toBe('2026-08-24T00:00:00.000+03:00');
    expect(kyiv(w.to)).toBe('2026-09-02T23:59:59.999+03:00');
  });

  it('custom без дат або перевернутий — null (400)', () => {
    expect(deepOperationalWindow({ period: 'custom' }, TZ, anchor)).toBeNull();
    expect(deepOperationalWindow({ period: 'custom', from: '2026-09-10', to: '2026-09-01' }, TZ, anchor)).toBeNull();
  });

  it('week і month — від початку періоду до зараз, як раніше', () => {
    const wk = deepOperationalWindow({ period: 'week' }, TZ, anchor)!;
    expect(kyiv(wk.from)).toBe('2026-09-07T00:00:00.000+03:00');
    expect(wk.to.getTime()).toBe(anchor.toMillis());

    const mo = deepOperationalWindow({ period: 'month' }, TZ, anchor)!;
    expect(kyiv(mo.from)).toBe('2026-09-01T00:00:00.000+03:00');
    expect(mo.to.getTime()).toBe(anchor.toMillis());
  });
});
