import { describe, it, expect } from 'vitest';

import { clubHealth, type ClubHealthInput } from './clubHealth';

const NOW = new Date('2026-09-29T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const daysAhead = (n: number) => daysAgo(-n);

/** Здоровий клуб, від якого тести відламують по одній речі */
const healthy: ClubHealthInput = {
  isActive: true,
  createdAt: daysAgo(200),
  paidUntil: daysAhead(60),
  trialEndsAt: null,
  bookings30: 100,
  bookingsPrev30: 90,
  onlineShare30: 0.8,
  lastBookingAt: daysAgo(1),
  lastStaffActivityAt: daysAgo(1),
  tgLinked: true,
  features: { onlinePayments: true, passes: true, trainers: true, promos: true, groups: true },
};

const make = (patch: Partial<ClubHealthInput>): ClubHealthInput => ({ ...healthy, ...patch });

describe('clubHealth', () => {
  it('усе добре — 100 балів, без причин', () => {
    expect(clubHealth(healthy, NOW)).toEqual({ score: 100, tone: 'ok', reasons: [] });
  });

  it('мертвий клуб: нема броней, прострочено, ніхто не заходить — bad з причинами', () => {
    const h = clubHealth(
      make({
        bookings30: 0,
        bookingsPrev30: 40,
        onlineShare30: null,
        lastBookingAt: daysAgo(20),
        lastStaffActivityAt: daysAgo(30),
        paidUntil: daysAgo(40),
        tgLinked: false,
        features: { onlinePayments: false, passes: false, trainers: false, promos: false, groups: false },
      }),
      NOW,
    );
    expect(h.tone).toBe('bad');
    expect(h.score).toBeLessThan(10);
    expect(h.reasons).toEqual(
      expect.arrayContaining([
        'оплата прострочена',
        'немає броней 14+ днів',
        'адміністратор не заходив 10+ днів',
      ]),
    );
  });

  it('свіжість останньої броні: 3д — повна вага, 7д — 2/3, 14д — 1/3, далі нуль', () => {
    const score = (d: number) => clubHealth(make({ lastBookingAt: daysAgo(d) }), NOW).score;
    expect(score(3)).toBe(100);
    expect(score(7)).toBe(100 - Math.round(25 / 3));
    expect(score(14)).toBe(100 - Math.round((25 * 2) / 3));
    expect(score(15)).toBe(75);
  });

  it('падіння броней на 40% дає причину з відсотком', () => {
    const h = clubHealth(make({ bookings30: 30, bookingsPrev30: 50 }), NOW);
    expect(h.reasons).toContain('броней на 40% менше, ніж місяць тому');
    expect(h.score).toBeLessThan(100);
  });

  it('дрібне коливання і малі числа причини не дають', () => {
    expect(clubHealth(make({ bookings30: 85, bookingsPrev30: 90 }), NOW).reasons).toEqual([]);
    expect(clubHealth(make({ bookings30: 0, bookingsPrev30: 3 }), NOW).reasons).toEqual([]);
  });

  it('онлайн-запис майже не використовують', () => {
    const h = clubHealth(make({ onlineShare30: 0.02 }), NOW);
    expect(h.reasons).toContain('онлайн-запис майже не використовують');
  });

  it('оплата: ok 20, due 15, пробний 15, ніколи не платив без пробного 10, grace 5, blocked 0', () => {
    const score = (patch: Partial<ClubHealthInput>) => clubHealth(make(patch), NOW).score;
    expect(score({})).toBe(100);
    expect(score({ paidUntil: daysAhead(5) })).toBe(95);
    expect(score({ paidUntil: null, trialEndsAt: daysAhead(30) })).toBe(95);
    expect(score({ paidUntil: null, trialEndsAt: null })).toBe(90);
    expect(score({ paidUntil: daysAgo(3) })).toBe(85);
    expect(score({ paidUntil: daysAgo(30) })).toBe(80);
  });

  it('оплата скоро спливає — причина з кількістю днів', () => {
    expect(clubHealth(make({ paidUntil: daysAhead(5) }), NOW).reasons).toContain(
      'оплата закінчується через 5 дн.',
    );
  });

  it('новий клуб: «онбординг» і використання не нижче половини ваги', () => {
    const h = clubHealth(
      make({
        createdAt: daysAgo(3),
        bookings30: 0,
        bookingsPrev30: 0,
        onlineShare30: null,
        lastBookingAt: null,
        lastStaffActivityAt: null,
        tgLinked: false,
        paidUntil: null,
        features: { onlinePayments: false, passes: false, trainers: false, promos: false, groups: false },
      }),
      NOW,
    );
    expect(h.reasons).toEqual(['онбординг']);
    // 20 (стеля використання) + 10 (не платив) = 30
    expect(h.score).toBe(30);
  });

  it('вимкнений клуб — завжди bad з причиною «вимкнено»', () => {
    const h = clubHealth(make({ isActive: false }), NOW);
    expect(h.tone).toBe('bad');
    expect(h.reasons[0]).toBe('вимкнено');
    expect(h.score).toBeLessThan(40);
  });

  it('межі тонів: 75 — ok, 60 — warn, 40 — ще warn, 35 — bad', () => {
    const h = (patch: Partial<ClubHealthInput>) => clubHealth(make(patch), NOW);
    expect(h({ lastBookingAt: daysAgo(15) })).toMatchObject({ score: 75, tone: 'ok' });
    expect(h({ lastBookingAt: daysAgo(30), lastStaffActivityAt: daysAgo(30) })).toMatchObject({ score: 60, tone: 'warn' });
    const dead = { lastBookingAt: daysAgo(30), lastStaffActivityAt: daysAgo(30), paidUntil: daysAgo(30) };
    expect(h(dead)).toMatchObject({ score: 40, tone: 'warn' });
    expect(h({ ...dead, tgLinked: false })).toMatchObject({ score: 35, tone: 'bad' });
  });
});
