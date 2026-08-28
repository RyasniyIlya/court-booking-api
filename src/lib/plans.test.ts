import { describe, it, expect } from 'vitest';
import { planFeatures, clubPrice, ALL_FEATURES } from './plans';

/**
 * Правила плану обслуговування.
 *
 * Головне тут — перша група. Решта перевірок описує три рівні, а вона
 * захищає від зміни, після якої всі наявні клуби мовчки втратять половину
 * кабінету в мить деплою.
 */

const base = { featTrainers: false, featGroups: false, featAnalytics: false };
const team = { featTrainers: true, featGroups: true, featAnalytics: false };
const pro = { featTrainers: true, featGroups: true, featAnalytics: true };

describe('planFeatures — відсутність плану нічого не обмежує', () => {
  /*
   * Клуби, заведені до появи планів, мають planId = null. Якщо колись
   * захочеться прочитати null як «нульовий тариф», обидві ці перевірки
   * впадуть — і це саме те, чого від них треба.
   */
  it('null — усе відкрито', () => {
    expect(planFeatures(null)).toEqual(ALL_FEATURES);
  });

  it('undefined — теж усе відкрито', () => {
    expect(planFeatures(undefined)).toEqual(ALL_FEATURES);
  });

  it('усе відкрито означає саме всі три можливості', () => {
    expect(ALL_FEATURES).toEqual({ trainers: true, groups: true, analytics: true });
  });
});

describe('planFeatures — три рівні', () => {
  it('перший рівень: тільки броні й віджет', () => {
    expect(planFeatures(base)).toEqual({ trainers: false, groups: false, analytics: false });
  });

  it('другий рівень: тренери й групові, аналітики ще немає', () => {
    expect(planFeatures(team)).toEqual({ trainers: true, groups: true, analytics: false });
  });

  it('третій рівень: усе', () => {
    expect(planFeatures(pro)).toEqual(ALL_FEATURES);
  });

  /* Прапорці незалежні навмисно: рівень — це лише порядок у списку, а не
     ієрархія прав. Клубу можна продати аналітику без групових, не заводячи
     четвертий рівень між другим і третім. */
  it('можливості не залежать одна від одної', () => {
    const odd = { featTrainers: false, featGroups: false, featAnalytics: true };
    expect(planFeatures(odd)).toEqual({ trainers: false, groups: false, analytics: true });
  });
});

describe('clubPrice — індивідуальна ціна б’є ціну плану', () => {
  const plan = { price: 900_00 };

  it('без своєї ціни береться ціна плану', () => {
    expect(clubPrice(plan, null)).toBe(900_00);
  });

  it('своя ціна перекриває план', () => {
    expect(clubPrice(plan, 700_00)).toBe(700_00);
  });

  /*
   * Нуль — реальна домовленість (перший клуб у місті, безкоштовне
   * впровадження), а не «ціни немає». Якщо перевірку колись спростять до
   * `override || plan.price`, ця перевірка впаде.
   */
  it('нуль — це ціна, а не порожнеча', () => {
    expect(clubPrice(plan, 0)).toBe(0);
  });

  it('без плану і без своєї ціни — ціни немає', () => {
    expect(clubPrice(null, null)).toBeNull();
  });

  it('своя ціна працює навіть без плану', () => {
    expect(clubPrice(null, 500_00)).toBe(500_00);
  });
});
