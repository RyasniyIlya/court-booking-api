import { describe, it, expect } from 'vitest';
import { planFeatures, clubPrice } from './plans';

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
 it.each([null, undefined, base])('does not grant paid features without a paid package: %s', plan => {
 expect(planFeatures(plan)).toEqual({trainers:false, groups:false, analytics:false, telegram:false, ai:false});
 });
 it('team includes trainers and groups only', () => expect(planFeatures(team)).toEqual({trainers:true,groups:true,analytics:false,telegram:false,ai:false}));
 it('maximum includes Telegram and the AI manager', () => expect(planFeatures(pro)).toEqual({trainers:true,groups:true,analytics:true,telegram:true,ai:true}));
 it('analytics on a custom lower tier does not grant Telegram or AI', () => {
 const f = planFeatures({...base,featAnalytics:true});
 expect(f.telegram).toBe(false);
 expect(f.ai).toBe(false);
 });
});
