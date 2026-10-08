import { describe, it, expect } from 'vitest';
import { planFeatures, clubPrice, telegramAnalytics } from './plans';

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

const base = { tier: 1, featTrainers: false, featGroups: false, featAnalytics: false };
const team = { tier: 2, featTrainers: true, featGroups: true, featAnalytics: false };
const pro = { tier: 3, featTrainers: true, featGroups: true, featAnalytics: true };
describe('subscription packages', () => {
 it.each([null, undefined])('does not grant paid features without a package: %s', plan => {
 expect(planFeatures(plan)).toEqual({trainers:false, groups:false, analytics:false, telegram:false, ai:false});
 expect(telegramAnalytics(plan)).toBe(false);
 });
 it('base (tier 1) includes Telegram, but not trainers, groups, analytics or AI', () => {
 expect(planFeatures(base)).toEqual({trainers:false, groups:false, analytics:false, telegram:true, ai:false});
 expect(telegramAnalytics(base)).toBe(false);
 });
 it('team includes trainers, groups and Telegram, but not analytics or AI', () => {
 expect(planFeatures(team)).toEqual({trainers:true,groups:true,analytics:false,telegram:true,ai:false});
 expect(telegramAnalytics(team)).toBe(false);
 });
 it('maximum includes Telegram, analytics in Telegram and the AI manager', () => {
 expect(planFeatures(pro)).toEqual({trainers:true,groups:true,analytics:true,telegram:true,ai:true});
 expect(telegramAnalytics(pro)).toBe(true);
 });
 it('analytics on a custom lower tier does not grant AI', () => {
 const f = planFeatures({...base,featAnalytics:true});
 expect(f.telegram).toBe(true);
 expect(f.analytics).toBe(true);
 expect(f.ai).toBe(false);
 });
});

describe('clubPrice — множник за корти', () => {
  const plan = { price: 1000_00 };

  it('до трьох кортів ціна плану без змін', () => {
    expect(clubPrice(plan, null, 1)).toBe(1000_00);
    expect(clubPrice(plan, null, 3)).toBe(1000_00);
  });

  it('кортів не задано — те саме, що й раніше', () => {
    expect(clubPrice(plan, null, undefined)).toBe(1000_00);
    expect(clubPrice(plan, null, null)).toBe(1000_00);
  });

  it('7 кортів: 1000 грн -> 1700 грн', () => {
    expect(clubPrice(plan, null, 7)).toBe(1700_00);
  });

  it('індивідуальна ціна корти ігнорує', () => {
    expect(clubPrice(plan, 700_00, 7)).toBe(700_00);
    expect(clubPrice(plan, 0, 12)).toBe(0);
  });

  it('без плану й без своєї ціни ціни немає навіть із кортами', () => {
    expect(clubPrice(null, null, 7)).toBeNull();
  });
});
