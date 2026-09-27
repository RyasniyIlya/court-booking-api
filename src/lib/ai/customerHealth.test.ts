import { describe, expect, it } from 'vitest';
import { buildCustomerHealth } from './customerHealth';

const NOW = new Date('2026-09-23T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('buildCustomerHealth', () => {
  it('сегменти рахуються тим самим tierOf, що й картотека', () => {
    const customers = [
      { id: 'new', createdAt: daysAgo(5) },       // без візитів, недавно зареєстрований -> NEW
      { id: 'active', createdAt: daysAgo(400) },
      { id: 'fading', createdAt: daysAgo(400) },
      { id: 'lost', createdAt: daysAgo(400) },
    ];
    const allVisits = [
      ...Array.from({ length: 10 }, (_, i) => ({ customerId: 'active', at: daysAgo(i + 1), price: 10000 })),
      { customerId: 'fading', at: daysAgo(60), price: 10000 },
      { customerId: 'lost', at: daysAgo(200), price: 10000 },
    ];
    const s = buildCustomerHealth({ customers, allVisits }, NOW);
    expect(s.totalCustomers).toBe(4);
    expect(s.segments).toEqual({ NEW: 1, ACTIVE: 1, FADING: 1, LOST: 1 });
  });

  it('поверненець після довгої паузи не плутається з новачком (синтетична точка першого візиту)', () => {
    // Клієнт ходив рік тому (365 днів), потім пауза, і повернувся 5 днів тому.
    // Без синтетичної точки: у вікні retention (60 днів) видно лише останній візит -> "new".
    const customers = [{ id: 'returning', createdAt: daysAgo(400) }];
    const allVisits = [
      { customerId: 'returning', at: daysAgo(365), price: 5000 },
      { customerId: 'returning', at: daysAgo(5), price: 5000 },
    ];
    const s = buildCustomerHealth({ customers, allVisits }, NOW);
    expect(s.last30d.new).toBe(0);
    expect(s.last30d.reactivated).toBe(1);
    expect(s.last30d.active).toBe(1);
  });

  it('справжній новачок (перший візит у поточному вікні) рахується як new', () => {
    const customers = [{ id: 'fresh', createdAt: daysAgo(5) }];
    const allVisits = [{ customerId: 'fresh', at: daysAgo(5), price: 5000 }];
    const s = buildCustomerHealth({ customers, allVisits }, NOW);
    expect(s.last30d.new).toBe(1);
    expect(s.last30d.reactivated).toBe(0);
  });

  it('at-risk value — гроші тих, хто був у попередньому вікні (31-60 днів) і зник у поточному', () => {
    const customers = [
      { id: 'atrisk', createdAt: daysAgo(200) },
      { id: 'safe', createdAt: daysAgo(200) },
    ];
    const allVisits = [
      { customerId: 'atrisk', at: daysAgo(45), price: 30000 }, // тільки попереднє вікно -> at-risk
      { customerId: 'safe', at: daysAgo(45), price: 20000 },
      { customerId: 'safe', at: daysAgo(5), price: 20000 },    // і в поточному теж -> не at-risk
    ];
    const s = buildCustomerHealth({ customers, allVisits }, NOW);
    expect(s.last30d.atRisk).toBe(1);
    expect(s.atRiskValueUah).toBe(300); // 30000 коп -> 300 грн, гроші тільки atrisk
  });

  it('немає жодного PII-поля у виводі', () => {
    const s = buildCustomerHealth({ customers: [{ id: 'c1', createdAt: daysAgo(10) }], allVisits: [] }, NOW);
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/phone|телефон|email|name|\+380/i);
  });

  it('порожній клуб — нулі, а не помилка', () => {
    const s = buildCustomerHealth({ customers: [], allVisits: [] }, NOW);
    expect(s.totalCustomers).toBe(0);
    expect(s.last30d.retentionPct).toBeNull();
    expect(s.atRiskValueUah).toBe(0);
  });
});
